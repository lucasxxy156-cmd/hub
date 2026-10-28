const express = require('express');
const cors = require('cors');
const path = require('path');
const scrapers = require('./scrapers');
const notifier = require('./notifier');
const aiBot = require('./ai_bot');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory Cache เพื่อความเร็วสูงและไม่ยิงเว็บต้นทางถี่เกินไป
let cachedData = [];
let knownChaptersMap = new Map(); // จดจำเลขตอนล่าสุดของแต่ละเรื่อง เพื่อตรวจจับตอนใหม่
let lastFetchedAt = null;
let isFetching = false;

// ฟังก์ชันดึงข้อมูลจากทั้ง 6 เว็บแบบขนาน (Parallel Fetching)
async function updateMangaFeed() {
    if (isFetching) return cachedData;
    isFetching = true;
    console.log('[MangaHub] Fetching latest manga from 6 websites...');

    try {
        const [blackcat, speed, up, chibi, zen, bully] = await Promise.all([
            scrapers.scrapeBlackCat(),
            scrapers.scrapeSpeedManga(),
            scrapers.scrapeUpManga(),
            scrapers.scrapeChibiManga(),
            scrapers.scrapeZenManga(),
            scrapers.scrapeBullyManga()
        ]);

        const allItems = [...blackcat, ...speed, ...up, ...chibi, ...zen, ...bully];
        console.log(`[MangaHub] Total raw items collected: ${allItems.length}`);

        // ดำเนินการผสานเรื่องซ้ำ (Deduplicate & Group by Manga)
        const merged = scrapers.mergeAndDeduplicate(allItems);
        console.log(`[MangaHub] Unique manga titles after merge: ${merged.length}`);

        // ตรวจจับตอนใหม่ และส่งแจ้งเตือนเข้า Telegram
        if (knownChaptersMap.size > 0) {
            for (const manga of merged) {
                // สร้าง signature ตอนของเรื่องนี้
                const currentSig = manga.sources.map(s => `${s.source}:${s.latestChapter}`).sort().join('|');
                const prevSig = knownChaptersMap.get(manga.cleanKey);

                if (prevSig && prevSig !== currentSig && manga.isNewToday) {
                    console.log(`[Alert] New chapter detected for: ${manga.title}`);
                    notifier.notifyNewChapter(manga);
                }
            }
        }

        // อัปเดต Map บันทึกตอนปัจจุบัน
        for (const manga of merged) {
            const currentSig = manga.sources.map(s => `${s.source}:${s.latestChapter}`).sort().join('|');
            knownChaptersMap.set(manga.cleanKey, currentSig);
        }

        cachedData = merged;
        lastFetchedAt = new Date();
    } catch (err) {
        console.error('[MangaHub] Error during feed update:', err.message);
    } finally {
        isFetching = false;
    }

    return cachedData;
}

// -------------------------------------------------------------
// API Routes
// -------------------------------------------------------------

// API ส่งข้อมูลมังงะทั้งหมดในรูปแบบ JSON
app.get('/api/manga', async (req, res) => {
    // ถ้ายังไม่มีแคช หรือแคชเก่ากว่า 5 นาที ให้ดึงใหม่
    const fiveMinutes = 5 * 60 * 1000;
    if (!lastFetchedAt || (new Date() - lastFetchedAt > fiveMinutes)) {
        await updateMangaFeed();
    }
    res.json({
        success: true,
        total: cachedData.length,
        updatedAt: lastFetchedAt,
        data: cachedData
    });
});

// API สั่งบังคับดึงข้อมูลใหม่ทันที (Force Refresh)
app.post('/api/refresh', async (req, res) => {
    const data = await updateMangaFeed();
    res.json({
        success: true,
        total: data.length,
        updatedAt: lastFetchedAt,
        data: data
    });
});

// เสิร์ฟหน้าเว็บหลัก
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// เริ่มต้นเซิร์ฟเวอร์
app.listen(PORT, async () => {
    console.log(`====================================================`);
    console.log(`🚀 MangaHub Web Application is running!`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`====================================================`);
    
    // 1. ดึงข้อมูลครั้งแรกทันทีที่เปิดเครื่อง
    updateMangaFeed();

    // 2. Background Auto-Update: ตั้งเวลาดึงข้อมูลใหม่อัตโนมัติทุกๆ 10 นาที
    const TEN_MINUTES = 10 * 60 * 1000;
    setInterval(() => {
        console.log('[MangaHub] Triggering automatic background update...');
        updateMangaFeed();
    }, TEN_MINUTES);

    // 3. เริ่มต้นระบบ Telegram AI Assistant (รันเบื้องหลัง)
    aiBot.startChatListener();
});
