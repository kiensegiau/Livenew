const http = require('http');
const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Tự động dọn dẹp các tiến trình FFmpeg "ma" khi khởi động ---
try {
    if (process.env.SKIP_FFMPEG_CLEANUP === '1') throw new Error('skip');
    console.log('[System] Đang kiểm tra và dọn dẹp các luồng FFmpeg cũ để tránh chồng chéo...');
    if (os.platform() === 'win32') {
        execSync('taskkill /F /IM ffmpeg.exe /T', { stdio: 'ignore' });
    } else {
        execSync('pkill -9 ffmpeg', { stdio: 'ignore' });
    }
    console.log('[System] Dọn dẹp hoàn tất. Hệ thống sẵn sàng!');
} catch (e) {
    // Không có tiến trình nào đang chạy, bỏ qua lỗi
}
const { downloadGoogleDriveFile, extractDriveId } = require('./driveDownloader');
const { initBot, broadcast, broadcastLocal, updateProgress, sendToZalo, sendToZaloLocal, setNotifyRouter, setNodeRole, formatClusterReport } = require('./telegramBot');
const userManager = require('./userManager');
const clusterManager = require('./clusterManager');
// Drive "hết lượt tải" → tự tạo bản sao tạm qua Apps Script rồi tải bản sao (tắt: DRIVE_AUTO_COPY=0)
const driveQuota = require('./driveQuota');
const diagnostics = require('./diagnostics');
driveQuota.init({ userManager, clusterManager, getLocalNodeId: () => localNodeId });

const PORT = parseInt(process.env.PORT) || 3131;

// Khóa theo từng khách: xếp hàng các lệnh Start đồng thời để kiểm tra quota không bị vượt (race condition)
const userLocks = new Map();
function acquireUserLock(key) {
  const prev = userLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  const tail = prev.then(() => next);
  userLocks.set(key, tail);
  tail.then(() => { if (userLocks.get(key) === tail) userLocks.delete(key); });
  let done = false;
  const once = () => { if (!done) { done = true; release(); } };
  return prev.then(() => once);
}

// Khách thường chỉ thấy tên + trạng thái của các máy chủ được phép (không IP/port, không thông số CPU/RAM/đĩa/mạng)
function publicNodes(nodes, user) {
  if (user && user.role === 'admin') return nodes;
  const allowed = ((user && user.allowedServers) || ['all']).map(x => String(x).toLowerCase());
  const canAll = allowed.includes('all');
  return nodes
    .filter(n => canAll || allowed.includes(String(n.id).toLowerCase()))
    .map(n => ({ id: n.id, name: n.name, isMaster: !!n.isMaster, isLocal: !!n.isLocal, status: n.isLocal ? 'online' : (n.status || 'unknown') }));
}

// Kiểm tra quyền sở hữu stream trên node khác (admin luôn qua)
async function remoteOwnerOk(nodeId, streamId, user) {
  if (user && user.role === 'admin') return true;
  try {
    const list = await clusterManager.fetchRemoteStreams(nodeId);
    const st = (list || []).find(x => x.id === streamId);
    if (!st) return false;
    return st.ownerId === user.id || st.ownerUsername === user.username;
  } catch (_) { return false; }
}
const streams = new Map();
const BACKUP_FILE = path.join(__dirname, 'streams_backup.json');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

// Biến lưu trữ hiệu số thời gian CPU phục vụ tính toán chính xác 100% tài nguyên
let lastCpuTimes = null;
let lastCpuPct = 15;

// Biến lưu trữ hiệu số thời gian và lưu lượng mạng phục vụ tính toán chính xác 100% tài nguyên
let lastNetTime = null;
let lastRxBytes = null;
let lastTxBytes = null;
let lastNetRxStr = '0 Kbps';
let lastNetTxStr = '0 Kbps';

