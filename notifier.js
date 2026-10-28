const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '9147165788:AAHImsnkY3pbVXkNxv9v5CDXr8sW5C-4K3Q';
const TELEGRAM_CHAT_ID = '5836868707';

/**
 * ส่งข้อความแจ้งเตือนมังงะตอนใหม่เข้า Telegram
 * @param {Object} manga - ข้อมูลมังงะที่มีตอนใหม่
 */
async function notifyNewChapter(manga) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    try {
        const title = manga.title || 'มังงะเรื่องใหม่';
        let message = `⚡ <b>มังงะอัปเดตตอนใหม่!</b>\n\n`;
        message += `📖 <b>${title}</b>\n\n`;
        message += `🔗 <b>แหล่งอ่านที่อัปเดต:</b>\n`;

        manga.sources.forEach(s => {
            message += `▪️ <b>${s.source}</b>: ${s.latestChapter}\n`;
            message += `   👉 <a href="${s.url}">กดอ่านที่นี่</a>\n`;
        });

        // พยายามส่งแบบรูปภาพก่อน ถ้า Telegram ดึงรูปจากเว็บต้นทางไม่ได้ ให้ fallback ส่งเป็นข้อความทันที
        let sent = false;
        if (manga.cover && manga.cover.startsWith('http')) {
            try {
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    photo: manga.cover,
                    caption: message,
                    parse_mode: 'HTML'
                });
                sent = true;
            } catch (imgErr) {
                console.warn(`[Notifier] Telegram cannot load image directly, falling back to text message...`);
            }
        }

        if (!sent) {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML',
                disable_web_page_preview: false
            });
        }

        console.log(`[Notifier] Telegram alert sent for: ${title}`);
    } catch (err) {
        console.error('[Notifier] Failed to send Telegram alert:', err.response?.data?.description || err.message);
    }
}

module.exports = {
    notifyNewChapter
};
