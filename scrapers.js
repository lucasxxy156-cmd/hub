const axios = require('axios');
const cheerio = require('cheerio');

// ค่าเริ่มต้นเมื่อหาเลขตอนไม่เจอ (tracker.js ใช้ค่านี้เพื่อไม่ให้แจ้งเตือนมั่ว)
const NO_CHAPTER = 'ตอนใหม่ล่าสุด';

const client = axios.create({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'th,en;q=0.8'
    },
    timeout: 10000
});

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// แปลง URL ให้เป็น absolute เสมอ (รองรับ relative / protocol-relative)
function absUrl(href, base) {
    if (!href) return '';
    try {
        return new URL(href.trim(), base).href;
    } catch {
        return '';
    }
}

// เลือกรูปปกให้ถูกต้อง: เว็บที่ lazy-load มักใส่ placeholder ใน src จริงอยู่ที่ data-src
function pickImage($, el, base) {
    const img = $(el).find('img').first();
    if (!img.length) return '';

    const candidates = [
        img.attr('data-src'),
        img.attr('data-lazy-src'),
        img.attr('data-original'),
        img.attr('src')
    ];
    for (const c of candidates) {
        const v = (c || '').trim();
        if (v && !v.startsWith('data:')) return absUrl(v, base);
    }

    const srcset = img.attr('data-srcset') || img.attr('srcset') || '';
    const first = srcset.split(',')[0].trim().split(/\s+/)[0];
    return first && !first.startsWith('data:') ? absUrl(first, base) : '';
}

