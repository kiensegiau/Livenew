/**
 * driveQuota.js — Tự xử lý khi file Google Drive "HẾT LƯỢT TẢI" (Quota exceeded).
 *
 * Luồng xử lý:
 *  1. Tải bình thường. Nếu Google báo hết lượt tải (err.code === 'DRIVE_QUOTA'):
 *  2. Nhờ Apps Script tạo BẢN SAO TẠM của file — bản sao có lượt tải mới.
 *     - Danh sách Apps Script RIÊNG (google_apps_script_copy.js, có thể nhiều Gmail để dự phòng):
 *       cấu hình trên trang quản trị (sheet_config.json → driveCopyUrls) hoặc biến DRIVE_COPY_URLS (cách nhau dấu phẩy).
 *       Chia lần lượt (xoay vòng); script lỗi → tự thử script kế tiếp; script vừa lỗi bị đẩy xuống cuối 10 phút.
 *     - Chưa khai danh sách → dùng link Web App của Google Sheet (nếu bản Script đó có chức năng tạo bản sao).
 *     - Máy không có link nào (thường là Worker) → nhờ Master qua /api/cluster/drive-copy.
 *  3. Tải bản sao → LUÔN xóa bản sao (đúng script đã tạo) sau khi tải xong / tải lỗi.
 *     Script chỉ cho xóa bản sao tạm, không bao giờ xóa file gốc.
 *
 * Tắt tính năng: DRIVE_AUTO_COPY=0
 */
const { downloadGoogleDriveFile, extractDriveId } = require('./driveDownloader');

const COPY_TIMEOUT_MS = 6 * 60 * 1000 + 30000; // Apps Script chạy tối đa 6 phút
const DELETE_TIMEOUT_MS = 60000;
const CHECK_TIMEOUT_MS = 30000;
const FAIL_COOLDOWN_MS = 10 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{10,}$/;
const CHECK_ID = 'livenewcheck000000000000000';

let deps = { userManager: null, clusterManager: null, getLocalNodeId: () => '', log: console.log };
function init(d) { deps = { ...deps, ...d }; }

function enabled() { return process.env.DRIVE_AUTO_COPY !== '0'; }
const validUrl = u => /^https?:\/\//i.test(u) && !/docs\.google\.com\/spreadsheets/i.test(u); // link CSV/Sheet không chạy được Script

function cfg() { return (deps.userManager && deps.userManager.getSheetConfig()) || {}; }

// Chuẩn hoá danh sách link (mảng hoặc chuỗi nhiều dòng/dấu phẩy), bỏ trùng, bỏ link sai
function normalizeUrls(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  const out = [];
  for (const x of arr) { const u = String(x || '').trim(); if (u && validUrl(u) && !out.includes(u)) out.push(u); }
  return out;
}

// Danh sách Apps Script tạo bản sao RIÊNG
function copyUrls() {
  const env = String(process.env.DRIVE_COPY_URLS || process.env.DRIVE_COPY_URL || '').trim();
  return normalizeUrls(env || cfg().driveCopyUrls || []);
}
// Danh sách thực dùng tại máy này: riêng → (không có) Web App của Google Sheet
function localUrls() {
  const list = copyUrls();
  if (list.length) return list;
  const main = String(cfg().googleSheetScriptUrl || '').trim();
  return validUrl(main) ? [main] : [];
}

