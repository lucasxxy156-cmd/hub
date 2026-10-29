require('dotenv').config();
const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // ตอบเฉพาะแชทนี้เท่านั้น
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const GROQ_SYSTEM_PROMPT = 'คุณคือผู้ช่วย AI ส่วนตัวที่สุภาพ เป็นมิตร ฉลาดรอบรู้ ตอบภาษาไทยได้อย่างเป็นธรรมชาติ กระชับเข้าใจง่าย ช่วยตอบคำถามเรื่องชีวิตประจำวัน การเรียน สรุปเนื้อหา คำนวณ หรือให้คำแนะนำได้อย่างชัดเจน';
const GEMINI_SYSTEM_PROMPT = 'คุณคือผู้ช่วย AI ส่วนตัว ตอบภาษาไทยอย่างกระชับ ชัดเจน เป็นมิตร';
const FALLBACK_REPLY = 'ขออภัยครับ ระบบ AI เกิดข้อขัดข้องชั่วคราว ลองพิมพ์ใหม่อีกครั้งนะครับ';

const MAX_HISTORY = 10;          // จำบริบทล่าสุดกี่ข้อความ (5 รอบถาม-ตอบ)
const TELEGRAM_MSG_LIMIT = 4000; // Telegram รับข้อความได้สูงสุด 4096 ตัวอักษร

let lastUpdateId = 0;
const histories = new Map(); // chatId -> [{ role: 'user' | 'assistant', content }]

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const errMsg = (err) => err.response?.data?.error?.message || err.response?.data?.description || err.message;

// -------------------------------------------------------------
// ประวัติแชท
// -------------------------------------------------------------
function getHistory(chatId) {
    return histories.get(chatId) || [];
}

function pushHistory(chatId, userText, assistantText) {
    const h = [...getHistory(chatId), { role: 'user', content: userText }, { role: 'assistant', content: assistantText }];
    histories.set(chatId, h.slice(-MAX_HISTORY));
}

// -------------------------------------------------------------
// ยิงถาม AI
// -------------------------------------------------------------

// Groq (Primary)
async function askGroq(userPrompt, history = []) {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: GROQ_MODEL,
        messages: [
            { role: 'system', content: GROQ_SYSTEM_PROMPT },
            ...history,
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 800
    }, {
        headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });

    return res.data.choices?.[0]?.message?.content;
}

// Google Gemini (Fallback) — ส่งคีย์ผ่าน header ไม่ใส่ใน URL เพื่อไม่ให้หลุดตาม log
async function askGemini(userPrompt, history = []) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const res = await axios.post(url, {
        contents: [
            ...history.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            })),
            { role: 'user', parts: [{ text: userPrompt }] }
        ],
        systemInstruction: {
            parts: [{ text: GEMINI_SYSTEM_PROMPT }]
        }
    }, {
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY
        },
        timeout: 15000
    });

    return res.data.candidates?.[0]?.content?.parts?.[0]?.text;
}

// เลือก AI อัตโนมัติ (Groq ก่อน ถ้าล่มสลับไป Gemini) — คืน null ถ้าล้มทั้งคู่
async function generateReply(userPrompt, history = []) {
    if (GROQ_API_KEY) {
        try {
            const reply = await askGroq(userPrompt, history);
            if (reply) return reply;
        } catch (err) {
            console.warn('[AI] Groq failed, switching to Gemini fallback...', errMsg(err));
        }
    }

    if (GEMINI_API_KEY) {
        try {
            const reply = await askGemini(userPrompt, history);
            if (reply) return reply;
        } catch (err) {
            console.error('[AI] Gemini failed:', errMsg(err));
        }
    }

    return null;
}

async function askAI(userPrompt, history = []) {
    return (await generateReply(userPrompt, history)) || FALLBACK_REPLY;
}

// -------------------------------------------------------------
// Telegram
// -------------------------------------------------------------