function cleanTitle(title) {
    if (!title) return '';
    return title
        .toLowerCase()
        .replace(/แปลไทย|อ่านมังงะ|มังงะ|ตอนล่าสุด/g, ' ')
        .replace(/^\s*up\s+/, '')
        // เก็บตัวอักษรทุกภาษา (รวมสระ/วรรณยุกต์ไทย) และตัวเลข — ชื่อญี่ปุ่น/เกาหลี/จีนจะไม่หายไปอีก
        .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ข้อความเวลาแบบ "ภายใน 24 ชั่วโมง" เช่น "5 นาทีที่แล้ว", "2 hours ago", "วันนี้"
// ต้องมีตัวเลขนำหน้าหน่วยเวลา เพื่อไม่ให้ไปตรงกับชื่อเรื่อง (เช่น "Second Life Ranker")
const TODAY_RE = new RegExp([
    '\\d+\\s*(?:วินาที|นาที|ชั่วโมง|ชม\\.)',
    '\\d+\\s*(?:sec(?:ond)?s?|min(?:ute)?s?|hrs?|hours?)\\b',
    '\\b(?:an?|few)\\s+(?:seconds?|minutes?|hours?)\\s+ago\\b',
    'เมื่อสักครู่|วันนี้|\\btoday\\b|\\bjust now\\b'
].join('|'), 'i');

function checkIsToday(timeText) {
    return !!timeText && TODAY_RE.test(timeText);
}

// ดึงเลขตอนจากข้อความ เช่น "ตอนที่ 123", "Chapter 45.5", "Ch.12"
const CHAPTER_RE = /(?:ตอนที่|ตอน|\b(?:chapter|chap\.?|ch\.?|episode|ep\.?))\s*\d+(?:[.\-]\d+)?/i;

function extractChapter(text) {
    const m = String(text || '').match(CHAPTER_RE);
    return m ? squash(m[0]) : '';
}

// สแกนการ์ดมังงะ (เฉพาะ element ปลายทางที่ไม่ใช่ส่วนหัวข้อชื่อเรื่อง) เพื่อหาตอน / เวลา / ป้าย NEW / UP
function scanCard($, el) {
    const out = { chapter: '', timeText: '', hasNew: false, hasUp: false };
    $(el).find('a, span, div, small, time, em, b').each((_, e) => {
        const node = $(e);
        if (node.children().length) return;                     // เอาเฉพาะ leaf
        if (node.closest('h1, h2, h3, h4, h5').length) return;   // ข้ามชื่อเรื่อง
        const t = squash(node.text());
        if (!t || t.length > 40) return;

        if (!out.chapter) out.chapter = extractChapter(t);
        if (!out.timeText && checkIsToday(t)) out.timeText = t;
        if (/^new$/i.test(t)) out.hasNew = true;
        if (t === 'UP') out.hasUp = true;
    });
    return out;
}

// -------------------------------------------------------------
// 1. MangaBlackCat (เฉพาะโซน #latest-updated)
// -------------------------------------------------------------
async function scrapeBlackCat() {
    const base = 'https://mangablackcat.com/';
    try {
        const { data } = await client.get(base + '?page=1');
        const $ = cheerio.load(data);
        const results = [];

        $('#latest-updated article').each((_, el) => {
            const h3 = $(el).find('h3').first();
            if (!h3.length) return;

            // ตัดป้าย "UP" ออกจากชื่อแบบตรงตัว (ไม่ตัด "Up" ที่เป็นส่วนของชื่อเรื่องจริง เช่น "Upstart")
            let hasUp = false;
            const h3c = h3.clone();
            h3c.find('span, .badge').each((_, b) => {
                if (squash($(b).text()).toUpperCase() === 'UP') {
                    hasUp = true;
                    $(b).remove();
                }
            });
            let title = squash(h3c.text());
            if (/^UP\s+/.test(title)) {
                hasUp = true;
                title = title.replace(/^UP\s+/, '');
            }

            const card = scanCard($, el);
            const link = absUrl($(el).find('a').first().attr('href'), base);
            const cover = pickImage($, el, base);
            const isToday = hasUp || card.hasUp || card.hasNew || !!card.timeText;

            if (title && link) {
                results.push({
                    title: cleanTitle(title),
                    displayTitle: title,
                    cover,
                    latestChapter: card.chapter || NO_CHAPTER,
                    timeAgo: card.timeText || (isToday ? 'วันนี้' : ''),
                    isToday,
                    url: link,
                    source: 'MangaBlackCat',
                    sourceColor: '#f97316'
                });
            }
        });
        return results;
    } catch (err) {
        console.error('BlackCat err:', err.message);
        return [];
    }
}

// -------------------------------------------------------------
// 2, 4, 5. SpeedManga / ChibiManga / ZenManga (โครงเว็บแบบเดียวกัน: .listupd .utao)
// -------------------------------------------------------------
async function scrapeUtaoSite({ base, source, sourceColor }) {
    try {
        const { data } = await client.get(base);
        const $ = cheerio.load(data);
        const results = [];

        $('.listupd .utao').each((_, el) => {
            const title = squash($(el).find('.luf h4').text());
            const link = absUrl($(el).find('a.series').attr('href'), base);
            const cover = pickImage($, el, base);

            let chapterEl = $(el).find('.luf ul li a').first();
            if (!chapterEl.length) chapterEl = $(el).find('ul li a').first();
            let timeEl = $(el).find('.luf ul li span').first();
            if (!timeEl.length) timeEl = $(el).find('ul li span').first();

            const latestChapter = squash(chapterEl.text());
            const timeText = squash(timeEl.text());

            if (title && link) {
                results.push({
                    title: cleanTitle(title),
                    displayTitle: title,
                    cover,
                    latestChapter: latestChapter || NO_CHAPTER,
                    timeAgo: timeText,
                    isToday: checkIsToday(timeText),
                    url: link,
                    source,
                    sourceColor
                });
            }
        });
        return results;
    } catch (err) {
        console.error(`${source} err:`, err.message);
        return [];
    }
}

const scrapeSpeedManga = () => scrapeUtaoSite({ base: 'https://speed-manga.net/', source: 'SpeedManga', sourceColor: '#eab308' });
const scrapeChibiManga = () => scrapeUtaoSite({ base: 'https://chibi-manga.com/', source: 'ChibiManga', sourceColor: '#ec4899' });
const scrapeZenManga = () => scrapeUtaoSite({ base: 'https://www.zen-manga.com/', source: 'ZenManga', sourceColor: '#10b981' });

// -------------------------------------------------------------
// 3. UpManga (หน้าเรียงตามวันที่อัปเดตล่าสุด ?order=update)
// -------------------------------------------------------------
async function scrapeUpManga() {
    const base = 'https://www.up-manga.com/';
    try {
        const { data } = await client.get(base + 'manga/?order=update');
        const $ = cheerio.load(data);
        const results = [];

        // จำกัดเฉพาะรายการหลัก ไม่ดึง .bsx ในแถบข้าง (popular ฯลฯ) ยกเว้นหาไม่เจอจริงๆ
        let nodes = $('.listupd .bsx');
        if (!nodes.length) nodes = $('.bsx');

        nodes.each((_, el) => {
            const title = squash($(el).find('.tt').text());
            const link = absUrl($(el).find('a').first().attr('href'), base);
            const cover = pickImage($, el, base);
            const latestChapter = squash($(el).find('.epxs').text());
            // หน้านี้ส่วนใหญ่ไม่มีเวลา: ถ้ามีให้ใช้ ถ้าไม่มี tracker.js จะตรวจจับตอนใหม่เองจากการเปลี่ยนของเลขตอน
            const timeText = squash($(el).find('.epxdate, .date, time').first().text());

            if (title && link) {
                results.push({
                    title: cleanTitle(title),
                    displayTitle: title,
                    cover,
                    latestChapter: latestChapter || NO_CHAPTER,
                    timeAgo: timeText,
                    isToday: checkIsToday(timeText),
                    url: link,
                    source: 'UpManga',
                    sourceColor: '#3b82f6'
                });
            }
        });
        return results.slice(0, 35);
    } catch (err) {
        console.error('UpManga err:', err.message);
        return [];
    }
}

// -------------------------------------------------------------
// 6. BullyManga
// -------------------------------------------------------------
async function scrapeBullyManga() {
    const base = 'https://bully-manga.com/';
    try {
        const { data } = await client.get(base);
        const $ = cheerio.load(data);
        const results = [];
        const seen = new Set();

        $('a[href^="/"]').each((_, el) => {
            const href = $(el).attr('href') || '';
            if (href.length <= 2 || href.startsWith('//')) return;
            if (href.includes('genres') || href.includes('bookmark') || href.includes('search')) return;

            const title = squash($(el).find('h2, h3, h4').first().text());
            if (title.length <= 2) return;

            const link = absUrl(href, base);
            if (!link || seen.has(link)) return;
            seen.add(link);

            const card = scanCard($, el);
            const isToday = card.hasNew || !!card.timeText;

            results.push({
                title: cleanTitle(title),
                displayTitle: title,
                cover: pickImage($, el, base),
                latestChapter: card.chapter || NO_CHAPTER,
                timeAgo: card.timeText || (isToday ? 'วันนี้' : ''),
                isToday,
                url: link,
                source: 'BullyManga',
                sourceColor: '#8b5cf6'
            });
        });
        return results.slice(0, 30);
    } catch (err) {
        console.error('BullyManga err:', err.message);
        return [];
    }
}

// -------------------------------------------------------------
// รวมเรื่องซ้ำ
// -------------------------------------------------------------

// ชื่อเหมือนกัน หรือชื่อหนึ่งอยู่ในอีกชื่อและความยาวต่างกันไม่เกิน 20%
// (กัน "Tower of God" ไปรวมกับ "Tower of God Season 2")
function isSameTitle(a, b) {
    if (a === b) return true;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.length <= 6) return false;
    return long.includes(short) && short.length / long.length >= 0.8;
}