const label = (urls, u) => { const i = urls.indexOf(u); const m = String(u).match(/\/s\/([^/]+)\//); return `Script #${i + 1}${m ? ` (…${m[1].slice(-6)})` : ''}`; };

async function callOne(url, action, id, timeout) {
  const act = action === 'copy' ? 'copyDriveFile' : action === 'delete' ? 'deleteDriveCopy' : action;
  const full = `${url}${url.includes('?') ? '&' : '?'}action=${act}&id=${encodeURIComponent(id)}&secret=${encodeURIComponent(cfg().syncSecret || '')}`;
  const r = await deps.userManager.fetchWithRedirect(full, 5, timeout);
  const d = r && r.data;
  if (!d) throw new Error(r && r.statusCode === 403 ? 'Bị từ chối (403) — bản triển khai phải để "Ai có quyền truy cập: Bất kỳ ai"' : `Trả về không phải JSON (mã ${r && r.statusCode})`);
  if (d.error && /Hành động không hợp lệ/i.test(d.error)) {
    throw new Error('Script chưa có chức năng tạo bản sao (dán google_apps_script_copy.js, chạy capQuyenDrive() và Triển khai lại)');
  }
  return d;
}

const failedAt = new Map(); // url -> thời điểm lỗi gần nhất
const owner = new Map();    // copyId -> url đã tạo (để xóa đúng script)
let rr = 0;

// Gọi Apps Script tại máy này (không chuyển tiếp). action: 'copy' | 'delete'. src: link đã tạo bản sao (khi xóa)
async function callScriptLocal(action, id, src) {
  if (!['copy', 'delete'].includes(action)) throw new Error('Hành động không hợp lệ');
  if (!ID_RE.test(String(id || ''))) throw new Error('ID file Drive không hợp lệ');
  const urls = localUrls();
  if (!urls.length) throw new Error('Chưa cài link Apps Script tạo bản sao (trang quản trị → Apps Script tạo bản sao)');

  if (action === 'copy') {
    const now = Date.now();
    const start = rr++ % urls.length;
    const rotated = urls.slice(start).concat(urls.slice(0, start));
    // Script vừa lỗi trong 10 phút → thử sau cùng
    const order = rotated.filter(u => !(now - (failedAt.get(u) || 0) < FAIL_COOLDOWN_MS))
      .concat(rotated.filter(u => now - (failedAt.get(u) || 0) < FAIL_COOLDOWN_MS));
    const errors = [];
    for (const u of order) {
      try {
        const d = await callOne(u, 'copy', id, COPY_TIMEOUT_MS);
        if (d && d.ok && d.copyId) {
          failedAt.delete(u);
          owner.set(d.copyId, u);
          if (owner.size > 500) owner.delete(owner.keys().next().value);
          return { ...d, src: u, via: label(urls, u) };
        }
        throw new Error((d && d.error) || 'không trả về bản sao');
      } catch (e) {
        failedAt.set(u, Date.now());
        errors.push(`${label(urls, u)}: ${e.message}`);
        deps.log(`[DriveQuota] ⚠️ ${label(urls, u)} tạo bản sao lỗi: ${e.message}`);
      }
    }
    return { error: errors.join(' | ') };
  }

  // delete: xóa đúng script đã tạo; không rõ thì hỏi lần lượt mọi script (script khác chủ trả "File không còn")
  const known = (src && urls.includes(src) && src) || owner.get(id);
  const targets = known ? [known] : urls;
  let last = null;
  const errors = [];
  for (const u of targets) {
    try {
      const d = await callOne(u, 'delete', id, DELETE_TIMEOUT_MS);
      if (d && d.ok && d.result) { owner.delete(id); return { ...d, via: label(urls, u) }; }
      if (d && d.error) errors.push(`${label(urls, u)}: ${d.error}`); else last = d;
    } catch (e) { errors.push(`${label(urls, u)}: ${e.message}`); }
  }
  if (errors.length && !last) return { error: errors.join(' | ') };
  owner.delete(id);
  return last || { ok: true, note: 'File không còn' };
}

// Gọi Apps Script: ưu tiên tại máy này, chưa có link thì nhờ Master
async function callScript(action, id, src) {
  if (localUrls().length) return callScriptLocal(action, id, src);
  const cm = deps.clusterManager;
  const localId = deps.getLocalNodeId();
  const master = cm && cm.getNodes().find(n => n.isMaster && n.id !== localId);
  if (!master) throw new Error('Chưa cài link Apps Script tạo bản sao (trang quản trị → Apps Script tạo bản sao)');
  const timeout = (action === 'copy' ? COPY_TIMEOUT_MS * 2 : DELETE_TIMEOUT_MS * 3) + 15000;
  const r = await cm.callNodeApi(master, '/api/cluster/drive-copy', 'POST', { action, id, src }, timeout);
  if (!r || !r.data) throw new Error(`Master không phản hồi (mã ${r && r.statusCode})`);
  if (r.statusCode !== 200 && !r.data.error) throw new Error(`Master trả mã ${r.statusCode}`);
  return r.data;
}

// Kiểm tra từng Apps Script tạo bản sao (không tạo file nào): đúng secret? có chức năng? truy cập được?
async function checkScripts(urlsArg) {
  const urls = urlsArg ? normalizeUrls(urlsArg) : localUrls();
  return Promise.all(urls.map(async (u) => {
    const t = Date.now();
    try {
      const d = await callOne(u, 'delete', CHECK_ID, CHECK_TIMEOUT_MS);
      if (d && d.ok) return { url: u, label: label(urls, u), ok: true, ms: Date.now() - t };
      return { url: u, label: label(urls, u), ok: false, error: (d && d.error) || 'Phản hồi lạ', ms: Date.now() - t };
    } catch (e) {
      return { url: u, label: label(urls, u), ok: false, error: e.message, ms: Date.now() - t };
    }
  }));
}

function quotaFail(origErr, reason) {
  const e = new Error(`File Drive đã hết lượt tải hôm nay và KHÔNG tự tạo được bản sao (${reason}). 👉 Cách sửa: tạo bản sao file trên Drive thủ công rồi dùng link bản sao.`);
  e.code = 'DRIVE_QUOTA';
  e.cause = origErr;
  return e;
}

/**
 * Tải file Drive, tự tạo bản sao khi hết lượt tải.
 * opts.onStatus(stage, info): stage = 'quota' | 'copied' | 'deleted' | 'delete_failed'
 */
async function downloadWithQuotaFallback(driveUrl, destDir, onProgress, opts = {}) {
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
  try {
    return await downloadGoogleDriveFile(driveUrl, destDir, onProgress);
  } catch (err) {
    if (!err || err.code !== 'DRIVE_QUOTA' || !enabled()) throw err;
    const id = extractDriveId(driveUrl);
    if (!id) throw err;
    deps.log(`[DriveQuota] ⚠️ File ${id} hết lượt tải → nhờ Apps Script tạo bản sao tạm...`);
    try { onStatus('quota', { id }); } catch (_) {}

    let copy;
    try { copy = await callScript('copy', id); }
    catch (e) { throw quotaFail(err, e.message); }
    if (!copy || !copy.ok || !copy.copyId) throw quotaFail(err, (copy && copy.error) || 'Apps Script không trả về bản sao');

    deps.log(`[DriveQuota] ✅ ${copy.via || 'Apps Script'} đã tạo bản sao ${copy.copyId} (${copy.name || ''}) → tải bản sao...`);
    try { onStatus('copied', copy); } catch (_) {}
    try {
      return await downloadGoogleDriveFile(`https://drive.google.com/file/d/${copy.copyId}/view`, destDir, onProgress);
    } finally {
      // Luôn xóa bản sao (không chờ để live sớm hơn); bản sao sót lại sẽ được Script tự dọn sau 6 giờ
      callScript('delete', copy.copyId, copy.src)
        .then(d => {
          if (d && d.ok) { deps.log(`[DriveQuota] 🗑️ Đã xóa bản sao tạm ${copy.copyId}${d.result ? ` (${d.result})` : ''}`); try { onStatus('deleted', copy); } catch (_) {} }
          else throw new Error((d && d.error) || 'không rõ');
        })
        .catch(e => { deps.log(`[DriveQuota] ⚠️ Không xóa được bản sao tạm ${copy.copyId}: ${e.message}`); try { onStatus('delete_failed', { ...copy, error: e.message }); } catch (_) {} });
    }
  }
}

module.exports = { init, downloadWithQuotaFallback, callScriptLocal, checkScripts, normalizeUrls, copyUrls, ID_RE };
