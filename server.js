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
    scheduledTime: s.scheduledTime, scheduledMode: s.scheduledMode, status: s.status, dualStream: !!s.dualStream
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
              startStream({ key: s.key, file: s.originalFile || s.file, mode: s.mode, minutes: s.minutes, scheduledTime: s.scheduledTime, id: s.id, dualStream: s.dualStream });
          } else if (s.status === 'scheduled') {
              proceedStartStream(s.id);
          } else {
              // Nếu file video cục bộ vẫn còn -> DÙNG LẠI LUÔN, KHÔNG TẢI LẠI
              if (s.file && fs.existsSync(s.file)) {
                  launchFFmpeg(s.id, s.key, s.file, s.mode, s.minutes);
              } 
              // Nếu file bị xóa mất nhưng có link gốc -> tải lại để cứu rỗi
              else if (s.originalFile && s.originalFile.startsWith('http')) {
                  startStream({ key: s.key, file: s.originalFile, mode: s.mode, minutes: s.minutes, scheduledTime: s.scheduledTime, id: s.id, dualStream: s.dualStream });
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
      
      // Nếu file không thuộc bất kỳ luồng hoạt động nào -> XÓA NGAY!
      if (!activeFiles.has(resolvedPath)) {
        fs.unlink(fullPath, (err) => {
          if (err) {
            console.error(`[Cleanup] Lỗi tự động xóa file mồ côi ${file}:`, err.message);
          } else {
            console.log(`[Cleanup] ✅ Tự động dọn dẹp file rác mồ côi: ${file}`);
          }
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
  // Kiểm tra file tồn tại trước khi chạy
  if (!file || !fs.existsSync(file)) {
    console.error(`[Stream #${id}] ❌ Lỗi: File video không tồn tại tại: ${file}`);
    broadcast(`🔴 *LUỒNG #${id} THẤT BẠI!*\nLỗi: Không tìm thấy file video trên ổ đĩa.`);
    const s = streams.get(id);
    if (s) s.status = 'ended';
    return;
  }

  let info = streams.get(id);
  if (!info) return; // Luồng đã bị xóa trước khi kịp chạy

  info.dualStream = true; // Luôn luôn phát song song 2 luồng A+B để tránh mọi sự cố
  info.streamAActive = true;
  info.streamBActive = true;
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
    console.log(`[Stream #${id}] 🔗 Khởi chạy luồng phát SONG SONG cả 2 Máy chủ chính (A) và dự phòng (B)`);
    
    const rtmpA = `[f=flv:onfail=ignore:flvflags=no_duration_filesize]rtmp\\://a.rtmp.youtube.com/live2/${key}`;
    const rtmpB = `[f=flv:onfail=ignore:flvflags=no_duration_filesize]rtmp\\://b.rtmp.youtube.com/live2/${key}`;
    
    formatArgs = [
      '-map', '0',               // BẮT BUỘC: Ánh xạ toàn bộ luồng đầu vào cho tee muxer hoạt động
      '-c', 'copy',
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
    broadcast(`❌ *LUỒNG #${id} KHÔNG THỂ KHỞI CHẠY!*\nLỗi: \`${err.message}\``);
  });

  info.process = proc;
  info.pid = proc.pid;
  info.status = 'live';
  info.startTime = new Date().toISOString();
  info.retryCount = info.retryCount || 0; // Đếm số lần retry
  const fileName = path.basename(info.file);

  if (info.dualStream) {
    broadcast(`🚀 *LUỒNG #${id} BẮT ĐẦU LIVE (SONG SONG A+B) ⚡*\n━━━━━━━━━━━━━━━━━━\n🎞 Video: \`${fileName}\`\n📡 Chế độ: \`Song song cả 2 Máy chủ chính & dự phòng (Độ ổn định cực hạn)\`\n🛡 Trạng thái bảo vệ: \`Hoạt động song song (High Redundancy Active)\``);
  } else {
    broadcast(`🟢 *LUỒNG #${id} BẮT ĐẦU LIVE!*\n━━━━━━━━━━━━━━━━━━\n🎞 Video: \`${fileName}\`\n📡 Ingest Server: \`${serverName}\` (Đơn luồng)`);
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
      broadcast(`🔴 *LỖI KHỞI ĐỘNG LUỒNG #${id}!*\nNội dung: \`${err.message}\``);
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
        const lines = errBuf.split('\n').filter(Boolean);
        s.lastLog = lines.pop() || '';
        
        // Phát hiện rớt kết nối từng nhánh A hoặc B của tee muxer
        if (dataStr.includes('Slave muxer #0 failed') || errBuf.includes('Slave muxer #0 failed')) {
            if (s.streamAActive !== false) {
                s.streamAActive = false;
                broadcast(`⚠️ *LUỒNG #${id} - CẢNH BÁO MẤT KẾT NỐI LUỒNG A!* ⚠️\n🔴 Máy chủ chính A (Primary) bị gián đoạn.\n🛡️ Hệ thống vẫn đang duy trì phát sóng qua Máy chủ dự phòng B.`);
            }
        }
        if (dataStr.includes('Slave muxer #1 failed') || errBuf.includes('Slave muxer #1 failed')) {
            if (s.streamBActive !== false) {
                s.streamBActive = false;
                broadcast(`⚠️ *LUỒNG #${id} - CẢNH BÁO MẤT KẾT NỐI LUỒNG B!* ⚠️\n🔴 Máy chủ dự phòng B (Backup) bị gián đoạn.\n🛡️ Hệ thống vẫn đang duy trì phát sóng qua Máy chủ chính A.`);
            }
        }
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
      broadcast(`🟡 *Luồng #${id} bị văng (mã ${code})*\nĐang thử kết nối lại lần ${s.retryCount}/${maxRetryText}...`);
      s.timer = setTimeout(() => {
        if (streams.has(id) && streams.get(id).status === 'reconnecting') {
           launchFFmpeg(id, key, file, mode, minutes);
        }
      }, 10000);
    } else {
      s.status = 'ended';
      if(code !== 0) {
        s.lastLog = s.lastLog || `Thoát với mã ${code}`;
        broadcast(`🔴 *LUỒNG #${id} BỊ LỖI FFmpeg!*\n🎞 Video: \`${path.basename(s.file)}\`\n💬 Chi tiết: \`${escapeMarkdown(s.lastLog)}\``);
      } else {
        broadcast(`⚪ *LUỒNG #${id} KẾT THÚC BÌNH THƯỜNG*\n🎞 Video: \`${path.basename(s.file)}\``);
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
    const localISO = s.scheduledTime.length === 16 ? s.scheduledTime + ':00' : s.scheduledTime;
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

function startStream({ key, file, mode, minutes, scheduledTime, dualStream, id }) {
  // Nếu không có luồng nào, reset số thứ tự về 1
  if (streams.size === 0 && !id) nextId = 1;
  
  const streamId = id || nextId++;
  const isDrive = !!extractDriveId(file);

  if (mode === 'scheduled') {
    const localISO = scheduledTime.length === 16 ? scheduledTime + ':00' : scheduledTime;
    const delay = new Date(localISO).getTime() - Date.now();
    if (delay <= 0) return { error: 'Thời gian đặt lịch đã qua rồi!' };
  }

  const info = {
    id: streamId, key, file, originalFile: file, mode, minutes, scheduledTime,
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
    
    downloadGoogleDriveFile(cleanFile, DOWNLOAD_DIR, (dl, total, pct) => {
      const s = streams.get(streamId);
      if (s) {
        const dualText = s.dualStream ? '⚡ [SONG SONG A+B]' : '📡 [ĐƠN LUỒNG]';
        if (pct !== null) {
          s.lastLog = `Đang tải... ${pct}%`;
          console.log(`[Stream #${streamId}] ⏳ Tiến độ: ${pct}% (${(dl/1024/1024).toFixed(2)} MB / ${(total/1024/1024).toFixed(2)} MB)`);
          
          // Tạo thanh tiến trình trực quan
          const filled = Math.round(pct / 10);
          const bar = '■'.repeat(filled) + '□'.repeat(10 - filled);
          updateProgress(streamId, pct, `📥 *LUỒNG #${streamId}* - ĐANG TẢI VIDEO\n━━━━━━━━━━━━━━━━━━\n📁 File: \`${path.basename(cleanFile)}\`\n📊 Tiến độ: \`[${bar}] ${pct}%\`\n📦 Đã tải: \`${(dl/1024/1024).toFixed(1)} / ${(total/1024/1024).toFixed(1)} MB\`\n📡 Cấu hình: \`${dualText}\``);
        }
        else {
          s.lastLog = `Đang tải... ${Math.round(dl/1024/1024)}MB`;
          console.log(`[Stream #${streamId}] ⏳ Đang tải... ${(dl/1024/1024).toFixed(2)} MB`);
          updateProgress(streamId, null, `📥 *LUỒNG #${streamId}* - ĐANG TẢI VIDEO\n━━━━━━━━━━━━━━━━━━\n📁 File: \`${path.basename(cleanFile)}\`\n📊 Tiến độ: \`[Đang tải...]\`\n📦 Đã tải: \`${(dl/1024/1024).toFixed(1)} MB\`\n📡 Cấu hình: \`${dualText}\``);
        }
      }
    }).then(filePath => {
      const s = streams.get(streamId);
      if (!s || s.status === 'stopped') return;
      s.file = filePath;
      s.lastLog = 'Tải xong, chuẩn bị live...';
      console.log(`\n[Stream #${streamId}] ✅ TẢI XONG! File được lưu tạm tại: ${filePath}`);
      console.log(`[Stream #${streamId}] 🚀 Bắt đầu kích hoạt FFmpeg...`);
      updateProgress(streamId, 100, `✅ *LUỒNG #${streamId}* - TẢI VIDEO THÀNH CÔNG!\n━━━━━━━━━━━━━━━━━━\n🎞 Video: \`${path.basename(filePath)}\`\n🚀 Trạng thái: \`Đang kích hoạt phát Live...\``);
      proceedStartStream(streamId);
    }).catch(err => {
      const s = streams.get(streamId);
      if (!s) return;
      s.status = 'ended';
      s.lastLog = `❌ Lỗi tải Drive: ${err.message}`;
      console.error(`\n[Stream #${streamId}] ❌ Lỗi tải Google Drive: ${err.message}`);
      broadcast(`❌ *Lỗi tải Drive (Luồng #${streamId})*\n${err.message}`);
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
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const { pathname } = new URL(req.url, `http://127.0.0.1:${PORT}`);

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
        streamBActive: s.streamBActive !== false
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
