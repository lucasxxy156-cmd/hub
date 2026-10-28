const axios = require('axios');
const cheerio = require('cheerio');

const client = axios.create({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    timeout: 10000
});

function cleanTitle(title) {
    if (!title) return '';
    return title
        .toLowerCase()
        .replace(/แปลไทย|มังงะ|อ่านมังงะ|ตอนล่าสุด|^up\s+/gi, '')
        .replace(/[^\w\s\u0E00-\u0E7F]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ฟังก์ชันตรวจสอบว่าเป็นอัปเดตวันนี้ (New Today) หรือไม่
function checkIsToday(timeText) {
    if (!timeText) return false;
    const lower = timeText.toLowerCase();
    return (
        lower.includes('วินาที') || 
        lower.includes('นาที') || 
        lower.includes('ชั่วโมง') || 
        lower.includes('second') || 
        lower.includes('minute') || 
        lower.includes('hour') || 
        lower.includes('วันนี้') || 
        lower.includes('today') ||
        lower.includes('up')
    );
}

// 1. MangaBlackCat (เจาะจงเฉพาะโซน #latest-updated)
async function scrapeBlackCat() {
    try {
        const { data } = await client.get('https://mangablackcat.com/?page=1#latest-updated');
        const $ = cheerio.load(data);
        const results = [];
        
        $('#latest-updated article').each((_, el) => {
            const h3 = $(el).find('h3');
            const hasUpBadge = $(el).find('.badge, span:contains("UP"), h3:contains("UP")').length > 0;
            let title = h3.text().trim().replace(/^UP\s*/i, '').trim();
            const link = $(el).find('a').attr('href') || '';
            const image = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
            
            let chapter = '';
            $(el).find('a, span').each((_, elem) => {
                const t = $(elem).text().trim();
                if ((t.includes('ตอนที่') || t.toLowerCase().startsWith('ch')) && !chapter) {
                    chapter = t;
                }
            });

            if (title && link) {
                results.push({
                    title: cleanTitle(title),
                    displayTitle: title,
                    cover: image,
                    latestChapter: chapter || 'ตอนใหม่ล่าสุด',
                    timeAgo: 'วันนี้ (สดใหม่)',
                    isToday: true, // ทุกเรื่องใน #latest-updated ของ Blackcat คือเรื่องเพิ่งอัปเดตรายวัน
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

// 2. SpeedManga (เจาะจงเฉพาะโซน Latest Update .utao)
async function scrapeSpeedManga() {
    try {
        const { data } = await client.get('https://speed-manga.net/');
        const $ = cheerio.load(data);
        const results = [];
        $('.listupd .utao').each((_, el) => {
            const title = $(el).find('.luf h4').text().trim();
            const link = $(el).find('a.series').attr('href') || '';
            const image = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
            const latestChapter = $(el).find('ul li a').first().text().trim();
            const timeText = $(el).find('ul li span').first().text().trim();
            const isToday = checkIsToday(timeText);

            if (title && link) {
                results.push({
                    title: cleanTitle(title),
                    displayTitle: title,
                    cover: image,
                    latestChapter: latestChapter || 'ตอนใหม่ล่าสุด',
                    timeAgo: timeText || '',
                    isToday: isToday,
                    url: link,
                    source: 'SpeedManga',
                    sourceColor: '#eab308'
                });
            }
        });
        return results;
    } catch (err) {
        console.error('SpeedManga err:', err.message);
        return [];
    }
}

// 3. UpManga (เจาะจงเฉพาะหน้าเรียงตามวันที่อัปเดตล่าสุด ?order=update)
async function scrapeUpManga() {
    try {
        const { data } = await client.get('https://www.up-manga.com/manga/?order=update');
        const $ = cheerio.load(data);
        const results = [];
        $('.listupd .bsx, .bsx').each((i, el) => {
            const title = $(el).find('.tt').text().trim();
            const link = $(el).find('a').attr('href') || '';
            const image = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
            const latestChapter = $(el).find('.epxs').text().trim();
            // หน้า update เรียงตามเวลา 20 เรื่องแรกคือของวันนี้
            const isToday = i < 20;

            if (title && link) {
                results.push({
                    title: cleanTitle(title),
                    displayTitle: title,
                    cover: image,
                    latestChapter: latestChapter || 'ตอนใหม่ล่าสุด',
                    timeAgo: isToday ? 'วันนี้' : '',
                    isToday: isToday,
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

// 4. ChibiManga (เจาะจงเฉพาะโซน Latest Update .listupd)
async function scrapeChibiManga() {
    try {
        const { data } = await client.get('https://chibi-manga.com/');
        const $ = cheerio.load(data);
        const results = [];
        $('.listupd .utao').each((_, el) => {
            const title = $(el).find('.luf h4').text().trim();
            const link = $(el).find('a.series').attr('href') || '';
            const image = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
            const latestChapter = $(el).find('.luf ul li a').first().text().trim();
            const timeText = $(el).find('.luf ul li span').first().text().trim();
            const isToday = checkIsToday(timeText);

            if (title && link) {
                results.push({
                    title: cleanTitle(title),
                    displayTitle: title,
                    cover: image,
                    latestChapter: latestChapter || 'ตอนใหม่ล่าสุด',
                    timeAgo: timeText || '',
                    isToday: isToday,
                    url: link,
                    source: 'ChibiManga',
                    sourceColor: '#ec4899'
                });
            }
        });
        return results;
    } catch (err) {
        console.error('ChibiManga err:', err.message);
        return [];
    }
}

// 5. ZenManga (เจาะจงเฉพาะโซน Latest Update .listupd)
async function scrapeZenManga() {
    try {
        const { data } = await client.get('https://www.zen-manga.com/');
        const $ = cheerio.load(data);
        const results = [];
        $('.listupd .utao').each((_, el) => {
            const title = $(el).find('.luf h4').text().trim();
            const link = $(el).find('a.series').attr('href') || '';
            const image = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
            const latestChapter = $(el).find('ul li a').first().text().trim();
            const timeText = $(el).find('ul li span').first().text().trim();
            const isToday = checkIsToday(timeText);

            if (title && link) {
                results.push({
                    title: cleanTitle(title),
                    displayTitle: title,
                    cover: image,
                    latestChapter: latestChapter || 'ตอนใหม่ล่าสุด',
                    timeAgo: timeText || '',
                    isToday: isToday,
                    url: link,
                    source: 'ZenManga',
                    sourceColor: '#10b981'
                });
            }
        });
        return results;
    } catch (err) {
        console.error('ZenManga err:', err.message);
        return [];
    }
}

// 6. BullyManga
async function scrapeBullyManga() {
    try {
        const { data } = await client.get('https://bully-manga.com/');
        const $ = cheerio.load(data);
        const results = [];
        $('a[href^="/"]').each((_, el) => {
            const link = $(el).attr('href');
            if (link && !link.includes('genres') && !link.includes('bookmark') && !link.includes('search') && link.length > 2) {
                const title = $(el).find('h2, h3, h4').text().trim();
                const image = $(el).find('img').attr('src') || '';
                const chapter = $(el).find('.chapter, span').filter((_, e) => $(e).text().includes('ตอนที่') || $(e).text().toLowerCase().includes('ch')).first().text().trim();
                const isToday = $(el).text().includes('NEW') || $(el).text().includes('วันนี้') || $(el).text().includes('ชั่วโมง');

                if (title && title.length > 2) {
                    results.push({
                        title: cleanTitle(title),
                        displayTitle: title,
                        cover: image,
                        latestChapter: chapter || 'ตอนใหม่ล่าสุด',
                        timeAgo: isToday ? 'วันนี้' : '',
                        isToday: isToday,
                        url: 'https://bully-manga.com' + link,
                        source: 'BullyManga',
                        sourceColor: '#8b5cf6'
                    });
                }
            }
        });
        return results.slice(0, 30);
    } catch (err) {
        console.error('BullyManga err:', err.message);
        return [];
    }
}

// รวมเรื่องซ้ำ พร้อมรวบรวมสถานะ isNewToday
function mergeAndDeduplicate(allMangaList) {
    const mangaMap = new Map();

    for (const item of allMangaList) {
        if (!item.title) continue;

        let matchedKey = null;
        for (const existingKey of mangaMap.keys()) {
            if (
                item.title === existingKey ||
                (item.title.length > 6 && existingKey.includes(item.title)) ||
                (existingKey.length > 6 && item.title.includes(existingKey))
            ) {
                matchedKey = existingKey;
                break;
            }
        }

        if (matchedKey) {
            const existing = mangaMap.get(matchedKey);
            const alreadyHasSource = existing.sources.some(s => s.source === item.source);
            if (!alreadyHasSource) {
                existing.sources.push({
                    source: item.source,
                    sourceColor: item.sourceColor,
                    latestChapter: item.latestChapter,
                    timeAgo: item.timeAgo,
                    isToday: item.isToday,
                    url: item.url
                });
            }
            if (item.isToday) {
                existing.isNewToday = true;
            }
            if (!existing.cover && item.cover) {
                existing.cover = item.cover;
            }
        } else {
            mangaMap.set(item.title, {
                title: item.displayTitle || item.title,
                cleanKey: item.title,
                cover: item.cover,
                isNewToday: !!item.isToday,
                sources: [
                    {
                        source: item.source,
                        sourceColor: item.sourceColor,
                        latestChapter: item.latestChapter,
                        timeAgo: item.timeAgo,
                        isToday: item.isToday,
                        url: item.url
                    }
                ]
            });
        }
    }

    // เรียงเรื่องที่อัปเดตวันนี้ (isNewToday) ให้อยู่ข้างหน้าสุด
    return Array.from(mangaMap.values()).sort((a, b) => {
        if (a.isNewToday && !b.isNewToday) return -1;
        if (!a.isNewToday && b.isNewToday) return 1;
        return 0;
    });
}

module.exports = {
    scrapeBlackCat,
    scrapeSpeedManga,
    scrapeUpManga,
    scrapeChibiManga,
    scrapeZenManga,
    scrapeBullyManga,
    mergeAndDeduplicate
};
