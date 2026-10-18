/**
 * historySheet.js — Đẩy lịch sử luồng của CẢ CỤM lên tab LICH_SU_LUONG trong Google Sheet tài khoản.
 *
 * - Chỉ máy Master đẩy (Worker không cần cấu hình Sheet). Master gom luồng + lịch sử của mọi máy (local + các máy khác).
 * - MỖI PHIÊN LIVE = 1 DÒNG (theo UID phiên):
 *     • Luồng đang hoạt động → ghi dòng trạng thái "Đang live" / "Đang chờ lịch" / "Đang tải video"...
 *     • Khi dừng/kết thúc → Apps Script GHI ĐÈ đúng dòng đó thành "Đã dừng" / "Hoàn thành" / "Lỗi".
 *   Dòng đang chạy chỉ gửi lại khi trạng thái thay đổi hoặc mỗi RUNNING_REFRESH (cập nhật thời lượng).
 * - Stream Key ghi ĐẦY ĐỦ (ai xem được Sheet là thấy key → chỉ chia sẻ Sheet cho người tin cậy).
 * - Master nhớ những gì đã đẩy (sheet_history_state.json) → khởi động lại / đổi Master không nhân đôi dòng.
 * - Master sập: lịch sử vẫn nằm trên từng máy, Master sống lại sẽ đẩy bù.
 * - Tắt hẳn: HISTORY_SHEET=0. Chu kỳ: HISTORY_SHEET_INTERVAL_MS (mặc định 60000).
 * - Cần bản Apps Script mới (có action appendHistory, bản cập nhật theo UID). Bản cũ trả "Hành động không hợp lệ" → chỉ cảnh báo.
 */
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'sheet_history_state.json');
const MAX_REMEMBER = 20000;
const PER_TICK = 80;   // tối đa số dòng đẩy mỗi chu kỳ (tránh dồn quá nhiều request lên Google)
const BATCH = 8;       // số dòng mỗi request (URL GET không được quá dài)
const MAX_URL = 7000;
const RUNNING_REFRESH = parseInt(process.env.HISTORY_RUNNING_REFRESH_MS) || 30 * 60000; // gửi lại dòng đang chạy để cập nhật thời lượng
const KEY_ACTIVE = ['live', 'downloading', 'launching', 'reconnecting', 'scheduled'];

