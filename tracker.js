const fs = require('fs');
const path = require('path');
const { NO_CHAPTER } = require('./scrapers');

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 30 * DAY_MS;
const DEFAULT_FILE = path.join(__dirname, 'data', 'state.json');

function chapterNumber(text) {
    const m = String(text || '').match(/\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
}

// ตอนใหม่ต้อง "ไปข้างหน้า": ถ้าเว็บเด้งกลับไปแสดงตอนเก่าชั่วคราวจะไม่ถือว่าเป็นตอนใหม่
function isForward(prev, next) {
    const a = chapterNumber(prev);
    const b = chapterNumber(next);
    if (a === null || b === null) return true; // ไม่มีเลข (เช่น "ตอนพิเศษ") → ถือว่าเปลี่ยน
    return b > a;
}

/**
 * ตัวติดตามตอนล่าสุดรายเว็บ + บันทึกลงไฟล์ (รีสตาร์ทแล้วไม่ลืม)
 *
 * โครงสร้าง state:
 *   { [cleanKey]: { seenAt, sources: { [sourceName]: { chapter, changedAt } } } }
 *
 * หลักการ: เทียบ "เว็บเดิมของเรื่องเดิม" เท่านั้น
 *  - เว็บล่ม / เรื่องหลุดหน้าแรกของเว็บหนึ่ง  → ไม่ถือว่าเปลี่ยน (ไม่แจ้งเตือนมั่ว)
 *  - เว็บใหม่มาเจอเรื่องเดิม                → แค่จดไว้ ไม่แจ้งเตือน
 *  - เว็บเดิมเลขตอนเดินหน้า                  → ตอนใหม่จริง แจ้งเตือน + ติดป้าย NEW 24 ชม.
 */
function createTracker(file = DEFAULT_FILE) {
    let state = load();

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    function save() {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(state));
            fs.renameSync(tmp, file);
        } catch (err) {
            console.error('[Tracker] Cannot save state:', err.message);
        }
    }

    /**
     * ตรวจจับตอนใหม่ + ตั้งค่า isToday / isNewToday ให้รายการที่ merge แล้ว (แก้ object เดิม)
     * @returns {{manga: Object, changedSources: string[]}[]} รายการที่ควรแจ้งเตือน
     */
    function apply(merged, now = Date.now()) {
        const hasBaseline = Object.keys(state).length > 0; // รอบแรกสุดแค่จดจำ ไม่แจ้งเตือน
        const alerts = [];

        for (const manga of merged) {
            const entry = state[manga.cleanKey] || (state[manga.cleanKey] = { seenAt: now, sources: {} });
            entry.seenAt = now;
            const changedSources = [];

            for (const s of manga.sources) {
                let rec = entry.sources[s.source];
                if (!rec) {
                    rec = entry.sources[s.source] = { chapter: s.latestChapter, changedAt: null };
                } else if (rec.chapter !== s.latestChapter) {
                    const real = rec.chapter !== NO_CHAPTER
                        && s.latestChapter !== NO_CHAPTER
                        && isForward(rec.chapter, s.latestChapter);
                    rec.chapter = s.latestChapter;
                    if (real) {
                        rec.changedAt = now;
                        changedSources.push(s.source);
                    }
                }

                // ป้าย NEW: เว็บบอกว่าวันนี้ หรือเราเห็นตอนเปลี่ยนเองภายใน 24 ชม.
                if (rec.changedAt && now - rec.changedAt < DAY_MS) s.isToday = true;
            }

            manga.isNewToday = manga.sources.some(s => s.isToday);
            if (hasBaseline && changedSources.length) alerts.push({ manga, changedSources });
        }

        for (const key of Object.keys(state)) {
            if (now - state[key].seenAt > PRUNE_AFTER_MS) delete state[key];
        }

        return alerts;
    }

    return { apply, save };
}

module.exports = { createTracker, isForward };
