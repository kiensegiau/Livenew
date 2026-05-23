const http = require('http');
const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Tự động dọn dẹp các tiến trình FFmpeg "ma" khi khởi động ---
try {
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
const { initBot, broadcast, updateProgress } = require('./telegramBot');

const PORT = 3131;
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

// --- Persistence Logic ---
function saveStreams() {
  const data = Array.from(streams.values()).map(s => ({
    id: s.id, key: s.key, file: s.file, originalFile: s.originalFile || s.file, mode: s.mode, minutes: s.minutes, 
    scheduledTime: s.scheduledTime, scheduledMode: s.scheduledMode, status: s.status, dualStream: !!s.dualStream,
    name: s.name || ''
  }));
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(data, null, 2));
}

function loadStreams() {
  if (fs.existsSync(BACKUP_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
      data.forEach(s => {
        // Khôi phục các luồng chưa kết thúc
        if (['live', 'scheduled', 'reconnecting', 'launching', 'downloading'].includes(s.status)) {
          streams.set(s.id, { ...s, process: null, pid: null, retryCount: 0, lastLog: 'Đang khôi phục...' });
          nextId = Math.max(nextId, s.id + 1);
          
          if (s.status === 'downloading') {
              // Nếu đang tải dở lúc sập mạng -> bắt buộc tải lại
              startStream({ key: s.key, file: s.originalFile || s.file, mode: s.mode, minutes: s.minutes, scheduledTime: s.scheduledTime, id: s.id, dualStream: s.dualStream, name: s.name });
          } else if (s.status === 'scheduled') {
              proceedStartStream(s.id);
          } else {
              // Nếu file video cục bộ vẫn còn -> DÙNG LẠI LUÔN, KHÔNG TẢI LẠI
              if (s.file && fs.existsSync(s.file)) {
                  launchFFmpeg(s.id, s.key, s.file, s.mode, s.minutes);
              } 
              // Nếu file bị xóa mất nhưng có link gốc -> tải lại để cứu rỗi
              else if (s.originalFile && s.originalFile.startsWith('http')) {
                  startStream({ key: s.key, file: s.originalFile, mode: s.mode, minutes: s.minutes, scheduledTime: s.scheduledTime, id: s.id, dualStream: s.dualStream, name: s.name });
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
          // Bỏ qua các file mới tải hoặc sửa đổi dưới 60 phút để tránh xóa nhầm các file đang trong tiến trình tải hoặc chuẩn bị live
          if (ageInMs < 60 * 60 * 1000) {
            return;
          }
          
          fs.unlink(fullPath, (err) => {
            if (err) {
              console.error(`[Cleanup] Lỗi tự động xóa file mồ côi ${file}:`, err.message);
            } else {
              console.log(`[Cleanup] ✅ Tự động dọn dẹp file rác mồ côi: ${file}`);
            }
          });
        });
      }
    });
  });
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
  // Xóa nếu nằm trong thư mục downloads hoặc thư mục tạm hệ thống
  const isTemp = filePath.includes(DOWNLOAD_DIR) || filePath.includes(os.tmpdir()) || path.basename(filePath).startsWith('drive_video_');
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

  info.dualStream = true; // Luôn luôn phát song song 2 luồng A+B để tránh mọi sự cố
  info.streamAActive = true;
  info.streamBActive = true;
  info.streamALog = '';
  info.streamBLog = '';
  const currentRetry = info.retryCount || 0;
  const serverLetter = (currentRetry % 2 === 0) ? 'a' : 'b';

  const mins = Math.max(0, parseInt(minutes) || 0);
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
    const rtmpA = `[f=fifo:fifo_format=flv:drop_pkts_on_overflow=1:attempt_recovery=1:recovery_wait_time=5:onfail=ignore]rtmp\\://a.rtmp.youtube.com/live2/${key}?tcp_nodelay=1&rw_timeout=15000000`;
    const rtmpB = `[f=fifo:fifo_format=flv:drop_pkts_on_overflow=1:attempt_recovery=1:recovery_wait_time=5:onfail=ignore]rtmp\\://b.rtmp.youtube.com/live2/${key}?tcp_nodelay=1&rw_timeout=15000000`;
    
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
    
    // Dọn _killTimer nếu có
    if (s._killTimer) { clearTimeout(s._killTimer); s._killTimer = null; }

    // Dọn _stableTimer nếu có
    if (s._stableTimer) { clearTimeout(s._stableTimer); s._stableTimer = null; }

    // Nếu do user bấm stop → status đã là 'stopped', không làm gì thêm
    if (s.status === 'stopped') return;

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

function startStream({ key, file, mode, minutes, scheduledTime, dualStream, id, name }) {
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
    dualStream: true,
    status: isDrive ? 'downloading' : (mode === 'scheduled' ? 'scheduled' : 'launching'),
    startTime: null,
    process: null, pid: null, lastLog: '', retryCount: 0
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
    
    return { id: streamId, status: 'downloading', scheduledTime };
  } else {
    saveStreams(); // Lưu lại ngay khi tạo luồng mới
    proceedStartStream(streamId);
    return { id: streamId, status: info.status, scheduledTime };
  }
}