const fmtVN = (iso) => {
  if (!iso) return '';
  const t = Date.parse(iso);
  return isNaN(t) ? '' : new Date(t).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
};
const fmtDur = (sec) => {
  sec = Math.max(0, parseInt(sec) || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const REASON = { finished: 'Hoàn thành', stopped: 'Đã dừng', error: 'Lỗi' };
const RUNNING = { live: 'Đang live', scheduled: 'Đang chờ lịch', downloading: 'Đang tải video', launching: 'Đang khởi động', reconnecting: 'Đang kết nối lại' };
const MODE = { loop: 'Lặp vô hạn', once: 'Phát 1 lần', scheduled: 'Đặt lịch' };

// Dòng cho luồng ĐÃ kết thúc/dừng (trạng thái cuối)
function toRow(h, nameOf) {
  return [
    fmtVN(h.endedAt),
    nameOf(h.serverId) || h.serverId || '',
    h.id,
    h.name || '',
    h.ownerUsername || '',
    h.key || h.keyMask || '',
    MODE[h.mode] || h.mode || '',
    h.file || '',
    fmtVN(h.startedAt),
    fmtDur(h.durationSec),
    REASON[h.reason] || h.reason || '',
    h.detail || '',
    h.youtubeUrl || '',
    h.uid,
  ];
}

// Dòng cho luồng ĐANG hoạt động (cột "Kết thúc" để trống)
function toRunningRow(s, nameOf, now = Date.now()) {
  const started = s.firstLiveTime || null;
  const dur = started ? Math.round((now - Date.parse(started)) / 1000) : 0;
  return [
    '',
    nameOf(s.serverId) || s.serverId || '',
    s.id,
    s.name || '',
    s.ownerUsername || '',
    s.key || '',
    MODE[s.mode] || s.mode || '',
    s.file || '',
    fmtVN(started || s.createdAt),
    fmtDur(dur),
    RUNNING[s.status] || s.status || '',
    '',
    s.youtubeUrl || '',
    s.sessionUid,
  ];
}

function init({ userManager, clusterManager, isMaster, getLocalHistory, getLocalActive, nameOf }) {
  if (process.env.HISTORY_SHEET === '0') { console.log('[HistorySheet] Tắt (HISTORY_SHEET=0)'); return null; }
  let pushed = new Set();   // UID đã đẩy trạng thái CUỐI (không gửi lại nữa)
  let running = {};         // UID → { h: dấu nội dung, t: lần gửi cuối } của dòng đang chạy
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(d.pushed)) pushed = new Set(d.pushed);
    if (d.running && typeof d.running === 'object') running = d.running;
  } catch (_) {}
  const save = () => {
    try {
      const arr = Array.from(pushed).slice(-MAX_REMEMBER);
      pushed = new Set(arr);
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ pushed: arr, running }));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) { console.error('[HistorySheet] Lỗi lưu trạng thái:', e.message); }
  };

  let busy = false, lastWarn = '', lastWarnTs = 0;
  const warn = (msg) => {
    // Cùng 1 cảnh báo chỉ in lại sau 30 phút để không spam log
    if (msg === lastWarn && Date.now() - lastWarnTs < 30 * 60000) return;
    lastWarn = msg; lastWarnTs = Date.now();
    console.warn('[HistorySheet] ⚠️ ' + msg);
  };

  async function tick() {
    if (busy) return;
    if (!isMaster()) return;
    const cfg = userManager.getSheetConfig() || {};
    const url = String(process.env.HISTORY_SHEET_URL || cfg.googleSheetScriptUrl || '').trim();
    if (!/^https?:\/\//i.test(url) || /docs\.google\.com\/spreadsheets/i.test(url)) return; // chưa cài Web App (link CSV chỉ đọc được)
    busy = true;
    try {
      const now = Date.now();
      // 1) Luồng đang hoạt động (lấy TRƯỚC lịch sử để UID phiên mới được lưu ngay)
      let active = [];
      try { active = (getLocalActive ? getLocalActive() : []) || []; } catch (_) {}
      try { active = active.concat(await clusterManager.fetchAllRemoteStreams()); } catch (_) {}
      // 2) Lịch sử đã kết thúc
      let all = (getLocalHistory() || []).slice();
      try { all = all.concat(await clusterManager.fetchAllRemoteHistory()); } catch (_) {}

      const seen = new Set();
      const finals = all
        .filter(h => h && h.uid && !pushed.has(h.uid) && !seen.has(h.uid) && seen.add(h.uid))
        .sort((a, b) => (Date.parse(a.endedAt) || 0) - (Date.parse(b.endedAt) || 0))
        .map(h => ({ uid: h.uid, row: toRow(h, nameOf), final: true }));
      const finalUids = new Set(finals.map(f => f.uid));

      const runs = [];
      for (const s of active) {
        const uid = s && s.sessionUid;
        if (!uid || !KEY_ACTIVE.includes(s.status) || pushed.has(uid) || finalUids.has(uid) || seen.has(uid)) continue;
        seen.add(uid);
        const row = toRunningRow(s, nameOf, now);
        const h = JSON.stringify(row.filter((_, i) => i !== 9)); // bỏ cột thời lượng khi so thay đổi
        const prev = running[uid];
        if (prev && prev.h === h && now - prev.t < RUNNING_REFRESH) continue;
        runs.push({ uid, row, final: false, h });
      }

      const todo = finals.concat(runs).slice(0, PER_TICK); // trạng thái cuối được ưu tiên
      if (!todo.length) return;
      let sentFinal = 0, sentRun = 0, idx = 0;
      while (idx < todo.length) {
        // Lấy tối đa BATCH dòng; URL quá dài thì giảm dần số dòng
        let n = Math.min(BATCH, todo.length - idx), part, full;
        while (true) {
          part = todo.slice(idx, idx + n);
          const rows = JSON.stringify(part.map(p => p.row));
          full = `${url}${url.includes('?') ? '&' : '?'}action=appendHistory&secret=${encodeURIComponent(cfg.syncSecret || '')}&rows=${encodeURIComponent(rows)}`;
          if (full.length <= MAX_URL || n === 1) break;
          n = Math.ceil(n / 2);
        }
        const r = await userManager.fetchWithRedirect(full, 5);
        const d = r && r.data;
        if (!d || !d.ok) {
          const err = (d && d.error) || `mã ${r && r.statusCode}`;
          warn(/không hợp lệ/i.test(err)
            ? `Apps Script chưa có chức năng ghi lịch sử (${err}). Hãy dán bản google_apps_script.js mới và Triển khai lại.`
            : `Không ghi được lịch sử lên Sheet: ${err}`);
          break;
        }
        part.forEach(p => {
          if (p.final) { pushed.add(p.uid); delete running[p.uid]; sentFinal++; }
          else { running[p.uid] = { h: p.h, t: now }; sentRun++; }
        });
        idx += n;
      }
      // Dọn dấu dòng đang chạy quá cũ (luồng đã biến mất > 3 ngày mà không có kết quả cuối)
      for (const u of Object.keys(running)) if (now - (running[u].t || 0) > 3 * 86400000) delete running[u];
      if (sentFinal || sentRun) {
        save();
        console.log(`[HistorySheet] 📝 Tab LICH_SU_LUONG: ${sentFinal} dòng kết thúc, ${sentRun} dòng đang chạy`);
      }
    } catch (e) {
      warn('Lỗi kết nối Google Sheet: ' + e.message);
    } finally {
      busy = false;
    }
  }

  const every = parseInt(process.env.HISTORY_SHEET_INTERVAL_MS) || 60000;
  const t = setInterval(tick, every);
  if (t.unref) t.unref();
  setTimeout(tick, Math.min(15000, every)).unref();
  return { tick };
}

module.exports = { init, toRow, toRunningRow };