// Đảm bảo thư mục downloads tồn tại
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function escapeMarkdown(text) {
  if (!text) return '';
  return text.toString().replace(/[*_`\[]/g, '\\$&');
}

// --- Lịch sử luồng (mỗi máy lưu lịch sử của chính nó; Master gom lại khi xem) ---
const HISTORY_FILE = path.join(__dirname, 'history.json');
const HISTORY_MAX = 5000;
const HISTORY_DAYS = parseInt(process.env.HISTORY_DAYS) || 90;
let history = [];
let historySaveTimer = null;

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (Array.isArray(data)) history = data;
    }
  } catch (e) { console.error('[History] Lỗi đọc history.json:', e.message); }
}

function trimHistory() {
  const cutoff = Date.now() - HISTORY_DAYS * 86400000;
  history = history.filter(h => !h.endedAt || Date.parse(h.endedAt) >= cutoff);
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
}

function flushHistory() {
  if (historySaveTimer) { clearTimeout(historySaveTimer); historySaveTimer = null; }
  try {
    trimHistory();
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) { console.error('[History] Lỗi ghi history.json:', e.message); }
}

function scheduleHistorySave() {
  if (historySaveTimer) return;
  historySaveTimer = setTimeout(flushHistory, 1500);
  if (historySaveTimer.unref) historySaveTimer.unref();
}

['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
  try { captureFinished(); } catch (_) {}
  flushHistory();
  process.exit(0);
}));

// Che stream key / URL RTMP trong log trước khi lưu
function redactLog(text, key) {
  let t = String(text || '');
  if (key) t = t.split(key).join('****');
  return t.replace(/rtmps?:\/\/[^\s"']+/gi, 'rtmp://***').slice(0, 200);
}

// Ghi 1 dòng lịch sử (chỉ 1 lần) khi luồng đã dừng/kết thúc
function recordFinished(s) {
  if (!s) return;
  // Mốc thời gian luồng dừng/kết thúc THẬT (dùng cho tự dọn: chừa luồng vừa dừng, xóa luồng dừng lâu)
  if ((s.status === 'stopped' || s.status === 'ended') && !s._doneSince) s._doneSince = Date.now();
  if (s._histLogged) return;
  if (s.status !== 'stopped' && s.status !== 'ended') return;
  s._histLogged = true;
  const endedAt = new Date().toISOString();
  const startedAt = s.firstLiveTime || null;
  const durationSec = startedAt ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)) : 0;
  let reason = 'finished';
  if (s.status === 'stopped') reason = 'stopped';
  else if (/^Hoàn thành/i.test(s.lastLog || '')) reason = 'finished';
  else if (s._exitCode === 0) reason = 'finished';
  else reason = 'error';
  const src = s.originalFile || s.file || '';
  const fileName = /^https?:/i.test(src) ? (/drive\.google/i.test(src) ? 'Google Drive Video' : 'Link video') : path.basename(src);
  history.push({
    // Cùng UID với dòng "đang chạy" trên Google Sheet → Sheet sửa đúng dòng đó thành kết quả cuối
    uid: s.sessionUid || `${s.serverId || localNodeId}-${s.id}-${Date.parse(endedAt)}`,
    id: s.id,
    name: s.name || '',
    keyMask: s.key ? '••••' + String(s.key).slice(-4) : '',
    key: s.key || '',
    ownerId: s.ownerId || 'admin_root',
    ownerUsername: s.ownerUsername || 'admin',
    serverId: s.serverId || localNodeId,
    mode: s.mode,
    dualStream: !!s.dualStream,
    file: fileName,
    youtubeUrl: s.youtubeUrl || '',
    createdAt: s.createdAt || null,
    startedAt,
    endedAt,
    durationSec,
    reason,
    detail: reason === 'error' ? redactLog(s.lastLog, s.key) : ''
  });
  delete s.sessionUid; // chạy lại sau này = phiên mới = dòng mới
  scheduleHistorySave();
}

// Mỗi lần phát (từ lúc hoạt động tới lúc dừng/kết thúc) có 1 UID phiên, lưu cùng luồng (sống qua khởi động lại)
function ensureSession(s) {
  if (s && !s.sessionUid && KEY_ACTIVE_STATUSES.includes(s.status)) {
    s.sessionUid = `${s.serverId || localNodeId}-${s.id}-${Date.now()}`;
  }
  return s && s.sessionUid;
}

// Quét toàn bộ luồng, ghi lịch sử cho các luồng vừa kết thúc mà chưa được ghi
function captureFinished() {
  for (const s of streams.values()) {
    if (s.status !== 'stopped' && s.status !== 'ended') { if (s._histLogged) delete s._histLogged; delete s._doneSince; ensureSession(s); continue; }
    recordFinished(s);
  }
}

// --- Persistence Logic ---
function saveStreams() {
  try { captureFinished(); } catch (e) { console.error('[History] Lỗi ghi lịch sử:', e.message); }
  const data = Array.from(streams.values()).map(s => ({
    id: s.id, key: s.key, file: s.file, originalFile: s.originalFile || s.file, mode: s.mode, minutes: s.minutes, 
    scheduledTime: s.scheduledTime, scheduledMode: s.scheduledMode, status: s.status, dualStream: !!s.dualStream,
    name: s.name || '',
    youtubeUrl: s.youtubeUrl || '',
    ownerId: s.ownerId || 'admin_root',
    ownerUsername: s.ownerUsername || 'admin',
    serverId: s.serverId || localNodeId,
    createdAt: s.createdAt || null,
    updatedAt: s.updatedAt || null,
    firstLiveTime: s.firstLiveTime || null,
    sessionUid: s.sessionUid || null
  }));
  const tmp = BACKUP_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, BACKUP_FILE);
}

function loadStreams() {
  if (fs.existsSync(BACKUP_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
      data.forEach(s => {
        // Khôi phục các luồng chưa kết thúc (bỏ qua nếu ID đã có trong bộ nhớ → không chạy/tải trùng)
        if (streams.has(s.id)) { nextId = Math.max(nextId, s.id + 1); return; }
        if (['live', 'scheduled', 'reconnecting', 'launching', 'downloading'].includes(s.status)) {
          streams.set(s.id, { 
            ...s, 
            ownerId: s.ownerId || 'admin_root',
            ownerUsername: s.ownerUsername || 'admin',
            serverId: s.serverId || localNodeId,
            process: null, pid: null, retryCount: 0, lastLog: 'Đang khôi phục...' 
          });
          nextId = Math.max(nextId, s.id + 1);
          
          if (s.status === 'downloading') {
              // Nếu đang tải dở lúc sập mạng -> bắt buộc tải lại
              startStream({ 
                key: s.key, file: s.originalFile || s.file, mode: s.mode, minutes: s.minutes, 
                scheduledTime: s.scheduledTime, scheduledMode: s.scheduledMode, id: s.id, 
                dualStream: s.dualStream, name: s.name, youtubeUrl: s.youtubeUrl, 
                ownerId: s.ownerId || 'admin_root', ownerUsername: s.ownerUsername || 'admin', serverId: s.serverId || localNodeId,
                createdAt: s.createdAt, updatedAt: s.updatedAt 
              });
          } else if (s.status === 'scheduled') {
              // Video Drive mà file tạm đã mất (hoặc chưa tải) -> tải lại rồi mới hẹn giờ, tránh tới giờ phát mới báo thiếu file
              if (needsDriveDownload(streams.get(s.id))) redownloadFromDrive(streams.get(s.id));
              else proceedStartStream(s.id);
          } else {
              // Nếu file video cục bộ vẫn còn -> DÙNG LẠI LUÔN, KHÔNG TẢI LẠI
              if (s.file && fs.existsSync(s.file)) {
                  launchFFmpeg(s.id, s.key, s.file, s.mode, s.minutes);
              } 
              // Nếu file bị xóa mất nhưng có link gốc -> tải lại để cứu rỗi
              else if (s.originalFile && s.originalFile.startsWith('http')) {
                  startStream({ 
                    key: s.key, file: s.originalFile, mode: s.mode, minutes: s.minutes, 
                    scheduledTime: s.scheduledTime, scheduledMode: s.scheduledMode, id: s.id, 
                    dualStream: s.dualStream, name: s.name, youtubeUrl: s.youtubeUrl, 
                    ownerId: s.ownerId || 'admin_root', ownerUsername: s.ownerUsername || 'admin', serverId: s.serverId || localNodeId,
                    createdAt: s.createdAt, updatedAt: s.updatedAt 
                  });
              } 
              // Các trường hợp khác
              else {
                  launchFFmpeg(s.id, s.key, s.file, s.mode, s.minutes);
              }
          }
        }
      });
      console.log(`[System] ♻️ Đã khôi phục ${streams.size} luồng từ bản sao lưu.`);
    } catch (e) { console.error('[System] Lỗi đọc backup:', e.message); }
  }
}

function cleanupOrphanedFiles(minAgeMs = 60 * 60 * 1000) {
  console.log('[System] 🧹 Đang quét dọn dẹp tự động các file video tạm không sử dụng...');
  if (!fs.existsSync(DOWNLOAD_DIR)) return;
  
  fs.readdir(DOWNLOAD_DIR, (err, files) => {
    if (err) return console.error('[Cleanup] Không thể đọc thư mục downloads:', err.message);
    
    // Tập file đang được dùng bởi BẤT KỲ luồng nào còn trong map (kể cả đã dừng - có thể bật lại). Tính lại mỗi lần gọi để tránh race.
    const getActiveFiles = () => {
      const set = new Set();
      for (const s of streams.values()) {
        if (s.file) set.add(path.resolve(s.file));
        if (s.originalFile) set.add(path.resolve(s.originalFile));
      }
      return set;
    };
    const activeFiles = getActiveFiles();
    // Đang có luồng tải Drive -> file/thư mục tạm của nó (temp_chunks_*, file đích chưa gắn vào luồng) KHÔNG được động tới
    const downloading = Array.from(streams.values()).some(s => s.status === 'downloading');
    
    files.forEach(file => {
      if (file === '.gitkeep') return;
      const fullPath = path.join(DOWNLOAD_DIR, file);
      const resolvedPath = path.resolve(fullPath);
      
      // Nếu file không thuộc bất kỳ luồng hoạt động nào -> XEM XÉT XÓA!
      if (!activeFiles.has(resolvedPath)) {
        fs.stat(fullPath, (err, stats) => {
          if (err) return;
          const ageInMs = Date.now() - stats.mtime.getTime();
          // Bỏ qua các file/thư mục mới tải hoặc sửa đổi chưa đủ minAgeMs (mặc định 60 phút; dọn khẩn cấp: 5 phút)
          if (ageInMs < minAgeMs) {
            return;
          }
          // Đang tải Drive: không xóa thư mục chunk tạm và mọi thư mục/file chưa quá 6 giờ (tải lớn/chậm có thể không đổi mtime)
          if (downloading && (/^temp_chunks_/.test(file) || ageInMs < 6 * 3600 * 1000)) {
            return;
          }
          // Kiểm tra lại NGAY trước khi xóa: luồng có thể vừa được tạo/gắn file trong lúc chờ fs.stat
          if (getActiveFiles().has(resolvedPath)) return;
          // Giữ cả thư mục nếu có luồng đang dùng file nằm bên trong
          const dirPrefix = resolvedPath + path.sep;
          if (stats.isDirectory() && Array.from(getActiveFiles()).some(f => f.startsWith(dirPrefix))) return;
          
          if (stats.isDirectory()) {
            fs.rm(fullPath, { recursive: true, force: true }, (err) => {
              if (err) {
                console.error(`[Cleanup] Lỗi tự động xóa thư mục mồ côi ${file}:`, err.message);
              } else {
                console.log(`[Cleanup] ✅ Tự động dọn dẹp thư mục rác mồ côi: ${file}`);
              }
            });
          } else {
            fs.unlink(fullPath, (err) => {
              if (err) {
                console.error(`[Cleanup] Lỗi tự động xóa file mồ côi ${file}:`, err.message);
              } else {
                console.log(`[Cleanup] ✅ Tự động dọn dẹp file rác mồ côi: ${file}`);
              }
            });
          }
        });
      }
    });
  });
}

// Tự động xóa các luồng ĐÃ KẾT THÚC/ĐÃ DỪNG quá FINISHED_TTL_HOURS (mặc định 6 giờ) cùng file video tạm của chúng
const FINISHED_TTL_MS = (parseFloat(process.env.FINISHED_TTL_HOURS) || 6) * 3600 * 1000;
function purgeFinishedStreams(ttlMs = FINISHED_TTL_MS) {
  try { captureFinished(); } catch (_) {}
  const now = Date.now();
  let purged = 0;
  for (const [id, s] of Array.from(streams.entries())) {
    if (s.status !== 'stopped' && s.status !== 'ended') { delete s._doneSince; continue; }
    if (!s._doneSince) { s._doneSince = now; if (ttlMs > 0) continue; }
    if (now - s._doneSince < ttlMs) continue;
    // Chỉ xóa file nếu không còn luồng nào KHÁC (bất kỳ trạng thái, kể cả đã dừng chờ bật lại) đang dùng chung file đó
    const mine = [s.file, s.originalFile].filter(Boolean).map(f => path.resolve(f));
    const inUse = Array.from(streams.values()).some(o => o !== s && [o.file, o.originalFile].filter(Boolean).some(f => mine.includes(path.resolve(f))));
    if (!inUse) cleanupFile(s.file);
    streams.delete(id);
    purged++;
  }
  if (purged > 0) {
    console.log(`[Cleanup] 🧹 Tự động dọn ${purged} luồng đã kết thúc quá ${Math.round(ttlMs / 60000)} phút.`);
    saveStreams();
  }
  return purged;
}

// DỌN DẸP CUỐI NGÀY: đúng DAILY_CLEAN_TIME (giờ Việt Nam, mặc định 23:59) mỗi máy tự xóa MỌI luồng đã dừng/kết thúc
// (chừa luồng vừa dừng < DAILY_CLEAN_KEEP_MIN phút, mặc định 10) + file video tạm mồ côi. KHÔNG đụng luồng đang live / đặt lịch / đang tải.
// Lịch sử vẫn được ghi trước khi xóa. Tắt: DAILY_CLEAN=0
const DAILY_CLEAN_TIME = (() => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(process.env.DAILY_CLEAN_TIME || '').trim());
  if (m && +m[1] < 24 && +m[2] < 60) return `${m[1].padStart(2, '0')}:${m[2]}`;
  if (process.env.DAILY_CLEAN_TIME) console.warn(`[Cleanup] DAILY_CLEAN_TIME="${process.env.DAILY_CLEAN_TIME}" không hợp lệ (cần HH:MM) → dùng 23:59`);
  return '23:59';
})();
const DAILY_CLEAN_KEEP_MS = (parseFloat(process.env.DAILY_CLEAN_KEEP_MIN) >= 0 ? parseFloat(process.env.DAILY_CLEAN_KEEP_MIN) : 10) * 60 * 1000;
let _dailyCleanDay = null;
function vnClock(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10) };
}
function dailyCleanup(force = false) {
  if (process.env.DAILY_CLEAN === '0' && !force) return null;
  const now = vnClock();
  const [h, m] = DAILY_CLEAN_TIME.split(':').map(Number);
  if (!force && (now.minutes < h * 60 + m || _dailyCleanDay === now.day)) return null;
  _dailyCleanDay = now.day;
  let purged = 0;
  try { purged = purgeFinishedStreams(DAILY_CLEAN_KEEP_MS); } catch (e) { console.error('[Cleanup] cuối ngày:', e.message); }
  try { cleanupOrphanedFiles(5 * 60 * 1000); } catch (e) { console.error('[Cleanup] orphan:', e.message); }
  console.log(`[Cleanup] 🌙 Dọn dẹp cuối ngày ${now.day}: xóa ${purged} luồng không còn dùng.`);
  if (purged > 0) {
    const msg = `🌙 *DỌN DẸP CUỐI NGÀY* - ${escapeMarkdown(String(localNodeId))}\n━━━━━━━━━━━━━━━━━━\n🗑️ Đã xóa *${purged}* luồng đã dừng/kết thúc cùng file video tạm.\n✅ Luồng đang live / đặt lịch không bị đụng tới. Lịch sử vẫn được lưu.`;
    try { broadcast(msg); } catch (_) {}
  }
  return purged;
}

// Dọn khẩn cấp khi ổ đĩa gần đầy: xóa ngay file mồ côi (>5 phút) + luồng đã dừng/kết thúc (không chờ TTL). Không đụng luồng đang chạy.
const DISK_CLEAN_PCT = parseInt(process.env.DISK_CLEAN_PCT, 10) || 85;
const RAM_WARN_PCT = parseInt(process.env.RAM_WARN_PCT, 10) || 92;
let _lastEmergencyAt = 0, _lastRamWarnAt = 0;
function emergencyCleanup(reason) {
  console.warn(`[Cleanup] 🚨 Dọn khẩn cấp (${reason})`);
  try { purgeFinishedStreams(10 * 60 * 1000); } catch (e) { console.error('[Cleanup] purge:', e.message); } // giữ luồng vừa dừng <10 phút (user có thể bật lại)
  try { cleanupOrphanedFiles(5 * 60 * 1000); } catch (e) { console.error('[Cleanup] orphan:', e.message); }
}
function monitorResources() {
  try {
    const si = sysinfoFn ? sysinfoFn() : null;
    if (!si) return;
    const now = Date.now();
    if (typeof si.diskUsage === 'number' && si.diskUsage >= DISK_CLEAN_PCT && now - _lastEmergencyAt > 5 * 60 * 1000) {
      _lastEmergencyAt = now;
      emergencyCleanup(`ổ đĩa ${si.diskUsage}% ≥ ${DISK_CLEAN_PCT}%`);
      const m = `🧹 *DỌN DẸP KHẨN CẤP* - ${escapeMarkdown(String(localNodeId))}\n━━━━━━━━━━━━━━━━━━\n💾 Ổ đĩa: *${si.diskUsage}%* (ngưỡng dọn ${DISK_CLEAN_PCT}%)\n🗑️ Đã xóa file tạm mồ côi & luồng đã dừng.\n⛔ Từ ${process.env.MAX_DISK_PCT || 95}% máy sẽ từ chối luồng mới.`;
      try { broadcast(m); } catch (_) {}
      try { sendToZalo(m); } catch (_) {}
    }
    if (typeof si.ramUsage === 'number' && si.ramUsage >= RAM_WARN_PCT && now - _lastRamWarnAt > 30 * 60 * 1000) {
      _lastRamWarnAt = now;
      const m = `⚠️ *RAM CAO* - ${escapeMarkdown(String(localNodeId))}: *${si.ramUsage}%* (ngưỡng cảnh báo ${RAM_WARN_PCT}%). Máy sẽ từ chối luồng mới khi đạt giới hạn; các luồng đang chạy không bị ảnh hưởng.`;
      console.warn(m);
      try { broadcast(m); } catch (_) {}
      try { sendToZalo(m); } catch (_) {}
    }
  } catch (e) { console.error('[Cleanup] monitorResources:', e.message); }
}

// Xóa file tạm sau khi luồng kết thúc (sử dụng hàm có retry thông minh bên dưới)

async function checkFFmpeg() {
  const localFF = path.join(__dirname, 'ffmpeg.exe');
  const cmd = fs.existsSync(localFF) ? `"${localFF}" -version` : 'ffmpeg -version';
  
  return new Promise((resolve) => {
    exec(cmd, (err) => {
      if (err) {
        console.error('\n❌ LỖI: Không tìm thấy FFmpeg!');
        console.log('👉 Cách sửa: Copy file ffmpeg.exe vào thư mục này hoặc cài đặt FFmpeg vào máy.\n');
        resolve(false);
      } else {
        console.log(`[System] ✅ Kiểm tra FFmpeg: Sẵn sàng (${fs.existsSync(localFF) ? 'Bản tại chỗ' : 'Bản hệ thống'}).`);
        resolve(true);
      }
    });
  });
}

let nextId = 1;

// ─── File Browse Dialog (PowerShell → temp file) ────────────────────────────
function browseFile() {
  return new Promise((resolve) => {
    if (os.platform() !== 'win32') {
      console.log('[System] Chức năng chọn file qua cửa sổ không hỗ trợ trên Linux (VPS).');
      resolve('');
      return;
    }

    const tmpOut = path.join(os.tmpdir(), `yt_browse_${Date.now()}.txt`);
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[System.Windows.Forms.Application]::EnableVisualStyles()',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      "$d.Filter = 'Video Files|*.mp4;*.mkv;*.avi'",
      "$d.Title = 'Chon file Video'",
      `if ($d.ShowDialog() -eq 'OK') { [System.IO.File]::WriteAllText('${tmpOut.replace(/\\/g, '\\\\')}', $d.FileName) }`
    ].join('; ');

    // Không pipe stdio → PowerShell có window thật, Windows không chặn focus
    const ps = spawn('powershell', ['-STA', '-NoProfile', '-Command', script], {
      windowsHide: false,
      stdio: 'ignore'
    });

    ps.on('error', (err) => {
      console.error('[System] Không thể chạy PowerShell:', err.message);
      resolve('');
    });

    ps.on('close', () => {
      try {
        const result = fs.existsSync(tmpOut)
          ? fs.readFileSync(tmpOut, 'utf8').trim()
          : '';
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
        resolve(result);
      } catch (_) { resolve(''); }
    });
  });
}

function cleanupFile(filePath, retryCount = 0) {
  if (!filePath) return;
  // Chỉ xóa file do hệ thống tự tải về (thư mục downloads hoặc tiền tố drive_video_). Tuyệt đối không xóa file của người dùng nằm ở nơi khác (kể cả thư mục Temp)
  const resolved = path.resolve(filePath);
  const dlRoot = path.resolve(DOWNLOAD_DIR) + path.sep;
  const isTemp = resolved.startsWith(dlRoot) || path.basename(filePath).startsWith('drive_video_');
  if (isTemp && fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) {
        if (err.code === 'EBUSY' && retryCount < 3) {
          console.log(`[Cleanup] File đang bận, thử lại lần ${retryCount + 1} sau 3s...`);
          setTimeout(() => cleanupFile(filePath, retryCount + 1), 3000);
        } else {
          console.error(`[Cleanup] Lỗi xóa file ${filePath}:`, err.message);
        }
      } else {
        console.log(`[Cleanup] Đã xóa file tạm: ${filePath}`);
      }
    });
  }
}

// Xóa file video tạm ngay khi luồng kết thúc/dừng (giải phóng đĩa). Chỉ xóa file do hệ thống tải về trong downloads/ (cleanupFile đã chặn file khác),
// và chỉ khi KHÔNG còn luồng nào khác dùng chung file. Đặt KEEP_FILES_AFTER_LIVE=1 để giữ lại như cũ.
function releaseStreamFile(id, why) {
  if (process.env.KEEP_FILES_AFTER_LIVE === '1') return;
  const s = streams.get(id);
  if (!s || s._fileReleased) return;
  const mine = [s.file, s.originalFile].filter(Boolean).map(f => path.resolve(f));
  const shared = Array.from(streams.values()).some(o => o !== s && [o.file, o.originalFile].filter(Boolean).some(f => mine.includes(path.resolve(f))));
  if (shared) return;
  const resolved = s.file ? path.resolve(s.file) : '';
  const isOurs = resolved.startsWith(path.resolve(DOWNLOAD_DIR) + path.sep) || (s.file && path.basename(s.file).startsWith('drive_video_'));
  if (!isOurs) return;
  s._fileReleased = true;
  console.log(`[Cleanup] 🧹 Live xong (${why}) → dọn file tạm của luồng #${id}`);
  cleanupFile(s.file);
}

// ─── Launch FFmpeg ────────────────────────────────────────────────────────────
function launchFFmpeg(id, key, file, mode, minutes) {
  let info = streams.get(id);
  // Kiểm tra file tồn tại trước khi chạy
  if (!file || !fs.existsSync(file)) {
    console.error(`[Stream #${id}] ❌ Lỗi: File video không tồn tại tại: ${file}`);
    const telegramName = info && info.name ? `🏷️ Luồng: *${escapeMarkdown(info.name)}*\n` : '';
    broadcast(`🔴 *LUỒNG #${id} THẤT BẠI!*\n━━━━━━━━━━━━━━━━━━\n${telegramName}Lỗi: Không tìm thấy file video trên ổ đĩa.`);
    if (info) info.status = 'ended';
    return;
  }

  if (!info) return; // Luồng đã bị xóa trước khi kịp chạy

  info.lastLog = 'Đang khởi chạy luồng phát...';

  // Khởi tạo thời gian Live đầu tiên nếu có giới hạn phút
  const totalMins = Math.max(0, parseInt(minutes) || 0);
  let minsToRun = totalMins;

  if (totalMins > 0) {
    if (!info.firstLiveTime) {
      info.firstLiveTime = new Date().toISOString();
      saveStreams();
    } else {
      const elapsedMins = (Date.now() - new Date(info.firstLiveTime).getTime()) / 60000;
      const remainingMins = totalMins - elapsedMins;
      if (remainingMins <= 0.1) {
        console.log(`[Stream #${id}] 🏁 Hết thời lượng giới hạn (${totalMins} phút). Dừng luồng.`);
        info.status = 'ended';
        info.lastLog = `Hoàn thành thời lượng phát ${totalMins} phút.`;
        const displayName = info.name ? `🏷️ Luồng: *${escapeMarkdown(info.name)}*\n` : '';
        broadcast(`⚪ *LUỒNG #${id} KẾT THÚC BÌNH THƯỜNG*\n━━━━━━━━━━━━━━━━━━\n${displayName}🎞 Video: \`${path.basename(info.file)}\`\n⏱ Thời lượng: \`${totalMins} phút (Đã phát xong)\``);
        saveStreams();
        return;
      }
      minsToRun = Math.max(1, Math.round(remainingMins));
    }
  }

  info.dualStream = true; // Luôn luôn phát song song 2 luồng A+B để tránh mọi sự cố
  info.streamAActive = true;
  info.streamBActive = true;
  info.streamALog = '';
  info.streamBLog = '';
  const currentRetry = info.retryCount || 0;
  const serverLetter = (currentRetry % 2 === 0) ? 'a' : 'b';

  const mins = minsToRun;
  const loopArg = mode === 'loop' ? ['-stream_loop', '-1'] : [];
  const timeArg = mode === 'loop' && mins > 0 ? ['-t', String(mins * 60)] : [];

  let serverName = '';
  let formatArgs = [];
  let outputUrl = '';

  if (info.dualStream) {
    serverName = 'Song song cả hai Máy chủ A và B';
    console.log(`[Stream #${id}] 🔗 Khởi chạy luồng phát SONG SONG bất đồng bộ cả 2 Máy chủ chính (A) và dự phòng (B)`);
    
    // Sử dụng bộ trộn f=fifo để chống nghẽn chéo giữa 2 luồng (khi 1 luồng đứt, luồng kia không bị ảnh hưởng)
    // Tự động thử kết nối lại sau mỗi 5 giây (attempt_recovery=1, recovery_wait_time=5) khi có sự cố mạng
    const rtmpA = `[f=fifo:fifo_format=flv:drop_pkts_on_overflow=1:attempt_recovery=1:recovery_wait_time=5:recover_any_error=1:onfail=ignore]rtmp\\://a.rtmp.youtube.com/live2/${key}?tcp_nodelay=1&rw_timeout=15000000`;
    const rtmpB = `[f=fifo:fifo_format=flv:drop_pkts_on_overflow=1:attempt_recovery=1:recovery_wait_time=5:recover_any_error=1:onfail=ignore]rtmp\\://b.rtmp.youtube.com/live2/${key}?tcp_nodelay=1&rw_timeout=15000000`;
    
    formatArgs = [
      '-map', '0',               // BẮT BUỘC: Ánh xạ toàn bộ luồng đầu vào cho tee muxer hoạt động
      '-c', 'copy',
      '-flags', '+global_header', // Đồng bộ header toàn cục cho các bộ trộn con hoạt động ổn định
      '-tag:v', '7',             // Ép nhãn H.264 video tương thích FLV chuẩn (tránh lỗi Tag avc1 incompatible)
      '-tag:a', '10',            // Ép nhãn AAC audio tương thích FLV chuẩn (tránh lỗi Tag mp4a incompatible)
      '-bsf:a', 'aac_adtstoasc',
      '-f', 'tee'
    ];
    outputUrl = `${rtmpA}|${rtmpB}`;
  } else {
    const fallbackServerName = serverLetter === 'a' ? 'Máy chủ chính (A)' : 'Máy chủ dự phòng (B)';
    serverName = fallbackServerName;
    console.log(`[Stream #${id}] 🔗 Sử dụng YouTube Ingestion Server: ${fallbackServerName}`);
    
    formatArgs = [
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-bufsize', '30000k',        // Bộ đệm dữ liệu lớn
      '-maxrate', '5000k',         
      '-rtmp_buffer', '30000',     // SIÊU BỘ ĐỆM: Chờ mạng tối đa 30 giây
      '-rtmp_live', 'live', 
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize'
    ];
    outputUrl = `rtmp://${serverLetter}.rtmp.youtube.com/live2/${key}?tcp_nodelay=1&rw_timeout=15000000`;
  }

  // -c copy = lightest: zero decode/encode, pure remux to FLV
  // -bsf:a aac_adtstoasc = required to wrap ADTS AAC → MPEG-4 AAC for FLV
  const args = [
    '-thread_queue_size', '8192',  // Tăng tối đa hàng đợi đọc file
    ...loopArg,
    '-re',
    '-fflags', '+genpts',        // Sửa timestamp khi copy
    '-i', file,
    ...timeArg,
    ...formatArgs,
    outputUrl
  ];

  const localFF = path.join(__dirname, 'ffmpeg.exe');
  const ffmpegCmd = fs.existsSync(localFF) ? localFF : 'ffmpeg';
  
  console.log(`[Stream #${id}] 🚀 Khởi chạy luồng ổn định cao (Bitrate 4.5M)...`);

  const proc = spawn(ffmpegCmd, args, { 
    stdio: ['pipe', 'pipe', 'pipe'], 
    shell: false, // Dùng shell false để ổn định tham số
    cwd: __dirname,
    windowsHide: true 
  });
  
  proc.on('error', (err) => {
    console.error(`[Stream #${id}] ❌ Lỗi khởi động FFmpeg:`, err.message);
    const telegramName = info.name ? `🏷️ Luồng: *${escapeMarkdown(info.name)}*\n` : '';
    broadcast(`❌ *LUỒNG #${id} KHÔNG THỂ KHỞI CHẠY!*\n━━━━━━━━━━━━━━━━━━\n${telegramName}Lỗi: \`${err.message}\``);
  });

  info.process = proc;
  info.pid = proc.pid;
  info.status = 'live';
  info.startTime = new Date().toISOString();
  info.retryCount = info.retryCount || 0; // Đếm số lần retry
  const fileName = path.basename(info.file);
  const displayName = info.name ? `🏷️ Luồng: *${escapeMarkdown(info.name)}*\n` : '';

  if (info.dualStream) {
    broadcast(`🚀 *LUỒNG #${id} BẮT ĐẦU LIVE (SONG SONG A+B) ⚡*\n━━━━━━━━━━━━━━━━━━\n${displayName}🎞 Video: \`${fileName}\`\n📡 Chế độ: \`Song song cả 2 Máy chủ chính & dự phòng (Độ ổn định cực hạn)\`\n🛡 Trạng thái bảo vệ: \`Hoạt động song song (High Redundancy Active)\``);
  } else {
    broadcast(`🟢 *LUỒNG #${id} BẮT ĐẦU LIVE!*\n━━━━━━━━━━━━━━━━━━\n${displayName}🎞 Video: \`${fileName}\`\n📡 Ingest Server: \`${serverName}\` (Đơn luồng)`);
  }

  // --- CƠ CHẾ KHÔI PHỤC THÔNG MINH: RESET RETRY COUNT KHI LIVE ỔN ĐỊNH ---
  if (info._stableTimer) {
    clearTimeout(info._stableTimer);
    info._stableTimer = null;
  }
  info._stableTimer = setTimeout(() => {
    const s = streams.get(id);
    if (s && s.status === 'live') {
      console.log(`[Stream #${id}] 🟢 Luồng phát đã chạy ổn định trên 60 giây. Reset retryCount về 0.`);
      s.retryCount = 0;
    }
  }, 60000);

  proc.on('error', (err) => {
    const s = streams.get(id);
    if (s) {
      s.status = 'ended';
      s.lastLog = `❌ Lỗi khởi động FFmpeg: ${err.message}`;
      const telegramName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
      broadcast(`🔴 *LỖI KHỞI ĐỘNG LUỒNG #${id}!*\n━━━━━━━━━━━━━━━━━━\n${telegramName}Nội dung: \`${err.message}\``);
      saveStreams();
    }
  });

  let errBuf = '';
  const maskKey = (t) => key ? String(t).split(String(key)).join('KEY****' + String(key).slice(-4)) : String(t);
  // ffmpeg fifo hồi phục kết nối LẶNG LẼ (không in dòng thành công) → nhánh A/B không có lỗi mới trong AB_RECOVER_QUIET_MS thì coi là đã hồi phục
  const AB_QUIET = parseInt(process.env.AB_RECOVER_QUIET_MS) || 45000;
  const abRecoverTimer = setInterval(() => {
    const s = streams.get(id);
    if (!s || s.process !== proc) { clearInterval(abRecoverTimer); return; }
    const displayName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
    if (s.streamAActive === false && s._aFailTs && Date.now() - s._aFailTs > AB_QUIET) {
      s.streamAActive = true; s.streamALog = '';
      broadcast(`🟢 *LUỒNG #${id} - KHÔI PHỤC KẾT NỐI LUỒNG A THÀNH CÔNG!* 🟢\n━━━━━━━━━━━━━━━━━━\n${displayName}🇺🇸 Máy chủ chính A (Primary) đã tự động hoạt động bình thường trở lại.`);
    }
    if (s.streamBActive === false && s._bFailTs && Date.now() - s._bFailTs > AB_QUIET) {
      s.streamBActive = true; s.streamBLog = '';
      broadcast(`🟢 *LUỒNG #${id} - KHÔI PHỤC KẾT NỐI LUỒNG B THÀNH CÔNG!* 🟢\n━━━━━━━━━━━━━━━━━━\n${displayName}🇸🇬 Máy chủ dự phòng B (Backup) đã tự động hoạt động bình thường trở lại.`);
    }
  }, 5000);
  proc.on('close', () => clearInterval(abRecoverTimer));
  proc.stderr.on('data', (d) => {
    const dataStr = d.toString();
    // Bỏ qua log của tiến trình cũ (đã bị thay thế sau khi sửa/bật lại luồng)
    if ((streams.get(id) || {}).process !== proc) return;
    updateStreamLog(id, d); 
    errBuf = (errBuf + dataStr).slice(-2000); 
    const s = streams.get(id);
    if (s) {
        // Thay thế \r thành \n để bóc tách log dòng tiến trình chính xác, tránh đè rác
        const cleanLines = errBuf.replace(/\r/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
        s.lastLog = maskKey(cleanLines[cleanLines.length - 1] || '');
        
        // Duyệt qua các dòng log mới nhận để phát hiện lỗi hoặc phục hồi kết nối thời gian thực từ bộ trộn FIFO
        const newLines = dataStr.replace(/\r/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
        newLines.forEach(line => {
            const lowerLine = line.toLowerCase();
            
            // Bỏ qua dòng khai báo đầu ra của FFmpeg (tránh so khớp nhầm tham số URL như rw_timeout hay onfail)
            if (lowerLine.includes('output #') || lowerLine.startsWith('output #')) {
                return;
            }
            
            // --- KIỂM TRA LỖI PHỤC HỒI THẤT BẠI CỦA FIFO MUXER ---
            if (lowerLine.includes('recovery failed') || lowerLine.includes('unrecoverable error')) {
                // Chỉ khởi động lại nếu CẢ 2 đầu A và B đều sập kết nối thực tế
                if (s.streamAActive === false && s.streamBActive === false) {
                    console.log(`[Stream #${id}] 🚨 Cả 2 máy chủ A & B đều thất bại phục hồi. Đóng tiến trình để tự động kết nối lại...`);
                    if (proc) {
                        try { proc.kill(); } catch (_) {}
                    }
                    return;
                }
            }
            
            // --- KIỂM TRA NHÁNH A ---
            if (lowerLine.includes('a.rtmp.youtube.com') || lowerLine.includes('slave muxer #0')) {
                const isFail = lowerLine.includes('failed') || lowerLine.includes('error') || lowerLine.includes('broken pipe') || lowerLine.includes('refused') || /\btimeout\b/i.test(lowerLine) || lowerLine.includes('timed out') || lowerLine.includes('slave muxer #0 failed');
                const isSuccess = lowerLine.includes('connected') || lowerLine.includes('successful') || lowerLine.includes('success') || lowerLine.includes('established') || lowerLine.includes('recovery successful');
                
                if (isFail) s._aFailTs = Date.now();
                if (isFail && s.streamAActive !== false) {
                    s.streamAActive = false;
                    s.streamALog = maskKey(line);
                    const displayName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
                    broadcast(`⚠️ *LUỒNG #${id} - CẢNH BÁO MẤT KẾT NỐI LUỒNG A!* ⚠️\n━━━━━━━━━━━━━━━━━━\n${displayName}🔴 Máy chủ chính A (Primary) bị gián đoạn.\n🛡️ Hệ thống vẫn đang duy trì phát sóng qua Máy chủ dự phòng B.`);
                } else if (isSuccess && s.streamAActive === false) {
                    s.streamAActive = true;
                    s.streamALog = '';
                    const displayName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
                    broadcast(`🟢 *LUỒNG #${id} - KHÔI PHỤC KẾT NỐI LUỒNG A THÀNH CÔNG!* 🟢\n━━━━━━━━━━━━━━━━━━\n${displayName}🇺🇸 Máy chủ chính A (Primary) đã tự động hoạt động bình thường trở lại.`);
                }
            }
            
            // --- KIỂM TRA NHÁNH B ---
            if (lowerLine.includes('b.rtmp.youtube.com') || lowerLine.includes('slave muxer #1')) {
                const isFail = lowerLine.includes('failed') || lowerLine.includes('error') || lowerLine.includes('broken pipe') || lowerLine.includes('refused') || /\btimeout\b/i.test(lowerLine) || lowerLine.includes('timed out') || lowerLine.includes('slave muxer #1 failed');
                const isSuccess = lowerLine.includes('connected') || lowerLine.includes('successful') || lowerLine.includes('success') || lowerLine.includes('established') || lowerLine.includes('recovery successful');
                
                if (isFail) s._bFailTs = Date.now();
                if (isFail && s.streamBActive !== false) {
                    s.streamBActive = false;
                    s.streamBLog = maskKey(line);
                    const displayName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
                    broadcast(`⚠️ *LUỒNG #${id} - CẢNH BÁO MẤT KẾT NỐI LUỒNG B!* ⚠️\n━━━━━━━━━━━━━━━━━━\n${displayName}🔴 Máy chủ dự phòng B (Backup) bị gián đoạn.\n🛡️ Hệ thống vẫn đang duy trì phát sóng qua Máy chủ chính A.`);
                } else if (isSuccess && s.streamBActive === false) {
                    s.streamBActive = true;
                    s.streamBLog = '';
                    const displayName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
                    broadcast(`🟢 *LUỒNG #${id} - KHÔI PHỤC KẾT NỐI LUỒNG B THÀNH CÔNG!* 🟢\n━━━━━━━━━━━━━━━━━━\n${displayName}🇸🇬 Máy chủ dự phòng B (Backup) đã tự động hoạt động bình thường trở lại.`);
                }
            }
        });
    }
  });

  saveStreams(); // Lưu backup khi luồng bắt đầu live

  proc.on('close', (code) => {
    const s = streams.get(id);
    if (!s) return;
    // Tiến trình cũ đã bị thay bằng tiến trình mới (sửa cấu hình / bật lại nhanh): không được đụng tới trạng thái luồng
    if (s.process !== proc) return;
    s._exitCode = code;
    
    // Dọn _killTimer nếu có
    if (s._killTimer) { clearTimeout(s._killTimer); s._killTimer = null; }

    // Dọn _stableTimer nếu có
    if (s._stableTimer) { clearTimeout(s._stableTimer); s._stableTimer = null; }

    // Nếu do user bấm stop → status đã là 'stopped', không làm gì thêm
    if (s.status === 'stopped') { releaseStreamFile(id, 'dừng thủ công'); return; }

    // Kiểm tra thời lượng đã hết chưa (nếu có giới hạn phút)
    if (s.minutes > 0 && s.firstLiveTime) {
      const elapsedMins = (Date.now() - new Date(s.firstLiveTime).getTime()) / 60000;
      if (elapsedMins >= s.minutes - 0.5) { // Trong vòng 30 giây ranh giới hết giờ
        console.log(`[Stream #${id}] 🏁 Đã hoàn thành thời lượng giới hạn ${s.minutes} phút. Dừng hẳn.`);
        s.status = 'ended';
        s.lastLog = `Hoàn thành thời lượng phát ${s.minutes} phút.`;
        const telegramName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
        broadcast(`⚪ *LUỒNG #${id} KẾT THÚC BÌNH THƯỜNG*\n━━━━━━━━━━━━━━━━━━\n${telegramName}🎞 Video: \`${path.basename(s.file)}\`\n⏱ Thời lượng: \`${s.minutes} phút (Đã phát xong)\``);
        saveStreams();
        releaseStreamFile(id, 'hết thời lượng');
        return;
      }
    }

    // Thiết lập số lần thử lại tối đa (chế độ loop cho phép reconnect vô hạn)
    const maxRetry = s.mode === 'loop' ? 999 : 50;
    const isErrorOrLoop = (code !== 0) || (s.mode === 'loop');

    if (isErrorOrLoop && s.retryCount < maxRetry) {
      s.status = 'reconnecting';
      s.retryCount++;
      const maxRetryText = s.mode === 'loop' ? '∞' : maxRetry;
      const msg = `[Stream #${id}] Luồng bị ngắt (mã ${code}), đang kết nối lại lần ${s.retryCount}/${maxRetryText} sau 10 giây...`;
      console.log(msg);
      const telegramName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
      broadcast(`🟡 *Luồng #${id} bị văng (mã ${code})*\n━━━━━━━━━━━━━━━━━━\n${telegramName}Đang thử kết nối lại lần ${s.retryCount}/${maxRetryText}...`);
      s.timer = setTimeout(() => {
        if (streams.has(id) && streams.get(id).status === 'reconnecting') {
           launchFFmpeg(id, key, file, mode, minutes);
        }
      }, 10000);
    } else {
      s.status = 'ended';
      const telegramName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
      if(code !== 0) {
        s.lastLog = s.lastLog || `Thoát với mã ${code}`;
        broadcast(`🔴 *LUỒNG #${id} BỊ LỖI FFmpeg!*\n━━━━━━━━━━━━━━━━━━\n${telegramName}🎞 Video: \`${path.basename(s.file)}\`\n💬 Chi tiết: \`${escapeMarkdown(s.lastLog)}\``);
      } else {
        broadcast(`⚪ *LUỒNG #${id} KẾT THÚC BÌNH THƯỜNG*\n━━━━━━━━━━━━━━━━━━\n${telegramName}🎞 Video: \`${path.basename(s.file)}\``);
      }
      // Luồng kết thúc vĩnh viễn → dọn file tạm ngay (đặt KEEP_FILES_AFTER_LIVE=1 để giữ lại cho phép bật lại)
      console.log(`[Stream #${id}] Luồng đã kết thúc vĩnh viễn.`);
      releaseStreamFile(id, code !== 0 ? 'kết thúc có lỗi' : 'kết thúc');
    }
    saveStreams(); // Lưu backup khi trạng thái thay đổi
  });
}

// ─── Start Stream ─────────────────────────────────────────────────────────────
function proceedStartStream(id) {
  const s = streams.get(id);
  if (!s || s.status === 'stopped') return;

  if (s.mode === 'scheduled') {
    let localISO = s.scheduledTime;
    if (!localISO.includes('Z') && !localISO.includes('+') && !/-\d{2}:\d{2}$/.test(localISO)) {
      localISO = localISO.length === 16 ? localISO + ':00+07:00' : localISO + '+07:00';
    }
    const delay = new Date(localISO).getTime() - Date.now();
    
    if (delay <= 0) {
      s.status = 'ended';
      s.lastLog = 'Thời gian đặt lịch đã qua sau khi tải xong!';
      return;
    }

    s.status = 'scheduled';
    const displayTime = new Date(localISO).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    s.lastLog = `Đang chờ đến giờ kích hoạt lịch phát: ${displayTime}`;
    s.timer = setTimeout(() => {
      const s2 = streams.get(id);
      if (s2 && s2.status !== 'stopped') { 
        // Giữ nguyên mode (once hoặc loop) khi kích hoạt lịch
        const finalMode = s2.scheduledMode || 'loop';
        s2.mode = finalMode; 
        s2.status = 'launching'; 
        launchFFmpeg(id, s2.key, s2.file, finalMode, s2.minutes);
      }
    }, delay);
  } else {
    s.status = 'launching';
    launchFFmpeg(id, s.key, s.file, s.mode, s.minutes);
  }
}

// Stream Key đang được một luồng KHÁC (còn hoạt động) sử dụng? Hai luồng cùng key sẽ giật nhau trên YouTube.
const KEY_ACTIVE_STATUSES = ['live', 'downloading', 'launching', 'reconnecting', 'scheduled'];
const DUP_KEY_ERROR = 'Stream Key này đang được một luồng khác sử dụng. Mỗi Stream Key chỉ được phát một luồng tại một thời điểm!';
function findActiveKeyUser(key, exceptId) {
  const k = String(key || '').trim();
  if (!k) return null;
  for (const s of streams.values()) {
    if (s.id !== exceptId && String(s.key || '').trim() === k && KEY_ACTIVE_STATUSES.includes(s.status)) return s;
  }
  return null;
}
// Kiểm tra trùng key trên TOÀN CỤM (máy này + các máy khác), bỏ qua chính luồng (exceptId @ exceptServerId)
async function clusterKeyConflict(key, exceptId, exceptServerId) {
  const k = String(key || '').trim();
  if (!k) return false;
  const same = (s, sid) => String(s.key || '').trim() === k && KEY_ACTIVE_STATUSES.includes(s.status) && !(s.id === exceptId && String(sid || '').toLowerCase() === String(exceptServerId || '').toLowerCase());
  for (const s of streams.values()) if (same(s, localNodeId)) return true;
  try {
    const remoteAll = await clusterManager.fetchAllRemoteStreams();
    if (remoteAll.some(s => same(s, s.serverId))) return true;
  } catch (_) {}
  return false;
}

// Giữ chỗ Stream Key trong vài giây khi đang tạo luồng: 2 máy bấm cùng lúc cùng 1 key -> chỉ 1 máy được tạo.
// Master giữ sổ đăng ký chung; Master không liên lạc được thì giữ chỗ tại máy này (best-effort).
const keyReservations = new Map(); // key -> { token, exp }
const KEY_RESERVE_MS = 20000;
function reserveKeyLocal(key, token, release) {
  const k = String(key || '').trim();
  if (!k) return true;
  const now = Date.now();
  for (const [kk, v] of keyReservations) if (v.exp < now) keyReservations.delete(kk);
  const cur = keyReservations.get(k);
  if (release) { if (cur && cur.token === token) keyReservations.delete(k); return true; }
  if (cur && cur.token !== token) return false;
  keyReservations.set(k, { token, exp: now + KEY_RESERVE_MS });
  return true;
}
async function reserveKeyCluster(key, token, release = false) {
  const me = clusterManager.getNode(localNodeId);
  const master = clusterManager.getNodes().find(n => n.isMaster && n.id !== localNodeId);
  if ((me && me.isMaster) || !master) return reserveKeyLocal(key, token, release);
  try {
    const r = await clusterManager.callNodeApi(master, '/api/cluster/reserve-key', 'POST', { key, token, release }, 4000);
    if (r && r.statusCode === 200 && r.data) return !!r.data.ok;
  } catch (_) {}
  return reserveKeyLocal(key, token, release);
}

function startStream({ key, file, mode, minutes, scheduledTime, scheduledMode, dualStream, id, name, youtubeUrl, ownerId, ownerUsername, serverId, createdAt, updatedAt }) {
  if (!file) {
    return { error: 'Đường dẫn video hoặc link Google Drive không được để trống!' };
  }
  if (!key) {
    return { error: 'Stream Key không được để trống!' };
  }
  // Luồng mới (không phải khôi phục/tải lại luồng cũ) không được trùng key với luồng đang hoạt động
  if (!id && findActiveKeyUser(key)) return { error: DUP_KEY_ERROR };

  // Nếu không có luồng nào, reset số thứ tự về 1
  if (streams.size === 0 && !id) nextId = 1;
  
  const streamId = id || nextId++;
  const isDrive = !!extractDriveId(file);

  let normalizedScheduledTime = scheduledTime;
  if (scheduledTime && !scheduledTime.includes('Z') && !scheduledTime.includes('+') && !/-\d{2}:\d{2}$/.test(scheduledTime)) {
    normalizedScheduledTime = scheduledTime.length === 16 ? scheduledTime + ':00+07:00' : scheduledTime + '+07:00';
  }

  if (mode === 'scheduled') {
    const delay = new Date(normalizedScheduledTime).getTime() - Date.now();
    if (delay <= 0) return { error: 'Thời gian đặt lịch đã qua rồi!' };
  }

  const info = {
    id: streamId, key, file, originalFile: file, mode, minutes, scheduledTime: normalizedScheduledTime, name: name || `Luồng #${streamId}`,
    scheduledMode: scheduledMode || 'loop',
    dualStream: true,
    ownerId: ownerId || 'admin_root',
    ownerUsername: ownerUsername || 'admin',
    serverId: localNodeId,
    status: isDrive ? 'downloading' : (mode === 'scheduled' ? 'scheduled' : 'launching'),
    startTime: null,
    process: null, pid: null, lastLog: '', retryCount: 0,
    youtubeUrl: youtubeUrl || '',
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: updatedAt || new Date().toISOString()
  };
  streams.set(streamId, info);

  if (isDrive) {
    // Làm sạch link: lấy URL thực sự nếu người dùng dán thừa text
    const urlMatch = file.match(/https?:\/\/[^\s]+/);
    const cleanFile = urlMatch ? urlMatch[0] : file;
    
    info.lastLog = 'Đang bắt đầu tải file từ Drive...';
    saveStreams(); // Lưu ngay: server khởi động lại khi đang tải vẫn còn luồng và tự tải lại (trước đây luồng bị mất)
    console.log(`\n[Stream #${streamId}] ⬇️ Bắt đầu tải video từ Google Drive...`);
    console.log(`[Stream #${streamId}] 🔗 Link: ${cleanFile}`);
    
    driveQuota.downloadWithQuotaFallback(cleanFile, DOWNLOAD_DIR, (dl, total, pct, speed) => {
      const s = streams.get(streamId);
      if (s) {
        const dualText = s.dualStream ? '⚡ [SONG SONG A+B]' : '📡 [ĐƠN LUỒNG]';
        const speedMBs = speed ? (speed / 1024 / 1024).toFixed(1) : '0.0';
        const speedMbps = speed ? (speed * 8 / 1024 / 1024).toFixed(1) : '0.0';
        
        // Save raw properties for API access
        s.dlBytes = dl;
        s.totalBytes = total;
        s.dlPercent = pct;
        s.dlSpeed = speed;
        
        const telegramName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
        if (pct !== null) {
          s.lastLog = `Đang tải... ${pct}% (${speedMBs} MB/s)`;
          console.log(`[Stream #${streamId}] ⏳ Tiến độ: ${pct}% (${(dl/1024/1024).toFixed(2)} MB / ${(total/1024/1024).toFixed(2)} MB) | Tốc độ: ${speedMBs} MB/s (${speedMbps} Mbps)`);
          
          // Tạo thanh tiến trình trực quan
          const filled = Math.round(pct / 10);
          const bar = '■'.repeat(filled) + '□'.repeat(10 - filled);
          updateProgress(streamId, pct, `📥 *LUỒNG #${streamId}* - ĐANG TẢI VIDEO\n━━━━━━━━━━━━━━━━━━\n${telegramName}📁 File: \`${path.basename(cleanFile)}\`\n📊 Tiến độ: \`[${bar}] ${pct}%\`\n📦 Đã tải: \`${(dl/1024/1024).toFixed(1)} / ${(total/1024/1024).toFixed(1)} MB\`\n⚡ Tốc độ: \`${speedMBs} MB/s\` (${speedMbps} Mbps)\n📡 Cấu hình: \`${dualText}\``);
        }
        else {
          s.lastLog = `Đang tải... ${Math.round(dl/1024/1024)}MB (${speedMBs} MB/s)`;
          console.log(`[Stream #${streamId}] ⏳ Đang tải... ${(dl/1024/1024).toFixed(2)} MB | Tốc độ: ${speedMBs} MB/s`);
          updateProgress(streamId, null, `📥 *LUỒNG #${streamId}* - ĐANG TẢI VIDEO\n━━━━━━━━━━━━━━━━━━\n${telegramName}📁 File: \`${path.basename(cleanFile)}\`\n📊 Tiến độ: \`[Đang tải...]\`\n📦 Đã tải: \`${(dl/1024/1024).toFixed(1)} MB\`\n⚡ Tốc độ: \`${speedMBs} MB/s\`\n📡 Cấu hình: \`${dualText}\``);
        }
      }
    }, {
      // File Drive hết lượt tải → báo trạng thái khi đang tự tạo bản sao
      onStatus: (stage, info) => {
        const s = streams.get(streamId);
        if (!s) return;
        const telegramName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
        if (stage === 'quota') {
          s.lastLog = '⚠️ Drive hết lượt tải → đang tự tạo bản sao...';
          broadcast(`⚠️ *Drive hết lượt tải (Luồng #${streamId})*\n━━━━━━━━━━━━━━━━━━\n${telegramName}🔁 Đang tự tạo bản sao tạm qua Apps Script để tải tiếp...`);
        } else if (stage === 'copied') {
          s.lastLog = '✅ Đã tạo bản sao, đang tải bản sao...';
        } else if (stage === 'delete_failed') {
          broadcast(`⚠️ *Không xóa được bản sao tạm (Luồng #${streamId})*\n${telegramName}Vào Drive → thư mục \`LIVE_BAN_SAO_TAM\` để xóa tay (Script tự dọn sau 6 giờ).\nChi tiết: \`${escapeMarkdown(String(info && info.error || ''))}\``);
        }
      }
    }).then(filePath => {
      const s = streams.get(streamId);
      if (!s) { cleanupFile(filePath); return; }
      if (s.status === 'stopped') { s.file = filePath; releaseStreamFile(streamId, 'dừng khi đang tải'); return; }
      s.file = filePath;
      s.lastLog = 'Tải xong, chuẩn bị live...';
      console.log(`\n[Stream #${streamId}] ✅ TẢI XONG! File được lưu tạm tại: ${filePath}`);
      console.log(`[Stream #${streamId}] 🚀 Bắt đầu kích hoạt FFmpeg...`);
      const telegramName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
      updateProgress(streamId, 100, `✅ *LUỒNG #${streamId}* - TẢI VIDEO THÀNH CÔNG!\n━━━━━━━━━━━━━━━━━━\n${telegramName}🎞 Video: \`${path.basename(filePath)}\`\n🚀 Trạng thái: \`Đang kích hoạt phát Live...\``);
      proceedStartStream(streamId);
      saveStreams(); // Lưu đường dẫn file đã tải → khởi động lại server dùng lại file, không tải lại từ Drive
    }).catch(err => {
      const s = streams.get(streamId);
      if (!s) return;
      s.status = 'ended';
      const noSpace = /ENOSPC|no space/i.test(String(err && (err.code || err.message)));
      s.lastLog = noSpace ? `❌ Ổ đĩa đầy, không tải được file (đã dọn tạm: ${err.message})` : `❌ Lỗi tải Drive: ${err.message}`;
      if (noSpace) { _lastEmergencyAt = Date.now(); emergencyCleanup(`ENOSPC khi tải luồng #${streamId}`); }
      console.error(`\n[Stream #${streamId}] ❌ Lỗi tải Google Drive: ${err.message}`);
      const telegramName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
      broadcast(`❌ *Lỗi tải Drive (Luồng #${streamId})*\n━━━━━━━━━━━━━━━━━━\n${telegramName}Chi tiết: \`${escapeMarkdown(err.message)}\``);
    });
    
    return { id: streamId, status: 'downloading', scheduledTime: info.scheduledTime };
  } else {
    saveStreams(); // Lưu lại ngay khi tạo luồng mới
    proceedStartStream(streamId);
    return { id: streamId, status: info.status, scheduledTime: info.scheduledTime };
  }
}

// ─── Stop Stream ──────────────────────────────────────────────────────────────
function stopStream(id) {
  const info = streams.get(id);
  if (!info) return false;
  if (info.timer) clearTimeout(info.timer);
  info.status = 'stopped';
  const p = info.process;
  if (p) {
    try {
      // Gửi 'q' vào stdin → ffmpeg tự đóng RTMP gracefully
      p.stdin.write('q\n');
      // Force kill sau 5 giây nếu vẫn còn chạy — chỉ nhắm đúng tiến trình này (không phải tiến trình mới nếu luồng được bật lại ngay)
      const kt = setTimeout(() => { try { p.kill(); } catch (_) {} }, 5000);
      p.once('close', () => clearTimeout(kt));
      info._killTimer = kt;
    } catch (_) {
      try { p.kill(); } catch (_) {}
    }
  }

  // File video được giữ cho tới khi live kết thúc/dừng (xem releaseStreamFile). Nếu luồng chưa có tiến trình ffmpeg (đang chờ lịch) thì dọn ngay.
  saveStreams(); // Lưu lại trạng thái dừng
  if (!p) releaseStreamFile(id, 'dừng khi chưa phát');

  return true;
}

// Luồng dùng link Google Drive nhưng chưa có file video trên đĩa (vừa đổi link mới, hoặc file tạm đã bị dọn sau khi live xong) -> cần tải lại
function needsDriveDownload(s) {
  if (!s || !extractDriveId(String(s.originalFile || ''))) return false;
  return !!s._fileReleased || !s.file || /^https?:/i.test(String(s.file)) || !fs.existsSync(s.file);
}
// Tải lại video từ Drive rồi phát (giữ nguyên chủ sở hữu, tên, key, ngày tạo...)
function redownloadFromDrive(s, mode) {
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  return startStream({
    id: s.id, key: s.key, file: s.originalFile, mode: mode || s.mode, minutes: s.minutes,
    scheduledTime: s.scheduledTime, scheduledMode: s.scheduledMode, dualStream: s.dualStream,
    name: s.name, youtubeUrl: s.youtubeUrl, ownerId: s.ownerId, ownerUsername: s.ownerUsername,
    serverId: s.serverId, createdAt: s.createdAt, updatedAt: s.updatedAt
  });
}

// ─── Restart Stream ───────────────────────────────────────────────────────────
function restartStream(id) {
  const s = streams.get(id);
  if (!s) return { error: 'Không tìm thấy luồng' };
  
  if (s.status === 'live' || s.status === 'launching' || s.status === 'scheduled' || s.status === 'reconnecting' || s.status === 'downloading') {
    return { error: 'Luồng đang chạy, không thể khởi động lại' };
  }
  if (findActiveKeyUser(s.key, id)) return { error: DUP_KEY_ERROR };
  // Link Drive mới (chưa tải) hoặc file tạm đã bị dọn -> TẢI LẠI từ Drive rồi phát
  if (needsDriveDownload(s)) {
    console.log(`[Stream #${id}] 🔄 Khởi động lại: chưa có file trên đĩa → tải lại từ Google Drive`);
    const r = redownloadFromDrive(s, s.mode === 'scheduled' ? (s.scheduledMode || 'loop') : s.mode);
    return r && r.error ? r : { ok: true, id, status: 'downloading' };
  }
  if (s._fileReleased || (s.file && path.resolve(s.file).startsWith(path.resolve(DOWNLOAD_DIR) + path.sep) && !fs.existsSync(s.file))) return { error: 'File video tạm đã được dọn sau khi live xong. Hãy tạo luồng mới (hoặc đặt KEEP_FILES_AFTER_LIVE=1 để giữ file).' };
  
  s.status = 'launching';
  s.startTime = null;
  s.process = null;
  s.pid = null;
  s.lastLog = '';
  s.retryCount = 0;
  
  launchFFmpeg(id, s.key, s.file, s.mode, s.minutes);
  return { ok: true, id };
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function parseBody(req) {
  try { return JSON.parse(await readBody(req)); }
  catch (_) { return null; }
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function editStreamLocal(body) {
  const id = Number(body.id);
  const s = streams.get(id);
  if (!s) return { error: 'Không tìm thấy luồng' };
  
  const wasRunning = ['live', 'reconnecting', 'launching', 'downloading'].includes(s.status);
  const wasScheduled = s.status === 'scheduled';
  
  // Kiểm tra các thay đổi cốt lõi (yêu cầu khởi động lại luồng)
  const fileChanged = body.file && body.file !== s.originalFile;
  const keyChanged = body.key && body.key !== s.key;
  const modeChanged = body.mode && body.mode !== s.mode;
  const minutesChanged = body.minutes !== undefined && Math.max(0, parseInt(body.minutes) || 0) !== s.minutes;
  const timeChanged = body.scheduledTime && body.scheduledTime !== s.scheduledTime;
  
  const needsRestart = fileChanged || keyChanged || modeChanged || minutesChanged || timeChanged;
  
  // Đổi sang Stream Key đang được luồng khác dùng -> từ chối (tránh 2 luồng giật nhau trên YouTube)
  if (keyChanged && findActiveKeyUser(body.key, id)) return { error: DUP_KEY_ERROR };
  
  if (needsRestart) {
    console.log(`[Stream #${id}] ⚙️ Cấu hình cốt lõi thay đổi. Tiến hành cập nhật và điều chỉnh luồng...`);
    // File tạm cũ: dọn khi không còn luồng nào dùng (đổi link / tải lại từ Drive). Nếu ffmpeg cũ còn chạy/đang thoát thì chờ nó thoát hẳn.
    // (Trước đây bị bỏ sót khi sửa lúc đang live hoặc ngay sau khi dừng → đầy đĩa dần.) cleanupFile chỉ xóa file do hệ thống tải về.
    const oldFile = s.file;
    const oldProc = s.process && s.process.exitCode === null && s.process.signalCode === null ? s.process : null;
    const freeOldFile = () => {
      if (!oldFile || process.env.KEEP_FILES_AFTER_LIVE === '1') return;
      const inUse = Array.from(streams.values()).some(o => o.file === oldFile || o.originalFile === oldFile);
      if (!inUse) cleanupFile(oldFile);
    };
    if (oldProc) oldProc.once('close', freeOldFile); else setImmediate(freeOldFile);
    // Nếu đang chạy hoặc đặt lịch, ta cần dừng lại để giải phóng tài nguyên trước
    if (wasRunning || wasScheduled) {
      stopStream(id);
    }
    
    // Cập nhật các thông tin mới
    if (body.name !== undefined) {
      s.name = body.name;
    }
    if (body.youtubeUrl !== undefined) {
      s.youtubeUrl = body.youtubeUrl;
    }
    s.updatedAt = new Date().toISOString();
    
    if (body.key) {
      s.key = body.key;
    }
    
    if (fileChanged) {
      // Đổi video: file tạm cũ được dọn ở trên (freeOldFile), lần phát tới sẽ tải video mới
      s.originalFile = body.file;
      s.file = body.file;
      delete s._fileReleased;
    }
    
    s.mode = body.mode || s.mode;
    s.minutes = Math.max(0, parseInt(body.minutes) || 0);
    s.scheduledTime = body.scheduledTime || s.scheduledTime;
    s.scheduledMode = body.scheduledMode || s.scheduledMode;
    s.dualStream = true;
    s.retryCount = 0;
    
    // Xác định xem luồng mới có phải là chế độ đặt lịch hay không
    const isNewScheduled = s.mode === 'scheduled';
    
    if (isNewScheduled) {
      // Tình huống A: Chuyển sang đặt lịch (Hoặc đổi giờ đặt lịch)
      console.log(`[Stream #${id}] Luồng được chuyển sang/thiết lập chế độ Đặt Lịch lúc ${s.scheduledTime}`);
      s.status = 'scheduled';
      s.lastLog = `Đã chuyển sang đặt lịch phát lúc ${new Date(s.scheduledTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;
      saveStreams();
      if (needsDriveDownload(s)) {
        // Link Drive chưa tải (mới đổi / file đã dọn) -> tải trước rồi mới hẹn giờ
        const r = redownloadFromDrive(s, 'scheduled');
        if (r && r.error) { s.status = 'stopped'; s.lastLog = r.error; saveStreams(); return r; }
      } else {
        proceedStartStream(s.id); // Tự động hẹn giờ kích hoạt ở tương lai
      }
    } else {
      // Tình huống B: Chạy ngay lập tức (Loop hoặc Once)
      console.log(`[Stream #${id}] Luồng được thiết lập chạy NGAY LẬP TỨC (Chế độ: ${s.mode})`);
      
      // Nếu trước đó đang chạy HOẶC trước đó đặt lịch mà bây giờ chuyển sang chạy ngay
      if (wasRunning || wasScheduled) {
        const isDrive = !!extractDriveId(s.originalFile);
        s.status = isDrive ? 'downloading' : 'launching';
        s.startTime = null;
        s.process = null;
        s.pid = null;
        s.lastLog = 'Đang kích hoạt luồng phát sóng mới.';
        
        if (isDrive) {
          // Tải lại video Drive và tự động chạy (giữ nguyên chủ sở hữu - trước đây bị đổi thành admin)
          redownloadFromDrive(s);
        } else {
          proceedStartStream(s.id);
        }
      } else {
        // Nếu trước đó đã dừng/ended, ta chỉ cập nhật cấu hình và giữ nguyên trạng thái stopped
        s.status = 'stopped';
        s.lastLog = 'Cấu hình đã được lưu (Luồng đang tắt).';
        saveStreams();
      }
    }
  } else {
    // Chỉ thay đổi thông tin phụ (Ví dụ: tên gợi nhớ luồng, link youtube)
    console.log(`[Stream #${id}] ⚙️ Chỉ cập nhật thông tin phụ (Tên luồng, Link YouTube). Giữ luồng chạy liên tục không ngắt quãng.`);
    if (body.name !== undefined) {
      s.name = body.name;
    }
    if (body.youtubeUrl !== undefined) {
      s.youtubeUrl = body.youtubeUrl;
    }
    s.updatedAt = new Date().toISOString();
    saveStreams();
    
    // Đồng bộ thông tin tên luồng lên Telegram
    const isLive = s.status === 'live';
    const statusIcon = isLive ? '🟢' : '⚪';
    broadcast(`📝 *ĐÃ CẬP NHẬT CẤU HÌNH LUỒNG #${id}* \n━━━━━━━━━━━━━━━━━━\n🏷️ Tên mới: *${escapeMarkdown(s.name || 'Không tên')}*\n📺 Link YouTube mới: *${escapeMarkdown(s.youtubeUrl || 'Chưa điền')}*\n📊 Trạng thái hiện tại: \`${s.status.toUpperCase()}\` (Luồng vẫn đang chạy liên tục mượt mà)`);
  }
  
  return { ok: true, id };
}

// ─── 🔐 CẤU HÌNH BẢO MẬT & ĐĂNG NHẬP ──────────────────────────────────────────
const crypto = require('crypto');
const AUTH_CONFIG_PATH = path.join(__dirname, 'auth_config.json');
const FALLBACK_AUTH_CONFIG_PATH = path.join(os.tmpdir(), 'cyber_shield_auth_config.json');
let activeAuthConfigPath = AUTH_CONFIG_PATH;
let authConfig = { username: 'admin', password: 'admin', sessionToken: '' };
let sessionToken = '';

// ── Chống sập tiến trình do lỗi bất ngờ (không làm chết các luồng live đang chạy) ──
process.on('uncaughtException', (err) => {
  console.error('[CRASH GUARD] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH GUARD] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});

// ── Giới hạn đăng nhập sai (chống dò mật khẩu): tối đa 8 lần / 5 phút / (IP + user) ──
const loginFailures = new Map();
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
function loginKey(req, username) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  return ip + '|' + String(username || '').toLowerCase();
}
function isLoginBlocked(key) {
  const rec = loginFailures.get(key);
  if (!rec) return 0;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) { loginFailures.delete(key); return 0; }
  return rec.count >= LOGIN_MAX_FAILS ? Math.ceil((LOGIN_WINDOW_MS - (Date.now() - rec.first)) / 1000) : 0;
}
function recordLoginFail(key) {
  const rec = loginFailures.get(key);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) loginFailures.set(key, { count: 1, first: Date.now() });
  else rec.count++;
}
setInterval(() => {
  for (const [k, r] of loginFailures) if (Date.now() - r.first > LOGIN_WINDOW_MS) loginFailures.delete(k);
}, 60 * 1000).unref();

function loadAuthConfig() {
  try {
    let configPath = AUTH_CONFIG_PATH;
    if (!fs.existsSync(AUTH_CONFIG_PATH) && fs.existsSync(FALLBACK_AUTH_CONFIG_PATH)) {
      configPath = FALLBACK_AUTH_CONFIG_PATH;
    }
    activeAuthConfigPath = configPath;

    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (data.username && data.password) {
        authConfig = data;
        if (data.sessionToken) {
          sessionToken = data.sessionToken;
        } else {
          sessionToken = crypto.randomBytes(16).toString('hex');
          authConfig.sessionToken = sessionToken;
          saveAuthConfig();
        }
      }
    } else {
      sessionToken = crypto.randomBytes(16).toString('hex');
      authConfig.sessionToken = sessionToken;
      saveAuthConfig();
    }
  } catch (e) {
    console.error('[Auth] Lỗi tải cấu hình bảo mật:', e.message);
  }
}

function saveAuthConfig() {
  try {
    fs.writeFileSync(activeAuthConfigPath, JSON.stringify(authConfig, null, 2), 'utf8');
  } catch (e) {
    console.error('[Auth] Lỗi lưu cấu hình bảo mật tại path chính:', e.message);
    if (activeAuthConfigPath !== FALLBACK_AUTH_CONFIG_PATH) {
      try {
        console.log('[Auth] Đang thử lưu cấu hình bảo mật vào thư mục tạm hệ thống (fallback)...');
        activeAuthConfigPath = FALLBACK_AUTH_CONFIG_PATH;
        fs.writeFileSync(FALLBACK_AUTH_CONFIG_PATH, JSON.stringify(authConfig, null, 2), 'utf8');
        console.log('[Auth] Lưu cấu hình bảo mật vào thư mục tạm thành công!');
      } catch (err) {
        console.error('[Auth] Lỗi lưu cấu hình bảo mật tại thư mục tạm:', err.message);
      }
    }
  }
}

loadAuthConfig();

// Nhận diện vai trò Master / Worker trong Cluster (bền vững, không phụ thuộc 1 nguồn duy nhất)
let detectedServerIp = 'Unknown';
let localNodeId = 'vps1';
let failoverCtl = null; // bộ điều phối tự chuyển luồng (failover.js), chỉ hoạt động trên Master
let sysinfoFn = null;
let sheetNodesCtl = null; // đồng bộ danh sách VPS từ Google Sheet (sheetNodes.js)
let streamsReady = false; // true sau khi loadStreams() xong (để failover không kết luận "không còn bản cũ" khi máy vừa khởi động lại)
let localRoleConfirmed = false;

function applyLocalRole(id, how) {
  id = String(id).trim().toLowerCase(); // danh sách cụm luôn lưu id chữ thường (clusterManager) → NODE_ID=VPS2 vẫn khớp vps2
  localNodeId = id;
  localRoleConfirmed = true;
  clusterManager.setLocalNode(id);
  const nd = clusterManager.getNode(id);
  const label = nd ? `${nd.name || id} [${id}] (${nd.isMaster ? 'Master Controller' : 'Worker Node'})` : id;
  console.log(`[Cluster] 🖥️ Vai trò máy chủ này: ${label} (nhận diện qua ${how})`);
}

function detectRoleFromInterfaces() {
  const known = clusterManager.getNodes();
  const addrs = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(k => (ifaces[k] || []).forEach(a => { if (a.family === 'IPv4') addrs.push(a.address); }));
  const hit = known.find(n => addrs.includes(n.ip));
  return hit ? hit.id : null;
}

function checkLocalServerRole() {
  // 1. Ép bằng biến môi trường: NODE_ID=vps2 pm2 restart ...
  if (process.env.NODE_ID) { applyLocalRole(process.env.NODE_ID, 'biến môi trường NODE_ID'); return; }
  // 2. IP trên card mạng khớp danh sách node
  const byIface = detectRoleFromInterfaces();
  if (byIface) { applyLocalRole(byIface, 'IP card mạng'); return; }
  // 3. Hỏi IP public (có timeout, tự thử lại mỗi 30s đến khi thành công)
  const req2 = http.get('http://api.ipify.org', { timeout: 5000 }, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      detectedServerIp = d.trim();
      const hit = clusterManager.getNodes().find(n => n.ip === detectedServerIp);
      if (hit) applyLocalRole(hit.id, `IP public ${detectedServerIp}`);
      else { console.warn(`[Cluster] IP public ${detectedServerIp} không khớp node nào, thử lại sau 30s`); setTimeout(checkLocalServerRole, 30000).unref(); }
    });
  });
  req2.on('timeout', () => req2.destroy());
  req2.on('error', () => {
    if (!localRoleConfirmed) setTimeout(checkLocalServerRole, 30000).unref();
  });
}
checkLocalServerRole();

// Tự đăng ký vào cụm: đặt MASTER_URL=http://IP_MASTER:3131 (+ NODE_ID, CLUSTER_SECRET giống Master).
// Máy này tự gọi Master để được thêm vào cụm; Master sẽ đẩy danh sách node về lại. Thử lại mỗi 30s tới khi thành công.
async function autoJoinCluster() {
  const masterUrl = process.env.MASTER_URL;
  if (!masterUrl) return;
  const nodeId = String(process.env.NODE_ID || '').trim().toLowerCase();
  if (!nodeId) { console.warn('[AutoJoin] Cần đặt NODE_ID (vd vps3) để tự đăng ký vào cụm'); return; }
  let mu;
  try { mu = new URL(masterUrl); } catch (_) { console.warn('[AutoJoin] MASTER_URL không hợp lệ:', masterUrl); return; }
  const master = { id: '_master', name: 'master', ip: mu.hostname, port: parseInt(mu.port, 10) || 3131 };
  const retry = (why) => { console.warn(`[AutoJoin] ${why} → thử lại sau 30s`); setTimeout(autoJoinCluster, 30000).unref(); };
  try {
    const list = await clusterManager.callNodeApi(master, '/api/cluster/nodes', 'GET', null, 6000);
    if (list.statusCode === 401 || list.statusCode === 403) { retry('Master từ chối (kiểm tra CLUSTER_SECRET có giống Master không)'); return; }
    if (list.statusCode !== 200 || !Array.isArray(list.data)) { retry(`Master trả mã ${list.statusCode}`); return; }
    if (list.data.some(n => n.id === nodeId)) { console.log(`[AutoJoin] ✅ ${nodeId} đã có trong cụm`); return; }
    let ip = String(process.env.NODE_IP || '').trim();
    if (!ip) {
      ip = await new Promise(resolve => {
        const r = http.get('http://api.ipify.org', { timeout: 5000 }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d.trim())); });
        r.on('timeout', () => { r.destroy(); resolve(''); }); r.on('error', () => resolve(''));
      });
    }
    if (!ip) { retry('Không xác định được IP public (đặt NODE_IP=...)'); return; }
    const name = process.env.NODE_NAME || `${nodeId.toUpperCase()} (Worker)`;
    const r = await clusterManager.callNodeApi(master, '/api/cluster/nodes', 'POST', { id: nodeId, name, ip, port: PORT }, 15000);
    if (r.statusCode === 200) { console.log(`[AutoJoin] ✅ Đã đăng ký ${nodeId} (${ip}:${PORT}) vào cụm qua Master`); return; }
    const msg = (r.data && r.data.error) || `mã ${r.statusCode}`;
    // IP:Port đã có trong cụm (đăng ký trước đó) thì coi như xong
    if (/đã có trong cụm|đã tồn tại/.test(msg)) { console.log(`[AutoJoin] ℹ️ ${msg}`); return; }
    retry(`Master từ chối: ${msg}`);
  } catch (e) { retry(`Không gọi được Master (${e.message})`); }
}

