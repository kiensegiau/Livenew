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
const { initBot, broadcast, updateProgress, sendToZalo } = require('./telegramBot');
const userManager = require('./userManager');
const clusterManager = require('./clusterManager');

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
  if (!s || s._histLogged) return;
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
    uid: `${s.serverId || localNodeId}-${s.id}-${Date.parse(endedAt)}`,
    id: s.id,
    name: s.name || '',
    keyMask: s.key ? '••••' + String(s.key).slice(-4) : '',
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
  scheduleHistorySave();
}

// Quét toàn bộ luồng, ghi lịch sử cho các luồng vừa kết thúc mà chưa được ghi
function captureFinished() {
  for (const s of streams.values()) {
    if (s.status !== 'stopped' && s.status !== 'ended') { if (s._histLogged) delete s._histLogged; continue; }
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
    firstLiveTime: s.firstLiveTime || null
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
        // Khôi phục các luồng chưa kết thúc
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
              proceedStartStream(s.id);
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

function cleanupOrphanedFiles() {
  console.log('[System] 🧹 Đang quét dọn dẹp tự động các file video tạm không sử dụng...');
  if (!fs.existsSync(DOWNLOAD_DIR)) return;
  
  fs.readdir(DOWNLOAD_DIR, (err, files) => {
    if (err) return console.error('[Cleanup] Không thể đọc thư mục downloads:', err.message);
    
    // Lấy danh sách tất cả các file đang được sử dụng trong map streams
    const activeFiles = new Set();
    for (const s of streams.values()) {
      if (s.file) activeFiles.add(path.resolve(s.file));
      if (s.originalFile) activeFiles.add(path.resolve(s.originalFile));
    }
    
    files.forEach(file => {
      if (file === '.gitkeep') return;
      const fullPath = path.join(DOWNLOAD_DIR, file);
      const resolvedPath = path.resolve(fullPath);
      
      // Nếu file không thuộc bất kỳ luồng hoạt động nào -> XEM XÉT XÓA!
      if (!activeFiles.has(resolvedPath)) {
        fs.stat(fullPath, (err, stats) => {
          if (err) return;
          const ageInMs = Date.now() - stats.mtime.getTime();
          // Bỏ qua các file/thư mục mới tải hoặc sửa đổi dưới 60 phút
          if (ageInMs < 60 * 60 * 1000) {
            return;
          }
          
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
function purgeFinishedStreams() {
  try { captureFinished(); } catch (_) {}
  const now = Date.now();
  let purged = 0;
  for (const [id, s] of Array.from(streams.entries())) {
    if (s.status !== 'stopped' && s.status !== 'ended') { delete s._doneSince; continue; }
    if (!s._doneSince) { s._doneSince = now; continue; }
    if (now - s._doneSince < FINISHED_TTL_MS) continue;
    // Chỉ xóa file nếu không còn luồng nào khác đang dùng chung
    const inUse = Array.from(streams.values()).some(o => o !== s && o.file === s.file && o.status !== 'stopped' && o.status !== 'ended');
    if (!inUse) cleanupFile(s.file);
    streams.delete(id);
    purged++;
  }
  if (purged > 0) {
    console.log(`[Cleanup] 🧹 Tự động dọn ${purged} luồng đã kết thúc quá ${FINISHED_TTL_MS / 3600000} giờ.`);
    saveStreams();
  }
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
        s.lastLog = cleanLines[cleanLines.length - 1] || '';
        
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
                
                if (isFail && s.streamAActive !== false) {
                    s.streamAActive = false;
                    s.streamALog = line;
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
                
                if (isFail && s.streamBActive !== false) {
                    s.streamBActive = false;
                    s.streamBLog = line;
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
    if (s.status === 'stopped') return;

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
      // KHÔNG tự ý xóa file tạm khi luồng sập nữa để bảo vệ khả năng bật lại
      console.log(`[Stream #${id}] Luồng đã kết thúc vĩnh viễn. Giữ lại file video tạm.`);
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
    console.log(`\n[Stream #${streamId}] ⬇️ Bắt đầu tải video từ Google Drive...`);
    console.log(`[Stream #${streamId}] 🔗 Link: ${cleanFile}`);
    
    downloadGoogleDriveFile(cleanFile, DOWNLOAD_DIR, (dl, total, pct, speed) => {
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
    }).then(filePath => {
      const s = streams.get(streamId);
      if (!s || s.status === 'stopped') return;
      s.file = filePath;
      s.lastLog = 'Tải xong, chuẩn bị live...';
      console.log(`\n[Stream #${streamId}] ✅ TẢI XONG! File được lưu tạm tại: ${filePath}`);
      console.log(`[Stream #${streamId}] 🚀 Bắt đầu kích hoạt FFmpeg...`);
      const telegramName = s.name ? `🏷️ Luồng: *${escapeMarkdown(s.name)}*\n` : '';
      updateProgress(streamId, 100, `✅ *LUỒNG #${streamId}* - TẢI VIDEO THÀNH CÔNG!\n━━━━━━━━━━━━━━━━━━\n${telegramName}🎞 Video: \`${path.basename(filePath)}\`\n🚀 Trạng thái: \`Đang kích hoạt phát Live...\``);
      proceedStartStream(streamId);
    }).catch(err => {
      const s = streams.get(streamId);
      if (!s) return;
      s.status = 'ended';
      s.lastLog = `❌ Lỗi tải Drive: ${err.message}`;
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

  // Giữ lại file video (kể cả file tải từ Drive) để còn bật lại được. File chỉ bị xóa khi luồng bị xóa/dọn tự động.
  saveStreams(); // Lưu lại trạng thái dừng

  return true;
}

// ─── Restart Stream ───────────────────────────────────────────────────────────
function restartStream(id) {
  const s = streams.get(id);
  if (!s) return { error: 'Không tìm thấy luồng' };
  
  if (s.status === 'live' || s.status === 'launching' || s.status === 'scheduled' || s.status === 'reconnecting') {
    return { error: 'Luồng đang chạy, không thể khởi động lại' };
  }
  if (findActiveKeyUser(s.key, id)) return { error: DUP_KEY_ERROR };
  
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
      s.originalFile = body.file;
      s.file = body.file;
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
      proceedStartStream(s.id); // Tự động hẹn giờ kích hoạt ở tương lai
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
          // Tải lại video Drive và tự động chạy
          startStream({
            id: s.id,
            key: s.key,
            file: s.originalFile,
            mode: s.mode,
            minutes: s.minutes,
            scheduledTime: s.scheduledTime,
            scheduledMode: s.scheduledMode,
            name: s.name,
            youtubeUrl: s.youtubeUrl,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt
          });
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
let localRoleConfirmed = false;

function applyLocalRole(id, how) {
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

const server = http.createServer(async (req, res) => {
  sysinfoFn = getLocalSysinfo; // (hàm được hoist trong handler) để failover.js lấy tải máy này khi chọn máy đích
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const { pathname, searchParams } = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // Endpoint công khai 0: Kiểm tra sức khỏe (cho giám sát / PM2 / VPS đối tác) - không lộ dữ liệu nhạy cảm
  if (req.method === 'GET' && pathname === '/api/health') {
    json(res, 200, {
      ok: true,
      node: localNodeId,
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
      // Fallback kiểm tra mật khẩu legacy admin
      if (body.username === authConfig.username && body.password === authConfig.password) {
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
  // STRICT_INTERNAL=1: tắt quyền admin theo User-Agent (chỉ VPS đối tác có secret mới được nội bộ)
  const strictInternal = process.env.STRICT_INTERNAL === '1';
  const isSecureApp = !strictInternal && userAgent.includes('CyberShieldSecureAgent/1.0');
  const clusterSecretHeader = req.headers['x-cluster-secret'];
  const isClusterPeer = !!clusterSecretHeader && clusterSecretHeader === userManager.getSheetConfig().syncSecret;
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
            sendToZalo(`🛡️ *[CẢNH BÁO FAILOVER TỰ ĐỘNG]*\n${failedNode} không phản hồi! Luồng [${body.name}] đã được tự động cứu hộ chạy trên ${localNodeId}.`);
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
      json(res, 200, resRemote);
      return;
    }

    const s = streams.get(streamId);
    if (s && currentUser.role !== 'admin' && s.ownerId !== currentUser.id && s.ownerUsername !== currentUser.username) {
      json(res, 403, { error: 'Bạn không có quyền dừng luồng này!' });
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
        updatedAt: s.updatedAt || null
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
initBot({
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

server.listen(PORT, '0.0.0.0', async () => {
  const ffmpegOk = await checkFFmpeg();
  if (!ffmpegOk) {
    console.log('⚠️ Cảnh báo: Hệ thống có thể không hoạt động đúng do thiếu FFmpeg.');
  }
  // Chờ nhận diện vai trò node (tối đa 7s) để luồng khôi phục gắn đúng serverId
  for (let i = 0; i < 14 && !localRoleConfirmed; i++) await new Promise(r => setTimeout(r, 500));
  loadHistory(); // Nap lich su luong da luu
  loadStreams(); // Khôi phục danh sách luồng trước
  // Master tự động chuyển luồng đang chạy sang máy khác khi một Worker bị chết (xem failover.js)
  try {
    failoverCtl = require('./failover').init({
      clusterManager, userManager, startStream, extractDriveId,
      getLocalSysinfo: () => (sysinfoFn ? sysinfoFn() : null),
      localNodeId: () => localNodeId,
      notify: (m) => { try { broadcast(m); } catch (_) {} try { sendToZalo(m); } catch (_) {} }
    });
  } catch (e) { console.error('[Failover] Không khởi động được:', e.message); }
  cleanupOrphanedFiles(); // Sau đó mới dọn dẹp các file không nằm trong danh sách
  
  // Tự động quét dọn định kỳ mỗi 1 tiếng
  setInterval(cleanupOrphanedFiles, 60 * 60 * 1000);
  // Tự động dọn các luồng đã kết thúc/dừng quá hạn lưu (kiểm tra mỗi 10 phút)
  setInterval(purgeFinishedStreams, parseInt(process.env.PURGE_INTERVAL_MS) || 10 * 60 * 1000);
  
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
