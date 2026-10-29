require('dotenv').config();
const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CAPTION_LIMIT = 1024; // ข้อจำกัดของ Telegram สำหรับ caption ใต้รูป
const SEND_GAP_MS = 1100;   // Telegram จำกัด ~1 ข้อความ/วินาที ต่อแชท

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Telegram parse_mode HTML ต้อง escape & < > (และ " ในแอตทริบิวต์) ไม่งั้นได้ 400 แล้วแจ้งเตือนหาย
function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

async function telegram(method, payload) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
    try {
        return await axios.post(url, payload, { timeout: 15000 });
    } catch (err) {
        // โดน rate limit: รอตามที่ Telegram บอกแล้วลองอีกครั้งเดียว
        const retryAfter = err.response?.data?.parameters?.retry_after;
        if (err.response?.status === 429 && retryAfter) {
            await sleep((retryAfter + 1) * 1000);
            return axios.post(url, payload, { timeout: 15000 });
        }
        throw err;
    }
}

function buildMessage(manga, changedSources = []) {
    const lines = [
        '⚡ <b>มังงะอัปเดตตอนใหม่!</b>',
        '',
        `📖 <b>${escapeHtml(manga.title || 'มังงะเรื่องใหม่')}</b>`,
        '',
        '🔗 <b>แหล่งอ่านที่อัปเดต:</b>'
    ];

    for (const s of manga.sources) {
        const mark = changedSources.includes(s.source) ? '🆕' : '▪️';
        lines.push(`${mark} <b>${escapeHtml(s.source)}</b>: ${escapeHtml(s.latestChapter)}`);
        if (isHttpUrl(s.url)) {
            lines.push(`   👉 <a href="${escapeHtml(s.url)}">กดอ่านที่นี่</a>`);
        }
    }
    return lines.join('\n');
}

async function send(manga, changedSources) {
    const title = manga.title || 'มังงะเรื่องใหม่';
    try {
        const message = buildMessage(manga, changedSources);

        // ลองส่งแบบมีรูปก่อน (ถ้า caption ไม่เกิน 1024) ถ้า Telegram ดึงรูปไม่ได้ให้ fallback เป็นข้อความ
        let sent = false;
        if (isHttpUrl(manga.cover) && message.length <= CAPTION_LIMIT) {
            try {
                await telegram('sendPhoto', {
                    chat_id: TELEGRAM_CHAT_ID,
                    photo: manga.cover,
                    caption: message,
                    parse_mode: 'HTML'
                });
                sent = true;
            } catch (imgErr) {
                console.warn('[Notifier] sendPhoto failed, falling back to text:',
                    imgErr.response?.data?.description || imgErr.message);
            }
        }

        if (!sent) {
            await telegram('sendMessage', {
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            });
        }

        console.log(`[Notifier] Telegram alert sent for: ${title}`);
    } catch (err) {
        console.error('[Notifier] Failed to send Telegram alert:', err.response?.data?.description || err.message);
    }
}

let warnedMissingConfig = false;
let queue = Promise.resolve();

/**
 * ส่งแจ้งเตือนมังงะตอนใหม่เข้า Telegram — เข้าคิวและส่งทีละเรื่อง เว้นช่วงกัน rate limit
 * @param {Object} manga - ข้อมูลมังงะที่มีตอนใหม่
 * @param {string[]} changedSources - ชื่อเว็บที่ตอนเพิ่งเปลี่ยน (ใช้ติดไอคอน 🆕)
 */
function notifyNewChapter(manga, changedSources = []) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        if (!warnedMissingConfig) {
            console.warn('[Notifier] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in .env — alerts disabled');
            warnedMissingConfig = true;
        }
        return Promise.resolve();
    }

    queue = queue.then(() => send(manga, changedSources)).then(() => sleep(SEND_GAP_MS));
    return queue;
}

module.exports = {
    notifyNewChapter,
    escapeHtml,
    buildMessage
};