// CORS: đặt CORS_ORIGIN=https://a.com,https://b.com để giới hạn; bỏ trống = '*' (tương thích app desktop)
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
if (process.env.STRICT_INTERNAL !== '1') {
  console.warn('[Bảo mật] STRICT_INTERNAL chưa bật: request có User-Agent nội bộ được quyền admin. Khuyến nghị đặt STRICT_INTERNAL=1 + CLUSTER_SECRET giống nhau trên các VPS.');
}

const server = http.createServer(async (req, res) => {
  sysinfoFn = getLocalSysinfo; // (hàm được hoist trong handler) để failover.js lấy tải máy này khi chọn máy đích
  {
    const origin = req.headers.origin;
    if (!CORS_ORIGINS.length) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (origin && CORS_ORIGINS.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Diag-Token');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const { pathname, searchParams } = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // Chưa khôi phục xong danh sách luồng (vài giây đầu sau khi bật máy) → GIỮ các lệnh bật/tắt/sửa luồng lại đợi.
  // Trước đây: lệnh /api/start tới sớm → luồng mới ghi đè streams_backup.json (mất luồng cũ) hoặc bị khôi phục và tải Drive 2 lần; trùng ID; giữ key sai.
  if (!streamsReady && req.method === 'POST' && ['/api/start', '/api/edit', '/api/stop', '/api/restart', '/api/clear', '/api/cluster/reserve-key'].includes(pathname)) {
    for (let i = 0; i < 120 && !streamsReady; i++) await new Promise(r => setTimeout(r, 250));
    if (!streamsReady) { json(res, 503, { error: 'Máy chủ đang khởi động, vui lòng thử lại sau vài giây' }); return; }
  }

  // Endpoint công khai 0: Kiểm tra sức khỏe (cho giám sát / PM2 / VPS đối tác) - không lộ dữ liệu nhạy cảm
  if (req.method === 'GET' && pathname === '/api/health') {
    json(res, 200, {
      ok: true,
      node: localNodeId,
      ready: streamsReady,
      uptimeSec: Math.round(process.uptime()),
      activeStreams: Array.from(streams.values()).filter(s => ['live', 'downloading', 'launching', 'reconnecting'].includes(s.status)).length,
      time: new Date().toISOString()
    });
    return;
  }

  // Endpoint công khai 1: Đăng nhập hệ thống (hỗ trợ cả tài khoản Google Sheets & admin cũ)
  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await parseBody(req);
    if (!body || !body.username || !body.password) {
      json(res, 400, { error: 'Vui lòng điền tài khoản và mật khẩu!' });
      return;
    }
    const lk = loginKey(req, body.username);
    const blockedSec = isLoginBlocked(lk);
    if (blockedSec > 0) {
      json(res, 429, { error: `Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau ${blockedSec} giây!` });
      return;
    }
    const authResult = await userManager.authenticate(body.username, body.password);
    if (!authResult) {
      json(res, 400, { error: 'Dữ liệu không hợp lệ!' });
      return;
    }
    if (authResult.error) {
      // Fallback kiểm tra mật khẩu legacy admin (auth_config.json).
      // BẢO MẬT: mật khẩu MẶC ĐỊNH "admin" bị khóa (ai cũng đoán được → vào thẳng quyền admin gốc).
      // Muốn dùng lại: sửa "password" trong auth_config.json thành mật khẩu khác rồi pm2 restart (hoặc ALLOW_DEFAULT_ADMIN=1, không khuyến nghị).
      const legacyOk = body.username === authConfig.username && body.password === authConfig.password;
      if (legacyOk && authConfig.password === 'admin' && process.env.ALLOW_DEFAULT_ADMIN !== '1') {
        recordLoginFail(lk);
        console.warn(`[Bảo mật] Từ chối đăng nhập bằng mật khẩu mặc định admin/admin (IP ${lk.split('|')[0]}). Đổi "password" trong ${activeAuthConfigPath} rồi khởi động lại nếu cần dùng tài khoản dự phòng.`);
        json(res, 401, { error: 'Mật khẩu mặc định admin/admin đã bị khóa vì không an toàn. Hãy đăng nhập bằng mật khẩu admin thật (Google Sheet / tài khoản nội bộ), hoặc đổi mật khẩu trong auth_config.json trên VPS rồi khởi động lại.' });
        return;
      }
      if (legacyOk) {
        loginFailures.delete(lk);
        json(res, 200, { 
          token: sessionToken, 
          user: { id: 'admin_root', username: 'admin', name: 'Quản Trị Viên', role: 'admin', maxStreams: 999, allowedServers: ['all'] } 
        });
        return;
      }
      recordLoginFail(lk);
      json(res, 401, { error: authResult.error });
      return;
    }
    loginFailures.delete(lk);
    json(res, 200, authResult);
    return;
  }

  // Endpoint công khai 2: Nhận Webhook đồng bộ tài khoản từ Google Apps Script
  if (req.method === 'POST' && pathname === '/api/users/sync-from-sheet') {
    const body = await parseBody(req);
    if (!body || !body.rows) {
      json(res, 400, { error: 'Thiếu dữ liệu hàng tài khoản từ Google Sheets!' });
      return;
    }
    const syncRes = userManager.syncFromGoogleSheet(body.rows, body.secret);
    if (syncRes.error) {
      json(res, 403, syncRes);
      return;
    }

    // Tự động lan truyền đồng bộ sang các VPS đối tác trong cụm (CHỈ khi không phải bản tin do node khác chuyển tới, tránh lặp vô hạn)
    const syncForwarded = req.headers['x-cluster-forwarded'] === '1';
    if (syncForwarded) {
      json(res, 200, syncRes);
      return;
    }
    clusterManager.syncUsersToPeers(body.rows, body.secret);

    // Bắn thông báo báo cáo lên Telegram & Zalo
    try {
      const msg = `🚀 *[ĐỒNG BỘ GOOGLE SHEETS THÀNH CÔNG]*\n━━━━━━━━━━━━━━━━━━\n📊 Tổng tài khoản: *${syncRes.total}*\n➕ Thêm mới: \`${syncRes.added}\` | 🔄 Cập nhật: \`${syncRes.updated}\`\n⏰ Thời gian: \`${syncRes.lastSyncTime}\``;
      broadcast(msg);
      sendToZalo(msg);
    } catch (_) {}

    json(res, 200, syncRes);
    return;
  }

  // Bộ lọc bảo vệ (Auth Middleware)
  let currentUser = null;
  const userAgent = req.headers['user-agent'] || '';
  // BẢO MẬT: KHÔNG còn cấp quyền admin chỉ vì User-Agent "CyberShieldSecureAgent" (ai cũng giả được).
  // Máy trong cụm phải gửi X-Cluster-Secret đúng; người dùng/ứng dụng desktop phải đăng nhập (token).
  // Chỉ bật lại kiểu cũ nếu thật sự cần: ALLOW_APP_UA=1 (KHÔNG khuyến nghị). STRICT_INTERNAL=1 luôn tắt.
  const allowAppUA = process.env.ALLOW_APP_UA === '1' && process.env.STRICT_INTERNAL !== '1';
  const isSecureApp = allowAppUA && userAgent.includes('CyberShieldSecureAgent/1.0');
  const _gotBuf = Buffer.from(String(req.headers['x-cluster-secret'] || ''));
  const _expBuf = Buffer.from(String(userManager.getSheetConfig().syncSecret || ''));
  const isClusterPeer = _gotBuf.length > 0 && _expBuf.length > 0 && _gotBuf.length === _expBuf.length && crypto.timingSafeEqual(_gotBuf, _expBuf);
  const isForwarded = req.headers['x-cluster-forwarded'] === '1' && (isSecureApp || isClusterPeer);

  if (isSecureApp || isClusterPeer) {
    currentUser = { id: 'admin_root', username: 'admin', name: 'Aegis System Admin', role: 'admin', maxStreams: 999, allowedServers: ['all'] };
  } else {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
      if (token === sessionToken) {
        currentUser = { id: 'admin_root', username: 'admin', name: 'Quản Trị Viên', role: 'admin', maxStreams: 999, allowedServers: ['all'] };
      } else {
        currentUser = userManager.getUserByToken(token);
      }
    }
  }

  // ═══ CỔNG KIỂM TRA SÂU (chỉ đọc + tự kiểm tra) — admin | máy trong cụm | mã kiểm tra từ xa (X-Diag-Token) ═══
  if (pathname === '/api/diag' || pathname.startsWith('/api/diag/')) {
    const isAdminSession = !!currentUser && currentUser.role === 'admin' && !isClusterPeer;
    const viaToken = !currentUser && diagnostics.checkToken(req.headers['x-diag-token']);
    if (!(isClusterPeer || isAdminSession || viaToken)) {
      json(res, 401, { error: 'Cần đăng nhập admin hoặc mã kiểm tra (X-Diag-Token) còn hạn' });
      return;
    }
    try {
      // Tạo / thu hồi / xem mã kiểm tra: chỉ admin đăng nhập trên giao diện
      if (pathname === '/api/diag/token') {
        if (req.method === 'GET') { json(res, 200, diagnostics.tokenInfo()); return; }
        if (req.method === 'POST') {
          if (!isAdminSession) { json(res, 403, { error: 'Chỉ admin đăng nhập mới tạo được mã kiểm tra' }); return; }
          const body = await parseBody(req) || {};
          json(res, 200, diagnostics.createToken(body.hours));
          return;
        }
      }
      if (req.method === 'POST' && pathname === '/api/diag/token/revoke') {
        if (!isAdminSession) { json(res, 403, { error: 'Chỉ admin đăng nhập mới thu hồi được mã kiểm tra' }); return; }
        diagnostics.revokeToken();
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/diag') {
        const scope = searchParams.get('scope');
        if (scope === 'version') { json(res, 200, diagnostics.versionInfo()); return; }
        const self = await diagnostics.report();
        if (searchParams.get('cluster') === '1' && scope !== 'local') {
          const peers = clusterManager.getNodes().filter(n => n.id !== localNodeId);
          const others = await Promise.all(peers.map(async n => {
            try {
              const r = await clusterManager.callNodeApi(n, '/api/diag?scope=local', 'GET', null, 60000);
              if (r && r.statusCode === 200 && r.data && typeof r.data === 'object' && r.data.checks) return r.data;
              return { node: n.id, overall: 'fail', error: r && (r.statusCode === 404 || r.statusCode === 200) ? 'Máy này chạy code CŨ (chưa có cổng kiểm tra)' : r && r.statusCode === 401 ? 'Sai secret cụm (401)' : `HTTP ${r && r.statusCode}` };
            } catch (e) { return { node: n.id, overall: 'fail', error: e.message }; }
          }));
          json(res, 200, { ...self, peers: others });
          return;
        }
        json(res, 200, self);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/diag/selftest') {
        const body = await parseBody(req) || {};
        const r = await diagnostics.selftest({
          scope: body.scope, cluster: !!body.cluster,
          driveUrl: typeof body.driveUrl === 'string' ? body.driveUrl.trim() : '',
          driveCopyTest: !!body.driveCopyTest,
        });
        json(res, r.error ? 429 : 200, r);
        return;
      }
      json(res, 404, { error: 'Không có đường kiểm tra này' });
    } catch (e) {
      console.error('[Diag] Lỗi:', e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname.startsWith('/api/') && pathname !== '/api/login' && pathname !== '/api/users/sync-from-sheet') {
    if (!currentUser) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
  }

  // API: Lấy thông tin tài khoản hiện tại & quota (/api/me)
  if (req.method === 'GET' && pathname === '/api/me') {
    const userStreams = Array.from(streams.values()).filter(s => 
      (s.ownerId === currentUser.id || s.ownerUsername === currentUser.username) &&
      ['live', 'downloading', 'launching', 'reconnecting', 'scheduled'].includes(s.status)
    );
    json(res, 200, {
      user: currentUser,
      activeStreamsCount: userStreams.length,
      quotaPercent: currentUser.role === 'admin' ? 10 : Math.min(100, Math.round((userStreams.length / currentUser.maxStreams) * 100))
    });
    return;
  }

  // API: Quản lý người dùng - Xem danh sách (Chỉ dành cho Admin)
  if (req.method === 'GET' && pathname === '/api/users/list') {
    if (currentUser.role !== 'admin') {
      json(res, 403, { error: 'Chỉ Admin mới có quyền xem danh sách người dùng!' });
      return;
    }
    json(res, 200, userManager.listUsers(false));
    return;
  }

  // API: Quản lý người dùng - Thêm / Sửa (Chỉ dành cho Admin)
  if (req.method === 'POST' && pathname === '/api/users/save') {
    if (currentUser.role !== 'admin') {
      json(res, 403, { error: 'Chỉ Admin mới có quyền chỉnh sửa người dùng!' });
      return;
    }
    const body = await parseBody(req);
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
    const result = userManager.upsertUser(body);
    json(res, result.error ? 400 : 200, result);
    return;
  }

  // API: Quản lý người dùng - Xóa (Chỉ dành cho Admin)
  if (req.method === 'POST' && pathname === '/api/users/delete') {
    if (currentUser.role !== 'admin') {
      json(res, 403, { error: 'Chỉ Admin mới có quyền xóa người dùng!' });
      return;
    }
    const body = await parseBody(req);
    if (!body || !body.id) { json(res, 400, { error: 'Thiếu ID người dùng!' }); return; }
    const result = userManager.deleteUser(body.id);
    json(res, result.error ? 400 : 200, result);
    return;
  }

  // API: Lấy cấu hình kết nối Google Sheet
  if (req.method === 'GET' && pathname === '/api/sheet/config') {
    if (currentUser.role !== 'admin') {
      json(res, 403, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, userManager.getSheetConfig());
    return;
  }

  // API: Lưu cấu hình URL Google Sheet Web App & kiểm tra kết nối
  if (req.method === 'POST' && pathname === '/api/sheet/config') {
    if (currentUser.role !== 'admin') {
      json(res, 403, { error: 'Unauthorized' });
      return;
    }
    const body = await parseBody(req);
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }

    const updated = userManager.updateSheetConfig({
      googleSheetScriptUrl: body.googleSheetScriptUrl ? body.googleSheetScriptUrl.trim() : '',
      syncSecret: body.syncSecret ? body.syncSecret.trim() : userManager.getSheetConfig().syncSecret
    });

    let testRes = null;
    if (updated.googleSheetScriptUrl) {
      testRes = await userManager.testSheetConnection(updated.googleSheetScriptUrl, updated.syncSecret);
    }

    json(res, 200, { ok: true, config: updated, testResult: testRes });
    return;
  }

  // API: Lưu danh sách Apps Script RIÊNG tạo bản sao khi Drive hết lượt tải (nhiều link = dự phòng) + kiểm tra từng link
  if (req.method === 'POST' && pathname === '/api/drive-copy/config') {
    if (currentUser.role !== 'admin') { json(res, 403, { error: 'Unauthorized' }); return; }
    const body = (await parseBody(req)) || {};
    const urls = driveQuota.normalizeUrls(body.urls);
    userManager.updateSheetConfig({ driveCopyUrls: urls });
    const results = urls.length ? await driveQuota.checkScripts(urls) : [];
    json(res, 200, { ok: true, urls, results, envOverride: !!(process.env.DRIVE_COPY_URLS || process.env.DRIVE_COPY_URL) });
    return;
  }

  // API: Kiểm tra các Apps Script tạo bản sao (không tạo file nào)
  if (req.method === 'POST' && pathname === '/api/drive-copy/check') {
    if (currentUser.role !== 'admin') { json(res, 403, { error: 'Unauthorized' }); return; }
    const body = (await parseBody(req)) || {};
    json(res, 200, { ok: true, results: await driveQuota.checkScripts(body.urls && body.urls.length ? body.urls : null) });
    return;
  }

  // API: Lấy code Apps Script riêng tạo bản sao (để sao chép dán vào script.google.com)
  if (req.method === 'GET' && pathname === '/api/drive-copy/script') {
    if (currentUser.role !== 'admin') { json(res, 403, { error: 'Unauthorized' }); return; }
    try {
      let code = fs.readFileSync(path.join(__dirname, 'google_apps_script_copy.js'), 'utf8');
      const sec = userManager.getSheetConfig().syncSecret;
      if (sec) code = code.replace('"DOI_SECRET_NAY_GIONG_CLUSTER_SECRET" // ⚠️ Đổi giống secret cụm trên VPS', JSON.stringify(sec) + ' // Secret cụm (đã điền sẵn từ VPS)');
      json(res, 200, { ok: true, code });
    } catch (e) { json(res, 500, { error: 'Không đọc được google_apps_script_copy.js: ' + e.message }); }
    return;
  }

  // API: Kéo toàn bộ tài khoản từ Google Sheet về ngay lập tức (Sync Now)
  if (req.method === 'POST' && pathname === '/api/sheet/sync-now') {
    if (currentUser.role !== 'admin') {
      json(res, 403, { error: 'Unauthorized' });
      return;
    }
    const syncRes = await userManager.fetchUsersDirectFromSheet();
    if (syncRes.ok) {
      clusterManager.syncUsersToPeers(userManager.listUsers(true), userManager.getSheetConfig().syncSecret);
      try {
        const msg = `🚀 *[ĐỒNG BỘ GOOGLE SHEET TRỰC TIẾP]*\n━━━━━━━━━━━━━━━━━━\n✅ Đã kéo và cập nhật *${syncRes.total}* tài khoản khách hàng thành công!`;
        broadcast(msg);
        sendToZalo(msg);
      } catch (_) {}
    }
    json(res, syncRes.error ? 400 : 200, syncRes);
    return;
  }

  // API: Lấy danh sách Node trong Cluster
  if (req.method === 'GET' && pathname === '/api/cluster/failover') {
    if (currentUser.role !== 'admin') { json(res, 403, { error: 'Chỉ admin' }); return; }
    json(res, 200, failoverCtl ? failoverCtl.getState() : { enabled: false });
    return;
  }

  // Trạng thái đồng bộ danh sách VPS từ Google Sheet (admin)
  if (req.method === 'GET' && pathname === '/api/cluster/sheet-nodes') {
    if (currentUser.role !== 'admin') { json(res, 403, { error: 'Chỉ admin' }); return; }
    json(res, 200, sheetNodesCtl ? sheetNodesCtl.getState() : { enabled: false });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/cluster/nodes') {
    json(res, 200, publicNodes(clusterManager.getNodes(), currentUser));
    return;
  }

  // API: Thêm node (admin) và đồng bộ cho các node khác
  if (req.method === 'POST' && pathname === '/api/cluster/nodes') {
    if (currentUser.role !== 'admin') { json(res, 403, { error: 'Chỉ admin' }); return; }
    const body = await parseBody(req);
    const r = clusterManager.addNode(body || {});
    if (r && r.error) { json(res, 400, r); return; }
    const push = await clusterManager.pushNodesToPeers().catch(() => null);
    json(res, 200, { ok: true, nodes: clusterManager.getNodes(), push });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/cluster/nodes/remove') {
    if (currentUser.role !== 'admin') { json(res, 403, { error: 'Chỉ admin' }); return; }
    const body = await parseBody(req);
    const r = clusterManager.removeNode(body && body.id);
    if (r && r.error) { json(res, 400, r); return; }
    const push = await clusterManager.pushNodesToPeers().catch(() => null);
    json(res, 200, { ok: true, nodes: clusterManager.getNodes(), push });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/cluster/sync-nodes') {
    if (!(isClusterPeer || currentUser.role === 'admin')) { json(res, 403, { error: 'Forbidden' }); return; }
    const body = await parseBody(req);
    const r = clusterManager.replaceNodes((body && body.nodes) || []);
    if (r && r.error) { json(res, 400, r); return; }
    json(res, 200, { ok: true });
    return;
  }

  // API: Giữ chỗ / trả chỗ Stream Key khi đang tạo luồng (Master giữ sổ chung cho cả cụm)
  if (req.method === 'POST' && pathname === '/api/cluster/reserve-key') {
    if (!(isClusterPeer || currentUser.role === 'admin')) { json(res, 403, { error: 'Forbidden' }); return; }
    const body = (await parseBody(req)) || {};
    json(res, 200, { ok: reserveKeyLocal(body.key, String(body.token || ''), !!body.release) });
    return;
  }

  // API: Worker chưa có link Web App → nhờ Master gọi Apps Script tạo/xóa bản sao tạm khi Drive hết lượt tải
  if (req.method === 'POST' && pathname === '/api/cluster/drive-copy') {
    if (!(isClusterPeer || currentUser.role === 'admin')) { json(res, 403, { error: 'Forbidden' }); return; }
    const body = (await parseBody(req)) || {};
    try {
      json(res, 200, await driveQuota.callScriptLocal(String(body.action || ''), String(body.id || ''), body.src ? String(body.src) : undefined));
    } catch (e) {
      json(res, 200, { error: e.message });
    }
    return;
  }

  // API: Worker chuyển thông báo về Master để Master gửi Telegram/Zalo thay
  if (req.method === 'POST' && pathname === '/api/cluster/notify') {
    if (!(isClusterPeer || currentUser.role === 'admin')) { json(res, 403, { error: 'Forbidden' }); return; }
    const body = await parseBody(req);
    const text = body && typeof body.text === 'string' ? body.text : '';
    const channel = body && body.channel;
    if (!text || !['telegram', 'zalo', 'both'].includes(channel)) { json(res, 400, { error: 'Thiếu text/channel' }); return; }
    const fromNode = clusterManager.getNode(String(body.from || ''));
    const fromName = (fromNode && fromNode.name) || String(body.from || 'Worker');
    const full = `📍 *Từ máy: ${fromName}*\n` + text;
    console.log(`[Notify] 📨 Nhận thông báo từ ${fromName} (${channel}): ${text.replace(/\s+/g, ' ').slice(0, 80)}`);
    // Dùng hàm Local để không chuyển tiếp vòng lặp
    if (channel === 'telegram' || channel === 'both') broadcastLocal(full);
    if (channel === 'zalo' || channel === 'both') sendToZaloLocal(full);
    json(res, 200, { ok: true });
    return;
  }

  // API: Đổi mật khẩu bảo mật
  if (req.method === 'POST' && pathname === '/api/change-password') {
    const body = await parseBody(req);
    if (!body || !body.currentPassword || !body.newPassword) {
      json(res, 400, { error: 'Thông tin không hợp lệ!' });
      return;
    }
    const resPw = userManager.changeUserPassword(currentUser.id, body.currentPassword, body.newPassword);
    if (resPw.error) {
      json(res, 400, resPw);
    } else {
      json(res, 200, resPw);
    }
    return;
  }

  // Serve UI
  // PWA: manifest, service worker, icon (danh sách cố định, không phục vụ file tùy ý)
  const PWA_FILES = {
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
    '/icons/icon-180.png': ['icons/icon-180.png', 'image/png'],
    '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
    '/icons/icon-512.png': ['icons/icon-512.png', 'image/png']
  };
  if (req.method === 'GET' && PWA_FILES[pathname]) {
    const [rel, mime] = PWA_FILES[pathname];
    fs.readFile(path.join(__dirname, 'public', rel), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const headers = { 'Content-Type': mime, 'Cache-Control': pathname === '/sw.js' ? 'no-cache' : 'public, max-age=86400' };
      if (pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';
      res.writeHead(200, headers);
      res.end(data);
    });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    const html = path.join(__dirname, 'public', 'index.html');
    fs.readFile(html, (err, data) => {
      if (err) { res.writeHead(500); res.end('UI not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // API: Test Sentinel Notification
  if (req.method === 'POST' && pathname === '/api/sentinel/test') {
    if (currentUser.role !== 'admin') { json(res, 403, { error: 'Chi Admin moi co quyen!' }); return; }
    try {
      const msg = `🔔 *[SENTINEL TEST REPORT]*\n━━━━━━━━━━━━━━━━━━\n🖥️ Server: \`Test Endpoint\`\n💬 Trạng thái test: Đã gửi thông báo liên hợp sang Zalo & Telegram thành công!`;
      broadcast(msg);
      sendToZalo(msg);
      json(res, 200, { ok: true, msg: 'Đã phát lệnh test thành công!' });
    } catch (e) {
      console.error('[API Test] Lỗi gửi test:', e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  // API: Browse file
  if (req.method === 'POST' && pathname === '/api/browse') {
    if (currentUser.role !== 'admin') { json(res, 403, { error: 'Chi Admin moi co quyen!' }); return; }
    const filePath = await browseFile();
    json(res, 200, { path: filePath });
    return;
  }

  // API: Start stream
  if (req.method === 'POST' && pathname === '/api/start') {
    const body = await parseBody(req);
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }

    // Khách thường: xếp hàng theo tài khoản để quota không bị vượt khi bấm Start liên tục
    if (!isForwarded && currentUser.role !== 'admin') {
      const releaseLock = await acquireUserLock(currentUser.id);
      res.on('finish', releaseLock);
      res.on('close', releaseLock);
    }

    let targetServerId = String(body.serverId || 'auto').toLowerCase();
    let autoDecision = null;

    // Request do Master chuyển tiếp: luôn chạy tại máy này, giữ nguyên chủ sở hữu mà Master đã xác thực
    const effOwnerId = (isForwarded && body.ownerId) ? body.ownerId : currentUser.id;
    const effOwnerName = (isForwarded && body.ownerUsername) ? body.ownerUsername : currentUser.username;

    if (isForwarded) {
      targetServerId = localNodeId;
    } else if (targetServerId === 'auto' || targetServerId === 'best' || !targetServerId) {
      // Tự động cân bằng tải giữa các node được phép
      autoDecision = await clusterManager.selectOptimalNode(currentUser.allowedServers, getLocalSysinfo());
      if (autoDecision.full || !autoDecision.nodeId) {
        json(res, 503, { error: `⛔ ${autoDecision.reason}` });
        return;
      }
      targetServerId = autoDecision.nodeId;
      console.log(`[Cluster LoadBalancer] ⚖️ Cân bằng tải tự động cho [${body.name || 'Stream'}]: Chọn ${autoDecision.nodeName} (${autoDecision.reason})`);
    }

    // 1. Kiểm tra giới hạn số luồng (Quota) và quyền dùng server đối với khách (chỉ Master kiểm tra)
    if (!isForwarded && currentUser.role !== 'admin') {
      let userActiveCount = Array.from(streams.values()).filter(s =>
        (s.ownerId === currentUser.id || s.ownerUsername === currentUser.username) &&
        ['live', 'downloading', 'launching', 'reconnecting', 'scheduled'].includes(s.status)
      ).length;

      try {
        const remoteStreams = await clusterManager.fetchAllRemoteStreams();
        userActiveCount += remoteStreams.filter(s =>
          (s.ownerId === currentUser.id || s.ownerUsername === currentUser.username) &&
          ['live', 'downloading', 'launching', 'reconnecting', 'scheduled'].includes(s.status)
        ).length;
      } catch (_) {}

      if (userActiveCount >= currentUser.maxStreams) {
        json(res, 400, { 
          error: `Bạn đã đạt giới hạn tối đa ${currentUser.maxStreams} luồng đồng thời trong gói dịch vụ (Đang dùng: ${userActiveCount}/${currentUser.maxStreams})!` 
        });
        return;
      }

      if (currentUser.allowedServers && !currentUser.allowedServers.includes('all')) {
        const allowed = currentUser.allowedServers.map(s => s.toLowerCase());
        if (!allowed.includes(targetServerId.toLowerCase())) {
          json(res, 403, { error: `Tài khoản của bạn không được cấp phép chạy trên máy chủ ${targetServerId}!` });
          return;
        }
      }
    }

    // 1a. Stream Key trùng với luồng đang hoạt động ở BẤT KỲ máy nào trong cụm -> từ chối (Master kiểm tra toàn cụm)
    if (!isForwarded) {
      // Giữ chỗ key trước (chống 2 người bấm cùng lúc từ 2 máy khác nhau); tạo thất bại thì trả chỗ ngay
      const resToken = `${localNodeId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (body.key && !(await reserveKeyCluster(body.key, resToken))) { json(res, 400, { error: DUP_KEY_ERROR }); return; }
      // Xong request (thành công: luồng đã hiện trong danh sách để kiểm tra trùng; thất bại: trả chỗ) -> luôn trả chỗ
      if (body.key) res.on('finish', () => { reserveKeyCluster(body.key, resToken, true).catch(() => {}); });
      let dupKey = !!findActiveKeyUser(body.key);
      if (!dupKey) {
        try {
          const wantKey = String(body.key || '').trim();
          const remoteAll = await clusterManager.fetchAllRemoteStreams();
          dupKey = !!wantKey && remoteAll.some(s => String(s.key || '').trim() === wantKey && KEY_ACTIVE_STATUSES.includes(s.status));
        } catch (_) {}
      }
      if (dupKey) { json(res, 400, { error: DUP_KEY_ERROR }); return; }
    }

    // 1b. Máy này quá tải (RAM/CPU/ổ đĩa) -> không nhận thêm luồng mới
    if (isForwarded || targetServerId === localNodeId) {
      const fullReason = localFullReason();
      if (fullReason) {
        console.warn(`[Capacity] ⛔ Từ chối luồng mới tại ${localNodeId}: ${fullReason}`);
        json(res, 503, { error: `⛔ Máy chủ ${localNodeId} đã đầy tài nguyên (${fullReason}), tạm ngưng nhận luồng mới!` });
        return;
      }
    }

    // 2. Điều phối sang máy chủ khác trong cụm (nếu đích không phải máy này)
    if (!isForwarded && targetServerId !== localNodeId) {
      if (!clusterManager.hasNode(targetServerId)) {
        json(res, 400, { error: `Không tìm thấy máy chủ [${targetServerId}] trong cụm!` });
        return;
      }
      const remoteRes = await clusterManager.forwardStreamAction(targetServerId, 'start', {
        ...body,
        ownerId: currentUser.id,
        ownerUsername: currentUser.username,
        serverId: targetServerId
      });

      // FAILOVER TỰ ĐỘNG: máy đích không phản hồi -> chạy ngay tại máy này
      const _connFail = remoteRes && remoteRes.error && (/^Lỗi kết nối/.test(remoteRes.error) || remoteRes.error === 'Unauthorized');
      const _localAllowed = currentUser.role === 'admin' || !currentUser.allowedServers ||
        currentUser.allowedServers.map(s => String(s).toLowerCase()).some(s => s === 'all' || s === String(localNodeId).toLowerCase());
      if (_connFail && autoDecision && _localAllowed && !localFullReason()) {
        const failedNode = (clusterManager.getNode(targetServerId) || {}).name || targetServerId;
        console.warn(`[Cluster Failover] ⚠️ ${failedNode} không phản hồi (${remoteRes.error}). Chạy tại máy này (${localNodeId})!`);
        const localFallback = startStream({
          ...body,
          ownerId: currentUser.id,
          ownerUsername: currentUser.username,
          serverId: localNodeId
        });
        if (localFallback && !localFallback.error) {
          localFallback.notice = `⚠️ Luồng đã tự động chuyển sang chạy trên ${localNodeId} do ${failedNode} gặp sự cố kết nối (Auto Failover).`;
          try {
            const _msg = `🛡️ *[TỰ ĐỘNG CỨU HỘ KHI KHỞI TẠO LUỒNG]*\n━━━━━━━━━━━━━━━━━━\n` +
              `🕒 Thời gian: \`${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}\`\n` +
              `🔌 Máy sự cố: *${escapeMarkdown(failedNode)}*\n` +
              `🖥️ Máy xử lý: *${escapeMarkdown((clusterManager.getNode(localNodeId) || {}).name || localNodeId)}*\n` +
              `🏷️ Luồng: *${escapeMarkdown(body.name || ('#' + localFallback.id))}* (#${localFallback.id}, key …${escapeMarkdown(String(body.key || '').slice(-4))})\n` +
              `💬 Lý do: ${escapeMarkdown(remoteRes.error)}\n` +
              `✅ Luồng đã tự động chạy trên máy này.`;
            try { broadcast(_msg); } catch (_) {}
            sendToZalo(_msg);
          } catch (_) {}
        }
        json(res, localFallback.error ? 400 : 200, localFallback);
        return;
      }

      if (remoteRes && !remoteRes.error && autoDecision) {
        remoteRes.autoBalanced = true;
        remoteRes.serverName = autoDecision.nodeName;
        remoteRes.balanceReason = autoDecision.reason;
      }

      json(res, remoteRes.error ? 400 : 200, remoteRes);
      return;
    }

    // 3. Khởi chạy luồng tại máy này
    const result = startStream({
      ...body,
      ownerId: effOwnerId,
      ownerUsername: effOwnerName,
      serverId: localNodeId
    });

    if (result && !result.error && autoDecision) {
      result.autoBalanced = true;
      result.serverName = autoDecision.nodeName;
      result.balanceReason = autoDecision.reason;
    }

    json(res, result.error ? 400 : 200, result);
    return;
  }

  // API: Edit stream
  if (req.method === 'POST' && pathname === '/api/edit') {
    const body = await parseBody(req);
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
    const streamId = Number(body.id);
    const targetServerId = String(body.serverId || localNodeId).toLowerCase();

    // Đổi sang Stream Key đang chạy ở BẤT KỲ máy nào trong cụm -> từ chối (trước đây chỉ kiểm tra trong 1 máy)
    if (!isForwarded && body.key && await clusterKeyConflict(body.key, streamId, targetServerId)) {
      json(res, 400, { error: DUP_KEY_ERROR });
      return;
    }

    if (!isForwarded && targetServerId !== localNodeId && clusterManager.hasNode(targetServerId)) {
      if (!(await remoteOwnerOk(targetServerId, streamId, currentUser))) {
        json(res, 403, { error: 'Bạn không có quyền chỉnh sửa luồng này!' });
        return;
      }
      const resRemote = await clusterManager.forwardStreamAction(targetServerId, 'edit', body);
      json(res, resRemote.error ? 404 : 200, resRemote);
      return;
    }

    const s = streams.get(streamId);
    if (s && currentUser.role !== 'admin' && s.ownerId !== currentUser.id && s.ownerUsername !== currentUser.username) {
      json(res, 403, { error: 'Bạn không có quyền chỉnh sửa luồng này!' });
      return;
    }
    const result = editStreamLocal(body);
    json(res, result.error ? 404 : 200, result);
    return;
  }

  // API: Stop stream
  if (req.method === 'POST' && pathname === '/api/stop') {
    const body = await parseBody(req);
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
    const streamId = Number(body.id);
    const targetServerId = String(body.serverId || localNodeId).toLowerCase();

    if (!isForwarded && targetServerId !== localNodeId && clusterManager.hasNode(targetServerId)) {
      if (!(await remoteOwnerOk(targetServerId, streamId, currentUser))) {
        json(res, 403, { error: 'Bạn không có quyền dừng luồng này!' });
        return;
      }
      const resRemote = await clusterManager.forwardStreamAction(targetServerId, 'stop', body);
      json(res, resRemote && resRemote.error ? (/^Lỗi kết nối/.test(resRemote.error) ? 502 : 404) : 200, resRemote);
      return;
    }

    const s = streams.get(streamId);
    if (s && currentUser.role !== 'admin' && s.ownerId !== currentUser.id && s.ownerUsername !== currentUser.username) {
      json(res, 403, { error: 'Bạn không có quyền dừng luồng này!' });
      return;
    }
    if (!s) {
      json(res, 404, { error: 'Không tìm thấy luồng trên máy chủ này (kiểm tra lại serverId)' });
      return;
    }
    stopStream(streamId);
    json(res, 200, { ok: true });
    return;
  }

  // API: Restart stream
  if (req.method === 'POST' && pathname === '/api/restart') {
    const body = await parseBody(req);
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
    const streamId = Number(body.id);
    const targetServerId = String(body.serverId || localNodeId).toLowerCase();

    if (!isForwarded && targetServerId !== localNodeId && clusterManager.hasNode(targetServerId)) {
      if (!(await remoteOwnerOk(targetServerId, streamId, currentUser))) {
        json(res, 403, { error: 'Bạn không có quyền khởi động lại luồng này!' });
        return;
      }
      if (!isForwarded) {
        try {
          const remoteAll = await clusterManager.fetchAllRemoteStreams();
          const tgt = remoteAll.find(x => x.id === streamId && String(x.serverId || '').toLowerCase() === targetServerId);
          if (tgt && tgt.key && await clusterKeyConflict(tgt.key, streamId, targetServerId)) { json(res, 400, { error: DUP_KEY_ERROR }); return; }
        } catch (_) {}
      }
      const resRemote = await clusterManager.forwardStreamAction(targetServerId, 'restart', body);
      json(res, resRemote.error ? 400 : 200, resRemote);
      return;
    }

    const s = streams.get(streamId);
    if (s && currentUser.role !== 'admin' && s.ownerId !== currentUser.id && s.ownerUsername !== currentUser.username) {
      json(res, 403, { error: 'Bạn không có quyền khởi động lại luồng này!' });
      return;
    }
    if (s && !isForwarded && await clusterKeyConflict(s.key, streamId, localNodeId)) { json(res, 400, { error: DUP_KEY_ERROR }); return; }
    const result = restartStream(streamId);
    if (result.error) {
       json(res, 400, result);
    } else {
       json(res, 200, result);
    }
    return;
  }

  // API: Xóa các luồng đã dừng/kết thúc
  if (req.method === 'POST' && pathname === '/api/clear') {
    try { captureFinished(); } catch (_) {}
    const cbody = (await parseBody(req).catch(() => null)) || {};
    // Request do Master chuyển tiếp: chỉ xóa luồng thuộc chủ sở hữu mà Master đã xác thực (trừ khi là Admin)
    const scopeAll = isForwarded ? !!cbody.clearAll : currentUser.role === 'admin';
    const scopeId = isForwarded ? cbody.ownerId : currentUser.id;
    const scopeName = isForwarded ? cbody.ownerUsername : currentUser.username;
    let count = 0;
    for (const [id, s] of streams) {
      if (s.status === 'stopped' || s.status === 'ended') {
        if (scopeAll || (scopeId && s.ownerId === scopeId) || (scopeName && s.ownerUsername === scopeName)) {
          cleanupFile(s.file);
          streams.delete(id);
          count++;
        }
      }
    }
    cleanupOrphanedFiles();
    if (!isForwarded) {
      const payload = { clearAll: currentUser.role === 'admin', ownerId: currentUser.id, ownerUsername: currentUser.username };
      const remotes = clusterManager.getNodes().filter(n => !n.isLocal);
      const results = await Promise.all(remotes.map(n =>
        clusterManager.forwardStreamAction(n.id, 'clear', payload).catch(() => ({}))
      ));
      results.forEach(r => { if (r && typeof r.cleared === 'number') count += r.cleared; });
    }
    json(res, 200, { cleared: count });
    return;
  }


  // Hàm hỗ trợ tính toán CPU phần trăm thực tế dựa trên chênh lệch thời gian CPU (CPU Time Delta)
  function getCpuUsage() {
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) return lastCpuPct;
    
    let totalUser = 0, totalNice = 0, totalSys = 0, totalIdle = 0, totalIrq = 0;
    for (let i = 0; i < cpus.length; i++) {
      const t = cpus[i].times;
      totalUser += t.user;
      totalNice += t.nice;
      totalSys += t.sys;
      totalIdle += t.idle;
      totalIrq += t.irq;
    }
    
    const total = totalUser + totalNice + totalSys + totalIdle + totalIrq;
    const idle = totalIdle;
    
    if (lastCpuTimes) {
      const diffTotal = total - lastCpuTimes.total;
      const diffIdle = idle - lastCpuTimes.idle;
      if (diffTotal > 0) {
        const pct = Math.round((1 - diffIdle / diffTotal) * 100);
        lastCpuPct = Math.max(0, Math.min(100, pct));
      }
    }
    
    lastCpuTimes = { total, idle };
    return lastCpuPct;
  }

  // Hàm hỗ trợ đọc dung lượng đĩa thực tế trên Windows & Linux không treo luồng
  function getDiskInfo() {
    const dc = globalThis.__diskCache;
    if (dc && Date.now() - dc.at < 60000) return dc.val;
    const val = getDiskInfoRaw();
    globalThis.__diskCache = { at: Date.now(), val };
    return val;
  }
  function getDiskInfoRaw() {
    let diskTotalStr = '120 GB';
    let diskUsedStr = '38.2 GB';
    let diskUsagePct = 32;
    
    try {
      if (os.platform() === 'win32') {
        // Lấy dung lượng ổ đĩa C trên Windows bằng wmic
        const output = execSync('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace,Size /format:list', { 
          encoding: 'utf8', 
          timeout: 2000, 
          stdio: ['pipe', 'pipe', 'ignore'] 
        });
        const freeMatch = output.match(/FreeSpace=(\d+)/i);
        const sizeMatch = output.match(/Size=(\d+)/i);
        if (freeMatch && sizeMatch) {
          const free = parseInt(freeMatch[1], 10);
          const size = parseInt(sizeMatch[1], 10);
          if (size > 0) {
            const used = size - free;
            diskUsagePct = Math.round((used / size) * 100);
            diskTotalStr = (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
            diskUsedStr = (used / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
          }
        }
      } else {
        // Lấy dung lượng thư mục gốc / trên Linux/VPS bằng df
        const output = execSync('df -k /', { 
          encoding: 'utf8', 
          timeout: 2000, 
          stdio: ['pipe', 'pipe', 'ignore'] 
        });
        const lines = output.trim().split('\n');
        if (lines.length > 1) {
          const parts = lines[1].replace(/\s+/g, ' ').split(' ');
          if (parts.length >= 4) {
            // df -k trả về đơn vị KB
            const totalKB = parseInt(parts[1], 10);
            const usedKB = parseInt(parts[2], 10);
            if (totalKB > 0) {
              diskUsagePct = Math.round((usedKB / totalKB) * 100);
              diskTotalStr = (totalKB / (1024 * 1024)).toFixed(1) + ' GB';
              diskUsedStr = (usedKB / (1024 * 1024)).toFixed(1) + ' GB';
            }
          }
        }
      }
    } catch (err) {
      console.error('[System] Lỗi đọc dung lượng đĩa thật:', err.message);
    }
    
    return {
      total: diskTotalStr,
      used: diskUsedStr,
      usage: diskUsagePct
    };
  }

  // Hàm hỗ trợ đọc tổng số Bytes nhận và gửi thực tế trên Windows & Linux
  function getNetworkBytes() {
    let rx = 0;
    let tx = 0;
    try {
      if (os.platform() === 'win32') {
        const output = execSync('powershell -Command "Get-NetAdapterStatistics | Select-Object ReceivedBytes, SentBytes | ConvertTo-Json"', {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        if (output) {
          const parsed = JSON.parse(output);
          if (Array.isArray(parsed)) {
            parsed.forEach(item => {
              rx += parseInt(item.ReceivedBytes || 0, 10);
              tx += parseInt(item.SentBytes || 0, 10);
            });
          } else if (parsed && typeof parsed === 'object') {
            rx = parseInt(parsed.ReceivedBytes || 0, 10);
            tx = parseInt(parsed.SentBytes || 0, 10);
          }
        }
      } else {
        // Đọc tệp /proc/net/dev trên Linux/VPS
        if (fs.existsSync('/proc/net/dev')) {
          const content = fs.readFileSync('/proc/net/dev', 'utf8');
          const lines = content.split('\n');
          lines.forEach(line => {
            if (line.includes(':')) {
              const parts = line.split(':');
              const devName = parts[0].trim();
              if (devName !== 'lo') {
                const cols = parts[1].trim().replace(/\s+/g, ' ').split(' ');
                if (cols.length >= 9) {
                  rx += parseInt(cols[0] || 0, 10);
                  tx += parseInt(cols[8] || 0, 10);
                }
              }
            }
          });
        }
      }
    } catch (err) {
      console.error('[System] Lỗi đọc lưu lượng mạng thật:', err.message);
    }
    return { rx, tx };
  }

  // Trả về lý do nếu máy này đã quá tải (không nhận thêm luồng mới), ngược lại trả về null
  function localFullReason() {
    try {
      const ramPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);
      const disk = getDiskInfo();
      const cap = clusterManager.nodeCapacity({ ramUsage: ramPct, cpuUsage: lastCpuPct, diskUsage: disk && disk.usage });
      return cap.full ? cap.reason : null;
    } catch (_) { return null; }
  }

  // Hàm tính toán dữ liệu Telemetry tổng thể của VPS cục bộ
  function getLocalSysinfo() {
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const usedMem = totalMem - freeMem;
    const memUsagePct = Math.round((usedMem / totalMem) * 100);
    
    const cpus = os.cpus();
    const cpuCount = cpus.length;
    const cpuModel = cpuCount > 0 ? cpus[0].model.replace(/\s+/g, ' ').trim() : 'Generic CPU';
    
    const cpuUsagePct = getCpuUsage();
    const disk = getDiskInfo();
    
    const now = Date.now();
    const currentNetBytes = getNetworkBytes();
    
    let netTxStr = lastNetTxStr;
    let netRxStr = lastNetRxStr;
    
    if (lastNetTime && lastRxBytes !== null && lastTxBytes !== null) {
      const elapsedSec = (now - lastNetTime) / 1000;
      if (elapsedSec > 0.5) {
        const rxDiff = currentNetBytes.rx - lastRxBytes;
        const txDiff = currentNetBytes.tx - lastTxBytes;
        
        if (rxDiff >= 0 && txDiff >= 0) {
          const rxSpeedBps = rxDiff / elapsedSec;
          const txSpeedBps = txDiff / elapsedSec;
          
          const rxSpeedKbps = (rxSpeedBps * 8) / 1024;
          const txSpeedKbps = (txSpeedBps * 8) / 1024;
          
          netRxStr = rxSpeedKbps > 1000 ? (rxSpeedKbps / 1024).toFixed(1) + ' Mbps' : Math.round(rxSpeedKbps) + ' Kbps';
          netTxStr = txSpeedKbps > 1000 ? (txSpeedKbps / 1024).toFixed(1) + ' Mbps' : Math.round(txSpeedKbps) + ' Kbps';
          
          lastNetRxStr = netRxStr;
          lastNetTxStr = netTxStr;
        }
      }
    }
    
    lastNetTime = now;
    lastRxBytes = currentNetBytes.rx;
    lastTxBytes = currentNetBytes.tx;
    
    const uptimeSec = os.uptime();
    const d = Math.floor(uptimeSec / (3600 * 24));
    const h = Math.floor((uptimeSec % (3600 * 24)) / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = d > 0 ? `${d} ngày ${h} giờ ${m} phút` : `${h} giờ ${m} phút`;
    
    return {
      platform: os.platform() === 'win32' ? 'Windows OS Host' : 'Linux VPS (Ubuntu)',
      cpuModel: cpuModel,
      cpuUsage: cpuUsagePct,
      ramTotal: (totalMem / (1024 * 1024 * 1024)).toFixed(1) + ' GB',
      ramUsed: (usedMem / (1024 * 1024 * 1024)).toFixed(1) + ' GB',
      ramUsage: memUsagePct,
      diskTotal: disk.total,
      diskUsed: disk.used,
      diskUsage: disk.usage,
      vpsUptime: uptimeStr,
      nodeVersion: process.version,
      netSpeedTx: netTxStr,
      netSpeedRx: netRxStr,
      activeStreams: Array.from(streams.values()).filter(s => ['live', 'downloading', 'launching'].includes(s.status)).length,
      balanceStreams: Array.from(streams.values()).filter(s => ['live', 'downloading', 'launching', 'reconnecting', 'scheduled'].includes(s.status)).length,
      capacityFull: localFullReason()
    };
  }

  // API: Get VPS system telemetry (chỉ Admin / máy đối tác trong cụm)
  if (req.method === 'GET' && pathname === '/api/sysinfo') {
    if (currentUser.role !== 'admin') { json(res, 403, { error: 'Chỉ Admin mới được xem thông số máy chủ!' }); return; }
    try {
      json(res, 200, getLocalSysinfo());
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // API: Xem trước báo cáo TỔNG QUÁT cả cụm (nội dung y hệt tin Telegram/Zalo gửi định kỳ) - chỉ Admin
  if (req.method === 'GET' && pathname === '/api/cluster/report') {
    if (currentUser.role !== 'admin') { json(res, 403, { error: 'Chỉ Admin mới được xem báo cáo cụm!' }); return; }
    try {
      const ov = await getClusterOverview();
      json(res, 200, { overview: ov, messages: formatClusterReport(ov) });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // API: Get Combined Cluster Telemetry (tất cả VPS trong cụm) - Admin xem chi tiết, khách chỉ nhận danh sách máy chủ được phép
  if (req.method === 'GET' && pathname === '/api/cluster/sysinfo') {
    try {
      if (currentUser.role !== 'admin') {
        json(res, 200, { restricted: true, local: null, nodes: publicNodes(clusterManager.getNodes(), currentUser) });
        return;
      }
      json(res, 200, {
        local: getLocalSysinfo(),
        nodes: publicNodes(clusterManager.getNodes(), currentUser)
      });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // API: Lịch sử luồng — Admin xem toàn bộ cụm, khách CHỈ xem lịch sử của chính mình
  if (req.method === 'GET' && pathname === '/api/history') {
    try { captureFinished(); } catch (_) {}
    const isAdminUser = currentUser.role === 'admin';
    const mine = e => isAdminUser || e.ownerId === currentUser.id || e.ownerUsername === currentUser.username;
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit')) || 200, 1), 1000);
    let list = history.filter(mine);
    if (!isForwarded) {
      try {
        const remote = await clusterManager.fetchAllRemoteHistory();
        list = list.concat(remote.filter(mine));
      } catch (_) {}
    }
    list.sort((a, b) => (Date.parse(b.endedAt) || 0) - (Date.parse(a.endedAt) || 0));
    json(res, 200, list.slice(0, limit));
    return;
  }

  // API: List streams (Tự động gom luồng từ cả 2 VPS và lọc quyền riêng tư theo khách hàng)
  if (req.method === 'GET' && pathname === '/api/streams') {
    const list = [];
    for (const [, s] of streams) {
      let displayFile = path.basename(s.file);
      if (s.file.includes('drive.google.com') || s.file.includes('view?usp=')) {
        displayFile = 'Google Drive Video';
      } else if (displayFile.startsWith('drive_video_')) {
        displayFile = 'Google Drive Video';
      }

      const isOwner = (s.ownerId === currentUser.id || s.ownerUsername === currentUser.username);
      // Nếu là khách hàng bình thường, chỉ xem luồng của chính mình
      if (currentUser.role !== 'admin' && !isOwner) {
        continue;
      }

      list.push({
        id: s.id,
        name: s.name || '',
        key: currentUser.role === 'admin' || isOwner ? s.key : (s.key.substring(0, 6) + '****'),
        keyHint: s.key.substring(0, 6) + '****',
        file: displayFile,
        originalFile: s.originalFile || s.file,
        mode: s.mode,
        minutes: s.minutes || 0,
        scheduledMode: s.scheduledMode || 'loop',
        status: s.status,
        startTime: s.startTime,
        scheduledTime: s.scheduledTime,
        lastLog: s.lastLog || '',
        retryCount: s.retryCount || 0,
        dualStream: !!s.dualStream,
        streamAActive: s.streamAActive !== false,
        streamBActive: s.streamBActive !== false,
        streamALog: s.streamALog || '',
        streamBLog: s.streamBLog || '',
        dlBytes: s.dlBytes || 0,
        totalBytes: s.totalBytes || 0,
        dlPercent: s.dlPercent !== undefined ? s.dlPercent : null,
        dlSpeed: s.dlSpeed || 0,
        youtubeUrl: s.youtubeUrl || '',
        ownerId: s.ownerId || 'admin_root',
        ownerUsername: s.ownerUsername || 'admin',
        serverId: localNodeId,
        serverName: (clusterManager.getNode(localNodeId) || {}).name || localNodeId,
        isRemote: false,
        firstLiveTime: s.firstLiveTime || null,
        createdAt: s.createdAt || null,
        updatedAt: s.updatedAt || null,
        sessionUid: ensureSession(s) || null
      });
    }

    // Kéo luồng từ TẤT CẢ máy chủ khác trong cụm (bỏ qua nếu là request do node khác gọi, tránh đệ quy)
    if (!isForwarded) {
      try {
        const remoteStreams = await clusterManager.fetchAllRemoteStreams();
        remoteStreams.forEach(rs => {
          const isOwner = (rs.ownerId === currentUser.id || rs.ownerUsername === currentUser.username);
          if (currentUser.role === 'admin' || isOwner) {
            list.push({
              ...rs,
              key: currentUser.role === 'admin' || isOwner ? rs.key : (String(rs.key || '').substring(0, 6) + '****'),
              keyHint: String(rs.key || '').substring(0, 6) + '****'
            });
          }
        });
      } catch (_) {}
    }

    json(res, 200, list);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ─── Khởi tạo Telegram Bot ────────────────────────────────────────────────────
// Tổng quan CẢ CỤM cho Telegram/Zalo: cùng dữ liệu dashboard web (telemetry mỗi VPS + luồng từ mọi máy, kèm tên máy)
async function getClusterOverview() {
  const local = sysinfoFn ? sysinfoFn() : null;
  // Làm mới telemetry máy từ xa nếu đã cũ (>15s) để báo cáo không dùng số liệu lỗi thời
  await Promise.all(clusterManager.getNodes()
    .filter(n => !n.isLocal && Date.now() - (n.lastSeen || 0) > 15000)
    .map(n => { const real = clusterManager.getNode(n.id); return real ? clusterManager.refreshNodeTelemetry(real) : null; }));
  const nodes = clusterManager.getNodes().map(n => n.isLocal ? { ...n, status: 'online', telemetry: local } : n);
  const localName = (clusterManager.getNode(localNodeId) || {}).name || localNodeId;
  const localStreams = Array.from(streams.values()).map(s => ({
    id: s.id, name: s.name || '', status: s.status, mode: s.mode, startTime: s.startTime,
    scheduledTime: s.scheduledTime, lastLog: s.lastLog || '', dualStream: !!s.dualStream,
    streamAActive: s.streamAActive !== false, streamBActive: s.streamBActive !== false,
    serverId: localNodeId, serverName: localName, isRemote: false
  }));
  let remote = [];
  try { remote = await clusterManager.fetchAllRemoteStreams(); } catch (_) {}
  return { localNodeId, nodes, streams: localStreams.concat(remote) };
}

// === Chỉ Master gửi thông báo Telegram/Zalo; Worker chuyển tiếp về Master (đặt NOTIFY_FROM_ALL=1 để mọi máy tự gửi như cũ) ===
const BOOT_TS = Date.now();
function isLocalMaster() {
  // Chưa nhận diện được vai trò (IP không khớp danh sách) quá 90s -> cư xử như bản cũ (tự nhận lệnh/gửi báo cáo), tránh mất bot
  if (!localRoleConfirmed) return Date.now() - BOOT_TS > 90000;
  return !!(clusterManager.getNode(localNodeId) || {}).isMaster;
}
function routeNotify(channel, text) {
  if (process.env.NOTIFY_FROM_ALL === '1') return false;
  if (!localRoleConfirmed || isLocalMaster()) return false;
  const masterNode = clusterManager.getNodes().find(n => n.isMaster && n.id !== localNodeId);
  if (!masterNode) return false;
  clusterManager.callNodeApi(masterNode, '/api/cluster/notify', 'POST', { channel, text, from: localNodeId }, 6000)
    .then(r => {
      if (r && r.statusCode === 200) {
        console.log(`[Notify] ➡️ Đã chuyển thông báo (${channel}) về Master ${masterNode.name || masterNode.id}`);
      } else {
        throw new Error('HTTP ' + (r && r.statusCode));
      }
    })
    .catch(e => {
      console.log(`[Notify] ⚠️ Không chuyển được về Master (${e.message}) -> tự gửi tại máy này`);
      if (channel === 'zalo') sendToZaloLocal(text); else broadcastLocal(text);
    });
  return true;
}
setNodeRole(isLocalMaster);
setNotifyRouter(routeNotify);

initBot({
  getClusterOverview,
  getNodeByIp: (ip) => clusterManager.getNodes().find(n => n.ip === ip) || null,
  startStream,
  stopStream,
  restartStream,
  editStream: editStreamLocal,
  getStreams: () => Array.from(streams.values()),
  clearStreams: () => {
    let count = 0;
    for (const [id, s] of streams) {
      if (s.status === 'stopped' || s.status === 'ended') {
        cleanupFile(s.file);
        streams.delete(id);
        count++;
      }
    }
    cleanupOrphanedFiles();
    saveStreams();
    return count;
  },
  getLogs: (id) => {
    const s = streams.get(id);
    return s ? (s._fullLogs || 'Chưa có log chi tiết.') : 'Không tìm thấy luồng.';
  },
  deleteStream: (id) => {
    const s = streams.get(id);
    if (s) {
      if (s.process) {
        try { s.process.kill(); } catch (_) {}
      }
      // Xóa khi đang chạy: ghi lịch sử "Đã dừng" trước (dòng "Đang live" trên Sheet được cập nhật, không bị treo)
      if (s.status !== 'stopped' && s.status !== 'ended') {
        if (s.sessionUid) { s.status = 'stopped'; try { recordFinished(s); } catch (_) {} }
      }
      cleanupFile(s.file);
      streams.delete(id);
      cleanupOrphanedFiles();
      saveStreams();
      return true;
    }
    return false;
  },
  rebootServer: () => {
    console.log('[System] Bot yêu cầu khởi động lại (Reboot)...');
    process.exit(1);
  }
});

// Cổng kiểm tra sâu: cấp cho diagnostics.js các hàm đọc trạng thái (không cho quyền bật/tắt/sửa luồng)
diagnostics.init({
  rootDir: __dirname,
  dirs: { downloads: DOWNLOAD_DIR, temp: path.join(__dirname, 'diag_tmp') },
  getStreams: () => Array.from(streams.values()),
  getHistory: () => history,
  nodeId: () => localNodeId,
  isMaster: () => localRoleConfirmed && !!(clusterManager.getNode(localNodeId) || {}).isMaster,
  roleConfirmed: () => localRoleConfirmed,
  streamsReady: () => streamsReady,
  sysinfo: () => (sysinfoFn ? sysinfoFn() : null),
  failoverState: () => (failoverCtl ? { enabled: true, ...failoverCtl.getState() } : { enabled: false }),
  dailyClean: () => ({ enabled: process.env.DAILY_CLEAN !== '0', time: DAILY_CLEAN_TIME, keepMin: Math.round(DAILY_CLEAN_KEEP_MS / 60000), lastDay: _dailyCleanDay }),
  legacyAdminWeak: () => authConfig.password === 'admin' && process.env.ALLOW_DEFAULT_ADMIN === '1',
  clusterManager, userManager, driveQuota, downloadGoogleDriveFile, extractDriveId,
});

server.listen(PORT, '0.0.0.0', async () => {
  // Mồi 1 request nội bộ để gán sysinfoFn ngay (trước đây chỉ được gán ở request HTTP đầu tiên -> báo cáo/failover lúc khởi động thiếu số liệu máy này)
  try { http.get(`http://127.0.0.1:${PORT}/api/health`, r => r.resume()).on('error', () => {}); } catch (_) {}
  const ffmpegOk = await checkFFmpeg();
  if (!ffmpegOk) {
    console.log('⚠️ Cảnh báo: Hệ thống có thể không hoạt động đúng do thiếu FFmpeg.');
  }
  // Chờ nhận diện vai trò node (tối đa 7s) để luồng khôi phục gắn đúng serverId
  for (let i = 0; i < 14 && !localRoleConfirmed; i++) await new Promise(r => setTimeout(r, 500));
  loadHistory(); // Nap lich su luong da luu
  loadStreams(); // Khôi phục danh sách luồng trước
  streamsReady = true;
  autoJoinCluster().catch(e => console.error('[AutoJoin] Lỗi:', e.message)); // chỉ chạy khi có MASTER_URL
  // Đồng bộ danh sách VPS từ tab Google Sheet (chỉ chạy khi có NODES_SHEET_URL hoặc nodesSheetUrl trong sheet_config.json)
  try {
    sheetNodesCtl = require('./sheetNodes').init({
      clusterManager, userManager, localNodeId: () => localNodeId,
      notify: (m) => { try { broadcast(m); } catch (_) {} try { sendToZalo(m); } catch (_) {} }
    });
  } catch (e) { console.error('[SheetNodes] Không khởi động được:', e.message); }
  // Master tự động chuyển luồng đang chạy sang máy khác khi một Worker bị chết (xem failover.js)
  try {
    failoverCtl = require('./failover').init({
      clusterManager, userManager, startStream, extractDriveId,
      getLocalSysinfo: () => (sysinfoFn ? sysinfoFn() : null),
      localNodeId: () => localNodeId,
      notify: (m) => { console.log(`[Failover][Thông báo]\n${m}`); try { broadcast(m); } catch (_) {} try { sendToZalo(m); } catch (_) {} }
    });
  } catch (e) { console.error('[Failover] Không khởi động được:', e.message); }
  // Ghi lịch sử luồng của cả cụm lên tab LICH_SU_LUONG trong Google Sheet tài khoản (chỉ Master đẩy)
  try {
    require('./historySheet').init({
      userManager, clusterManager,
      isMaster: () => localRoleConfirmed && !!(clusterManager.getNode(localNodeId) || {}).isMaster,
      getLocalHistory: () => { try { captureFinished(); } catch (_) {} return history; },
      // Luồng đang hoạt động trên máy này (ghi dòng "Đang live"... lên Sheet, kết thúc thì cập nhật cùng dòng)
      getLocalActive: () => {
        let fresh = false;
        const list = Array.from(streams.values()).filter(s => KEY_ACTIVE_STATUSES.includes(s.status)).map(s => {
          if (!s.sessionUid) fresh = true;
          const src = s.originalFile || s.file || '';
          return {
            sessionUid: ensureSession(s), id: s.id, name: s.name || '', key: s.key || '',
            ownerUsername: s.ownerUsername || 'admin', serverId: s.serverId || localNodeId,
            mode: s.mode, status: s.status, youtubeUrl: s.youtubeUrl || '',
            file: /^https?:/i.test(src) ? (/drive\.google/i.test(src) ? 'Google Drive Video' : 'Link video') : path.basename(src),
            firstLiveTime: s.firstLiveTime || null, createdAt: s.createdAt || null,
          };
        });
        if (fresh) { try { saveStreams(); } catch (_) {} } // lưu UID phiên ngay → khởi động lại vẫn cập nhật đúng dòng cũ
        return list;
      },
      nameOf: (id) => (clusterManager.getNode(id) || {}).name || id,
    });
  } catch (e) { console.error('[HistorySheet] Không khởi động được:', e.message); }
  cleanupOrphanedFiles(); // Sau đó mới dọn dẹp các file không nằm trong danh sách
  
  // Tự động quét dọn định kỳ mỗi 1 tiếng
  setInterval(() => cleanupOrphanedFiles(), 60 * 60 * 1000);
  // Giám sát đĩa/RAM mỗi 2 phút: đĩa ≥ DISK_CLEAN_PCT → dọn khẩn cấp; RAM ≥ RAM_WARN_PCT → cảnh báo
  setInterval(monitorResources, parseInt(process.env.RESOURCE_MONITOR_MS, 10) || 2 * 60 * 1000).unref();
  // Tự động dọn các luồng đã kết thúc/dừng quá hạn lưu (kiểm tra mỗi 10 phút)
  setInterval(purgeFinishedStreams, parseInt(process.env.PURGE_INTERVAL_MS) || 10 * 60 * 1000);
  // Dọn dẹp cuối ngày (kiểm tra mỗi phút, chạy 1 lần/ngày vào DAILY_CLEAN_TIME giờ VN)
  if (process.env.DAILY_CLEAN !== '0') {
    _dailyCleanDay = vnClock().day; // khởi động sau giờ dọn thì để tới tối mai, không xóa ngay lúc vừa bật máy
    const [dh, dm] = DAILY_CLEAN_TIME.split(':').map(Number);
    if (vnClock().minutes < dh * 60 + dm) _dailyCleanDay = null;
    setInterval(() => dailyCleanup(), 60 * 1000).unref();
    console.log(`[Cleanup] 🌙 Bật dọn dẹp cuối ngày lúc ${DAILY_CLEAN_TIME} (giờ VN): xóa luồng đã dừng/kết thúc.`);
  }
  
  const addr = `http://localhost:${PORT}`;
  console.log('\n╔══════════════════════════════════════╗');
  console.log(`║  🎬 YouTube Live Controller PRO       ║`);
  console.log(`║  ${addr}              ║`);
  console.log('╚══════════════════════════════════════╝\n');
});

// Ghi log chi tiết
function updateStreamLog(id, data) {
  const s = streams.get(id);
  if (!s) return;
  s._fullLogs = (s._fullLogs || '') + data.toString();
  if (s._fullLogs.length > 5000) s._fullLogs = s._fullLogs.slice(-5000);
}