// แบ่งข้อความยาวเป็นท่อนๆ ตามบรรทัด ไม่ให้เกินลิมิตของ Telegram
function splitMessage(text, max = TELEGRAM_MSG_LIMIT) {
    if (text.length <= max) return [text];
    const chunks = [];
    let current = '';
    for (const line of text.split('\n')) {
        if ((current + '\n' + line).length > max && current) {
            chunks.push(current);
            current = '';
        }
        let rest = line;
        while (rest.length > max) {
            chunks.push(rest.slice(0, max));
            rest = rest.slice(max);
        }
        current = current ? current + '\n' + rest : rest;
    }
    if (current) chunks.push(current);
    return chunks;
}

async function replyTelegram(chatId, text) {
    for (const chunk of splitMessage(text)) {
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: chunk
            }, { timeout: 15000 });
        } catch (err) {
            console.error('[Telegram Send Error]', errMsg(err));
        }
    }
}

async function handleUpdate(update) {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const chatId = msg.chat.id;

    if (!ALLOWED_CHAT_ID) {
        console.warn(`[AI Bot] Ignored message from chat ${chatId} — set TELEGRAM_CHAT_ID in .env to enable replies`);
        return;
    }
    if (String(chatId) !== String(ALLOWED_CHAT_ID)) {
        console.warn(`[AI Bot] Ignored message from unauthorized chat ${chatId}`);
        return;
    }

    const userText = msg.text.trim();
    if (!userText) return;

    const command = userText.startsWith('/') ? userText.split(/[\s@]/)[0].toLowerCase() : null;

    if (command === '/start') {
        await replyTelegram(chatId, '⚡ สวัสดีครับ! ผมคือผู้ช่วย AI ส่วนตัวของคุณ\n\nพร้อมตอบทุกคำถาม ทั้งเรื่องเรียน ชีวิตประจำวัน หรือเรื่องทั่วไป พิมพ์คุยได้ตลอดเลยครับ!\n\nพิมพ์ /reset เพื่อเริ่มคุยหัวข้อใหม่');
        return;
    }
    if (command === '/reset') {
        histories.delete(chatId);
        await replyTelegram(chatId, '🧹 ล้างบริบทการคุยแล้วครับ เริ่มหัวข้อใหม่ได้เลย');
        return;
    }

    console.log(`[User]: ${userText}`);

    // แสดงสถานะกำลังพิมพ์ (typing)
    axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
        chat_id: chatId,
        action: 'typing'
    }).catch(() => {});

    const answer = await generateReply(userText, getHistory(chatId));
    if (answer) {
        pushHistory(chatId, userText, answer);
        await replyTelegram(chatId, answer);
        console.log('[AI Replied]: Sent successfully');
    } else {
        await replyTelegram(chatId, FALLBACK_REPLY);
    }
}

// ระบบดักฟังข้อความแชท Telegram (Long Polling)
async function startChatListener() {
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn('[AI Bot] TELEGRAM_BOT_TOKEN not set in .env — chat listener disabled');
        return;
    }
    if (!GROQ_API_KEY && !GEMINI_API_KEY) {
        console.warn('[AI Bot] No GROQ_API_KEY / GEMINI_API_KEY set — bot will only answer with the fallback message');
    }
    console.log('[AI Bot] Ready & Listening on Telegram (Groq + Gemini Fallback)!');

    let backoff = 2000;
    while (true) {
        try {
            const res = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, {
                params: {
                    offset: lastUpdateId + 1,
                    timeout: 30,
                    allowed_updates: JSON.stringify(['message'])
                },
                timeout: 35000
            });
            backoff = 2000;

            for (const update of res.data.result || []) {
                lastUpdateId = update.update_id;
                try {
                    await handleUpdate(update);
                } catch (err) {
                    console.error('[AI Bot] Error while handling message:', errMsg(err));
                }
            }
        } catch (err) {
            if (err.response?.status === 409) {
                console.error('[AI Bot] 409 Conflict: มีโปรแกรมอื่นกำลังดึงข้อความของบอทนี้อยู่ (รันซ้อน 2 ตัว?) — ปิดตัวอื่นก่อน');
            } else {
                console.error('[AI Bot] getUpdates failed:', errMsg(err));
            }
            await sleep(backoff);
            backoff = Math.min(backoff * 2, 30000);
        }
    }
}

module.exports = {
    startChatListener,
    askAI,
    splitMessage
};