// เรื่องที่อัปเดตวันนี้ขึ้นก่อน (sort แบบ stable, แก้ array เดิม)
function sortByToday(list) {
    return list.sort((a, b) => (b.isNewToday ? 1 : 0) - (a.isNewToday ? 1 : 0));
}

function mergeAndDeduplicate(allMangaList) {
    const mangaMap = new Map();

    for (const item of allMangaList) {
        if (!item.title) continue;

        let matchedKey = mangaMap.has(item.title) ? item.title : null;
        if (!matchedKey) {
            for (const existingKey of mangaMap.keys()) {
                if (isSameTitle(item.title, existingKey)) {
                    matchedKey = existingKey;
                    break;
                }
            }
        }

        const sourceEntry = {
            source: item.source,
            sourceColor: item.sourceColor,
            latestChapter: item.latestChapter,
            timeAgo: item.timeAgo,
            isToday: item.isToday,
            url: item.url
        };

        if (matchedKey) {
            const existing = mangaMap.get(matchedKey);
            if (!existing.sources.some(s => s.source === item.source)) {
                existing.sources.push(sourceEntry);
            }
            if (item.isToday) existing.isNewToday = true;
            if (!existing.cover && item.cover) existing.cover = item.cover;
        } else {
            mangaMap.set(item.title, {
                title: item.displayTitle || item.title,
                cleanKey: item.title,
                cover: item.cover,
                isNewToday: !!item.isToday,
                sources: [sourceEntry]
            });
        }
    }

    return sortByToday(Array.from(mangaMap.values()));
}

module.exports = {
    NO_CHAPTER,
    cleanTitle,
    checkIsToday,
    extractChapter,
    sortByToday,
    scrapeBlackCat,
    scrapeSpeedManga,
    scrapeUpManga,
    scrapeChibiManga,
    scrapeZenManga,
    scrapeBullyManga,
    mergeAndDeduplicate
};
