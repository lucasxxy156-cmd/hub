require('dotenv').config(); // ต้องอยู่บนสุด ก่อน require โมดูลอื่นที่อ่านค่าจาก .env

const express = require('express');
const cors = require('cors');
const path = require('path');
const scrapers = require('./scrapers');
const notifier = require('./notifier');
const aiBot = require('./ai_bot');
const tracker = require('./tracker').createTracker();

const app = express();
const PORT = process.env.PORT || 3000;

const CACHE_TTL = 5 * 60 * 1000;          // แคชหมดอายุหลัง 5 นาที
const MIN_REFRESH_GAP = 30 * 1000;        // ดึงเว็บต้นทางห่างกันอย่างน้อย 30 วินาที (กันโดนยิงรัว)
const AUTO_UPDATE_EVERY = 10 * 60 * 1000; // อัปเดตเบื้องหลังทุก 10 นาที
const MAX_ALERTS_PER_RUN = 20;            // เกินนี้ในรอบเดียวมักเป็นเว็บเปลี่ยนโครงสร้าง ไม่ใช่ตอนใหม่จริง

app.disable('x-powered-by');
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const SOURCES = {
    MangaBlackCat: scrapers.scrapeBlackCat,
    SpeedManga: scrapers.scrapeSpeedManga,
    UpManga: scrapers.scrapeUpManga,
    ChibiManga: scrapers.scrapeChibiManga,
    ZenManga: scrapers.scrapeZenManga,
    BullyManga: scrapers.scrapeBullyManga
};

// In-memory cache
let cachedData = [];
let lastFetchedAt = null;   // เวลาที่ดึงสำเร็จล่าสุด
let lastAttemptAt = 0;      // เวลาที่พยายามดึงล่าสุด (สำเร็จหรือไม่ก็ตาม)
let inFlight = null;        // Promise ของการดึงที่กำลังทำอยู่ (ทุกคนที่เรียกพร้อมกันรอตัวเดียวกัน)
const lastGoodBySource = new Map(); // ผลดึงสำเร็จล่าสุดของแต่ละเว็บ ไว้ใช้ตอนเว็บนั้นล่ม

// ดึงข้อมูลจาก 6 เว็บแบบขนาน — คืน true ถ้าได้ข้อมูลใหม่จริง
function updateMangaFeed() {
    if (inFlight) return inFlight;
    if (Date.now() - lastAttemptAt < MIN_REFRESH_GAP) return Promise.resolve(false);

    inFlight = runUpdate().finally(() => { inFlight = null; });
    return inFlight;
}

async function runUpdate() {
    lastAttemptAt = Date.now();
    console.log('[MangaHub] Fetching latest manga from 6 websites...');

    try {
        const results = await Promise.all(Object.entries(SOURCES).map(async ([name, scrape]) => {
            const items = await scrape();
            if (items.length) {
                lastGoodBySource.set(name, items);
                return items;
            }
            // เว็บนี้ล่ม/ได้ผลว่าง: ใช้ข้อมูลรอบก่อนแทน เรื่องของเว็บนี้จะได้ไม่หายไปจากหน้าเว็บ
            const stale = lastGoodBySource.get(name);
            if (stale) {
                console.warn(`[MangaHub] ${name} returned nothing — using previous data`);
                return stale.map(i => ({ ...i, isToday: false }));
            }
            return [];
        }));

        const allItems = results.flat();
        console.log(`[MangaHub] Total raw items collected: ${allItems.length}`);

        if (allItems.length === 0) {
            console.warn('[MangaHub] Every source failed — keeping the previous cache');
            return false;
        }

        const merged = scrapers.mergeAndDeduplicate(allItems);
        console.log(`[MangaHub] Unique manga titles after merge: ${merged.length}`);

        // ตรวจจับตอนใหม่รายเว็บ + ตั้งป้าย NEW (แก้ใน merged) แล้วจัดเรียงใหม่
        const alerts = tracker.apply(merged);
        scrapers.sortByToday(merged);
        tracker.save();

        cachedData = merged;
        lastFetchedAt = new Date();

        if (alerts.length > MAX_ALERTS_PER_RUN) {
            console.warn(`[Alert] ${alerts.length} changes in one run — sending only the first ${MAX_ALERTS_PER_RUN} (site layout change?)`);
        }
        for (const { manga, changedSources } of alerts.slice(0, MAX_ALERTS_PER_RUN)) {
            console.log(`[Alert] New chapter detected for: ${manga.title} (${changedSources.join(', ')})`);
            notifier.notifyNewChapter(manga, changedSources); // เข้าคิวส่งทีละเรื่อง
        }
        return true;
    } catch (err) {
        console.error('[MangaHub] Error during feed update:', err.message);
        return false;
    }
}

function payload() {
    return {
        success: true,
        total: cachedData.length,
        updatedAt: lastFetchedAt,
        data: cachedData
    };
}

// -------------------------------------------------------------
// API Routes
// -------------------------------------------------------------

// ข้อมูลมังงะทั้งหมด (JSON)
// ครั้งแรกรอข้อมูลจริง หลังจากนั้นตอบแคชทันทีแล้วรีเฟรชเบื้องหลังถ้าเก่าเกิน 5 นาที
app.get('/api/manga', async (req, res) => {
    if (!lastFetchedAt) {
        await updateMangaFeed();
    } else if (Date.now() - lastFetchedAt.getTime() > CACHE_TTL) {
        updateMangaFeed();
    }
    res.json(payload());
});

// บังคับดึงใหม่ (จำกัดไม่ให้ถี่เกิน MIN_REFRESH_GAP — ถ้าถี่เกินจะได้แคชเดิมกลับไปพร้อม refreshed: false)
app.post('/api/refresh', async (req, res) => {
    const refreshed = await updateMangaFeed();
    res.json({ ...payload(), refreshed });
});

// หน้าเว็บหลัก
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

process.on('unhandledRejection', (reason) => {
    console.error('[MangaHub] Unhandled rejection:', reason);
});

// เริ่มต้นเซิร์ฟเวอร์
app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 MangaHub Web Application is running!`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`====================================================`);

    // 1. ดึงข้อมูลครั้งแรกทันทีที่เปิดเครื่อง
    updateMangaFeed();

    // 2. Background Auto-Update ทุก 10 นาที
    setInterval(() => {
        console.log('[MangaHub] Triggering automatic background update...');
        updateMangaFeed();
    }, AUTO_UPDATE_EVERY);

    // 3. เริ่มต้นระบบ Telegram AI Assistant (รันเบื้องหลัง)
    aiBot.startChatListener().catch(err => console.error('[AI Bot] Stopped unexpectedly:', err.message));
});