// ─── Stop Stream ──────────────────────────────────────────────────────────────
function stopStream(id) {
  const info = streams.get(id);
  if (!info) return false;
  if (info.timer) clearTimeout(info.timer);
  info.status = 'stopped';
  if (info.process) {
    try {
      // Gửi 'q' vào stdin → ffmpeg tự đóng RTMP gracefully
      info.process.stdin.write('q\n');
      // Force kill sau 5 giây nếu vẫn còn chạy
      info._killTimer = setTimeout(() => {
        try { info.process.kill(); } catch (_) {}
      }, 5000);
    } catch (_) {
      try { info.process.kill(); } catch (_) {}
    }
  }

  // Xóa file tạm nếu có (từ Drive)
  cleanupFile(info.file);
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

// ─── 🔐 CẤU HÌNH BẢO MẬT & ĐĂNG NHẬP ──────────────────────────────────────────
const crypto = require('crypto');
const AUTH_CONFIG_PATH = path.join(__dirname, 'auth_config.json');
const FALLBACK_AUTH_CONFIG_PATH = path.join(os.tmpdir(), 'cyber_shield_auth_config.json');
let activeAuthConfigPath = AUTH_CONFIG_PATH;
let authConfig = { username: 'admin', password: 'admin', sessionToken: '' };
let sessionToken = '';

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

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const { pathname } = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // API: Đăng nhập hệ thống
  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await parseBody(req);
    if (!body || !body.username || !body.password) {
      json(res, 400, { error: 'Vui lòng điền tài khoản và mật khẩu!' });
      return;
    }
    if (body.username === authConfig.username && body.password === authConfig.password) {
      json(res, 200, { token: sessionToken });
    } else {
      json(res, 401, { error: 'Tài khoản hoặc mật khẩu không chính xác!' });
    }
    return;
  }

  // Bộ lọc bảo vệ (Auth Middleware) cho các API /api/*
  // Nếu là yêu cầu từ ứng dụng Desktop của chúng ta (qua User-Agent đặc biệt), bỏ qua đăng nhập hoàn toàn.
  // Ngược lại (nếu truy cập bằng Chrome/trình duyệt thường), vẫn bắt buộc đăng nhập để bảo mật hệ thống.
  if (pathname.startsWith('/api/') && pathname !== '/api/login') {
    const userAgent = req.headers['user-agent'] || '';
    const isSecureApp = userAgent.includes('CyberShieldSecureAgent/1.0');
    
    if (!isSecureApp) {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1];
      if (token !== sessionToken) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
    }
  }

  // API: Đổi mật khẩu bảo mật
  if (req.method === 'POST' && pathname === '/api/change-password') {
    const body = await parseBody(req);
    if (!body || !body.currentPassword || !body.newPassword) {
      json(res, 400, { error: 'Thông tin không hợp lệ!' });
      return;
    }
    if (body.currentPassword !== authConfig.password) {
      json(res, 400, { error: 'Mật khẩu hiện tại không chính xác!' });
      return;
    }
    authConfig.password = body.newPassword;
    saveAuthConfig();

    // Làm mới Token để buộc các phiên làm việc khác đăng nhập lại
    sessionToken = crypto.randomBytes(16).toString('hex');
    authConfig.sessionToken = sessionToken;
    saveAuthConfig();
    json(res, 200, { ok: true, msg: 'Đổi mật khẩu thành công!' });
    return;
  }

  // Serve UI
  if (pathname === '/' || pathname === '/index.html') {
    const html = path.join(__dirname, 'public', 'index.html');
    fs.readFile(html, (err, data) => {
      if (err) { res.writeHead(500); res.end('UI not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // API: Browse file
  if (req.method === 'POST' && pathname === '/api/browse') {
    const filePath = await browseFile();
    json(res, 200, { path: filePath });
    return;
  }

  // API: Start stream
  if (req.method === 'POST' && pathname === '/api/start') {
    const body = await parseBody(req);
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
    const result = startStream(body);
    json(res, result.error ? 400 : 200, result);
    return;
  }

  // API: Stop stream
  if (req.method === 'POST' && pathname === '/api/stop') {
    const body = await parseBody(req);
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
    stopStream(Number(body.id));
    json(res, 200, { ok: true });
    return;
  }
  // API: Restart stream
  if (req.method === 'POST' && pathname === '/api/restart') {
    const body = await parseBody(req);
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return; }
    
    const result = restartStream(Number(body.id));
    if (result.error) {
       json(res, 400, result);
    } else {
       json(res, 200, result);
    }
    return;
  }
  // API: Xóa các luồng đã dừng/kết thúc
  if (req.method === 'POST' && pathname === '/api/clear') {
    let count = 0;
    for (const [id, s] of streams) {
      if (s.status === 'stopped' || s.status === 'ended') {
        cleanupFile(s.file);
        streams.delete(id);
        count++;
      }
    }
    cleanupOrphanedFiles();
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

  // API: Get VPS system telemetry
  if (req.method === 'GET' && pathname === '/api/sysinfo') {
    try {
      const freeMem = os.freemem();
      const totalMem = os.totalmem();
      const usedMem = totalMem - freeMem;
      const memUsagePct = Math.round((usedMem / totalMem) * 100);
      
      const cpus = os.cpus();
      const cpuCount = cpus.length;
      const cpuModel = cpuCount > 0 ? cpus[0].model.replace(/\s+/g, ' ').trim() : 'Generic CPU';
      
      // Lấy phần trăm CPU thực tế dựa trên hiệu số thời gian
      const cpuUsagePct = getCpuUsage();
      
      // Lấy dung lượng đĩa thực tế
      const disk = getDiskInfo();
      
      // Lấy lưu lượng mạng thực tế và tính toán tốc độ bằng chênh lệch Delta
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
            
            // Chuyển đổi Bytes/sec sang Bits/sec (nhân 8), rồi sang Kbps (chia 1024)
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
      
      // Định dạng uptime VPS
      const uptimeSec = os.uptime();
      const d = Math.floor(uptimeSec / (3600 * 24));
      const h = Math.floor((uptimeSec % (3600 * 24)) / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      const uptimeStr = d > 0 ? `${d} ngày ${h} giờ ${m} phút` : `${h} giờ ${m} phút`;
      
      const sysinfo = {
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
        activeStreams: Array.from(streams.values()).filter(s => ['live', 'downloading', 'launching'].includes(s.status)).length
      };
      json(res, 200, sysinfo);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // API: List streams
  if (req.method === 'GET' && pathname === '/api/streams') {
    const list = [];
    for (const [, s] of streams) {
      let displayFile = path.basename(s.file);
      if (s.file.includes('drive.google.com') || s.file.includes('view?usp=')) {
        displayFile = 'Google Drive Video';
      } else if (displayFile.startsWith('drive_video_')) {
        displayFile = 'Google Drive Video';
      }

      list.push({
        id: s.id,
        name: s.name || '',
        keyHint: s.key.substring(0, 6) + '****',
        file: displayFile,
        mode: s.mode,
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
        dlSpeed: s.dlSpeed || 0
      });
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
  loadStreams(); // Khôi phục danh sách luồng trước
  cleanupOrphanedFiles(); // Sau đó mới dọn dẹp các file không nằm trong danh sách
  
  // Tự động quét dọn định kỳ mỗi 1 tiếng
  setInterval(cleanupOrphanedFiles, 60 * 60 * 1000);
  
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
