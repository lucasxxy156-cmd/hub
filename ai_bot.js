const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '9147165788:AAHImsnkY3pbVXkNxv9v5CDXr8sW5C-4K3Q';
const GROQ_API_KEY = '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';
const GEMINI_API_KEY = 'AQ.Ab8RN6JFNxzuxGGF0Vaizc6KZhQqRNGDj_WUplxY4CJHy0o_OQ';

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GEMINI_MODEL = 'gemini-3.8-flash';

let lastUpdateId = 0;

// ยิงถาม Groq (Primary)
async function askGroq(userPrompt) {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: GROQ_MODEL,
        messages: [
            {
                role: 'system',
                content: 'คุณคือผู้ช่วย AI ส่วนตัวที่สุภาพ เป็นมิตร ฉลาดรอบรู้ ตอบภาษาไทยได้อย่างเป็นธรรมชาติ กระชับเข้าใจง่าย ช่วยตอบคำถามเรื่องชีวิตประจำวัน การเรียน สรุปเนื้อหา คำนวณ หรือให้คำแนะนำได้อย่างชัดเจน'
            },
            {
                role: 'user',
                content: userPrompt
            }
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

    return res.data.choices[0]?.message?.content;
}

// ยิงถาม Google Gemini (Fallback)
async function askGemini(userPrompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await axios.post(url, {
        contents: [
            {
                parts: [{ text: userPrompt }]
            }
        ],
        systemInstruction: {
            parts: [{ text: 'คุณคือผู้ช่วย AI ส่วนตัว ตอบภาษาไทยอย่างกระชับ ชัดเจน เป็นมิตร' }]
        }
    }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
    });

    return res.data.candidates[0]?.content?.parts[0]?.text;
}

// ระบบเลือก AI อัตโนมัติ (Groq ก่อน ถ้าล่มสลับไป Gemini)
async function askAI(userPrompt) {
    try {
        const reply = await askGroq(userPrompt);
        if (reply) return reply;
    } catch (err) {
        console.warn('[AI] Groq failed, switching to Gemini fallback...', err.response?.data?.error?.message || err.message);
    }

    try {
        const reply = await askGemini(userPrompt);
        if (reply) return reply;
    } catch (err) {
        console.error('[AI] Both Groq & Gemini failed:', err.response?.data?.error?.message || err.message);
    }

    return 'ขออภัยครับ ระบบ AI เกิดข้อขัดข้องชั่วคราว ลองพิมพ์ใหม่อีกครั้งนะครับ';
}

// ส่งข้อความกลับเข้า Telegram
async function replyTelegram(chatId, text) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: text
        });
    } catch (err) {
        console.error('[Telegram Send Error]', err.message);
    }
}

// ระบบดักฟังข้อความแชท Telegram (Long Polling)
async function startChatListener() {
    console.log('[AI Bot] Ready & Listening on Telegram (Groq + Gemini Fallback)!');

    while (true) {
        try {
            const res = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`, {
                timeout: 35000
            });

            const updates = res.data.result || [];
            for (const update of updates) {
                lastUpdateId = update.update_id;

                if (update.message && update.message.text) {
                    const chatId = update.message.chat.id;
                    const userText = update.message.text.trim();

                    if (userText === '/start') {
                        await replyTelegram(chatId, '⚡ สวัสดีครับ! ผมคือผู้ช่วย AI ส่วนตัวของคุณ\n\nพร้อมตอบทุกคำถาม ทั้งเรื่องเรียน ชีวิตประจำวัน หรือเรื่องทั่วไป พิมพ์คุยได้ตลอดเลยครับ!');
                        continue;
                    }

                    console.log(`[User]: ${userText}`);

                    // แสดงสถานะกำลังพิมพ์ (typing)
                    axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
                        chat_id: chatId,
                        action: 'typing'
                    }).catch(() => {});

                    const aiReply = await askAI(userText);
                    await replyTelegram(chatId, aiReply);
                    console.log('[AI Replied]: Sent successfully');
                }
            }
        } catch (err) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

module.exports = {
    startChatListener,
    askAI
};
