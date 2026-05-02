const http = require('http');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { downloadGoogleDriveFile, extractDriveId } = require('./driveDownloader');
const { initBot, broadcast, updateProgress } = require('./telegramBot');

const PORT = 3131;
const streams = new Map();
const BACKUP_FILE = path.join(__dirname, 'streams_backup.json');

// --- Persistence Logic ---
function saveStreams() {
  const data = Array.from(streams.values()).map(s => ({
    id: s.id, key: s.key, file: s.file, mode: s.mode, minutes: s.minutes, 
    scheduledTime: s.scheduledTime, scheduledMode: s.scheduledMode, status: s.status
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
          
          if (s.status === 'downloading' || (s.status === 'live' && s.file.startsWith('http'))) {
              // Nếu đang tải hoặc live trực tiếp từ link -> chạy lại quy trình start
              startStream({ key: s.key, file: s.file, mode: s.mode, minutes: s.minutes, scheduledTime: s.scheduledTime, id: s.id });
          } else if (s.status === 'scheduled') {
              proceedStartStream(s.id);
          } else {
              launchFFmpeg(s.id, s.key, s.file, s.mode, s.minutes);
          }
        }
      });
      console.log(`[System] ♻️ Đã khôi phục ${streams.size} luồng từ bản sao lưu.`);
    } catch (e) { console.error('[System] Lỗi đọc backup:', e.message); }
  }
}

function cleanupOrphanedFiles() {
  const tempDir = os.tmpdir();
  fs.readdir(tempDir, (err, files) => {
    if (err) return;
    files.forEach(f => {
      if (f.startsWith('drive_video_')) {
        fs.unlink(path.join(tempDir, f), () => {});
      }
    });
  });
  console.log('[System] 🧹 Đã dọn dẹp các file rác mồ côi.');
}

async function checkFFmpeg() {
  return new Promise((resolve) => {
    exec('ffmpeg -version', (err) => {
      if (err) {
        console.error('\n❌ LỖI: Không tìm thấy FFmpeg trong hệ thống!');
        console.log('👉 Vui lòng cài đặt FFmpeg và thêm vào biến môi trường PATH.\n');
        resolve(false);
      } else {
        console.log('[System] ✅ Kiểm tra FFmpeg: Sẵn sàng.');
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

function cleanupFile(filePath) {
  if (!filePath) return;
  // Chỉ xóa nếu file nằm trong thư mục tạm OS hoặc là file drive_video_
  const isTemp = filePath.includes(os.tmpdir()) || path.basename(filePath).startsWith('drive_video_');
  if (isTemp && fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) console.error(`[Cleanup] Lỗi xóa file ${filePath}:`, err.message);
      else console.log(`[Cleanup] Đã xóa file tạm: ${filePath}`);
    });
  }
}

// ─── Launch FFmpeg ────────────────────────────────────────────────────────────
function launchFFmpeg(id, key, file, mode, minutes) {
  const mins = Math.max(0, parseInt(minutes) || 0);
  const loopArg = mode === 'loop' ? ['-stream_loop', '-1'] : [];
  const timeArg = mode === 'loop' && mins > 0 ? ['-t', String(mins * 60)] : [];

  // -c copy = lightest: zero decode/encode, pure remux to FLV
  // -bsf:a aac_adtstoasc = required to wrap ADTS AAC → MPEG-4 AAC for FLV
  const args = [
    ...loopArg,
    '-re',
    '-i', file,
    ...timeArg,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-bufsize', '10000k',
    '-maxrate', '5500k',
    '-f', 'flv',
    `rtmp://a.rtmp.youtube.com/live2/${key}`
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let info = streams.get(id);
  if (!info) return; // Luồng đã bị xóa trước khi kịp chạy

  info.process = proc;
  info.pid = proc.pid;
  info.status = 'live';
  info.startTime = new Date().toISOString();
  info.retryCount = info.retryCount || 0; // Đếm số lần retry
  broadcast(`🟢 *Luồng #${id} ĐÃ BẮT ĐẦU LIVE!*`);

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
    updateStreamLog(id, d); // Ghi log chi tiết
    errBuf = (errBuf + d.toString()).slice(-2000); 
    const s = streams.get(id);
    if (s) s.lastLog = errBuf.split('\n').filter(Boolean).pop() || '';
  });

  saveStreams(); // Lưu backup khi luồng bắt đầu live

  proc.on('close', (code) => {
    const s = streams.get(id);
    if (!s) return;
    
    // Dọn _killTimer nếu có
    if (s._killTimer) { clearTimeout(s._killTimer); s._killTimer = null; }

    // Nếu do user bấm stop → status đã là 'stopped', không làm gì thêm
    if (s.status === 'stopped') return;

    if (code !== 0 && s.retryCount < 5) {
      s.status = 'reconnecting';
      s.retryCount++;
      const msg = `[Stream #${id}] Lỗi (code ${code}), thử lại lần ${s.retryCount} sau 10s...`;
      console.log(msg);
      broadcast(`🟡 *Luồng #${id} bị văng (code ${code})*\nĐang thử kết nối lại lần ${s.retryCount}/5...`);
      s.timer = setTimeout(() => {
        if (streams.has(id) && streams.get(id).status === 'reconnecting') {
           launchFFmpeg(id, key, file, mode, minutes);
        }
      }, 10000);
    } else {
      s.status = 'ended';
      if(code !== 0) {
        s.lastLog = `[Thất bại] FFMPEG thoát lỗi code ${code} sau ${s.retryCount} lần thử.`;
        broadcast(`🔴 *Luồng #${id} KẾT THÚC LỖI!*\nĐã thử lại ${s.retryCount} lần nhưng thất bại.`);
      } else {
        broadcast(`⚪ *Luồng #${id} ĐÃ KẾT THÚC BÌNH THƯỜNG.*`);
      }
      // Xóa file nếu luồng kết thúc (không phải đang reconnect)
      cleanupFile(s.file);
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

function startStream({ key, file, mode, minutes, scheduledTime }) {
  const id = nextId++;
  const isDrive = !!extractDriveId(file);

  if (mode === 'scheduled') {
    const localISO = scheduledTime.length === 16 ? scheduledTime + ':00' : scheduledTime;
    const delay = new Date(localISO).getTime() - Date.now();
    if (delay <= 0) return { error: 'Thời gian đặt lịch đã qua rồi!' };
  }

  const info = {
    id, key, file, mode, minutes, scheduledTime,
    status: isDrive ? 'downloading' : (mode === 'scheduled' ? 'scheduled' : 'launching'),
    startTime: null,
    process: null, pid: null, lastLog: '', retryCount: 0
  };
  streams.set(id, info);

  if (isDrive) {
    info.lastLog = 'Đang bắt đầu tải file từ Drive...';
    console.log(`\n[Stream #${id}] ⬇️ Bắt đầu tải video từ Google Drive...`);
    console.log(`[Stream #${id}] 🔗 Link: ${file}`);
    
    downloadGoogleDriveFile(file, os.tmpdir(), (dl, total, pct) => {
      if (streams.has(id)) {
        if (pct !== null) {
          streams.get(id).lastLog = `Đang tải... ${pct}%`;
          console.log(`[Stream #${id}] ⏳ Tiến độ: ${pct}% (${(dl/1024/1024).toFixed(2)} MB / ${(total/1024/1024).toFixed(2)} MB)`);
          updateProgress(id, pct, `⬇️ *Luồng #${id}* đang tải: \`${pct}%\` (${(dl/1024/1024).toFixed(1)}/${(total/1024/1024).toFixed(1)} MB)`);
        }
        else {
          streams.get(id).lastLog = `Đang tải... ${Math.round(dl/1024/1024)}MB`;
          console.log(`[Stream #${id}] ⏳ Đang tải... ${(dl/1024/1024).toFixed(2)} MB`);
          updateProgress(id, null, `⬇️ *Luồng #${id}* đang tải: \`${(dl/1024/1024).toFixed(1)} MB\``);
        }
      }
    }).then(filePath => {
      const s = streams.get(id);
      if (!s || s.status === 'stopped') return;
      s.file = filePath;
      s.lastLog = 'Tải xong, chuẩn bị live...';
      console.log(`\n[Stream #${id}] ✅ TẢI XONG! File được lưu tạm tại: ${filePath}`);
      console.log(`[Stream #${id}] 🚀 Bắt đầu kích hoạt FFmpeg...`);
      updateProgress(id, 100, `✅ *Luồng #${id}* đã tải xong!\nChuẩn bị phát Live...`);
      proceedStartStream(id);
    }).catch(err => {
      const s = streams.get(id);
      if (!s) return;
      s.status = 'ended';
      s.lastLog = `❌ Lỗi tải Drive: ${err.message}`;
      console.error(`\n[Stream #${id}] ❌ Lỗi tải Google Drive: ${err.message}`);
      broadcast(`❌ *Lỗi tải Drive (Luồng #${id})*\n${err.message}`);
    });
    
    return { id, status: 'downloading', scheduledTime };
  } else {
    saveStreams(); // Lưu lại ngay khi tạo luồng mới
    proceedStartStream(id);
    return { id, status: info.status, scheduledTime };
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
        streams.delete(id);
        count++;
      }
    }
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
        retryCount: s.retryCount || 0
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
        streams.delete(id);
        count++;
      }
    }
    saveStreams();
    return count;
  },
  getLogs: (id) => {
    const s = streams.get(id);
    return s ? (s._fullLogs || 'Chưa có log chi tiết.') : 'Không tìm thấy luồng.';
  },
  rebootServer: () => {
    saveStreams();
    setTimeout(() => process.exit(0), 1000);
    return true;
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  const ffmpegOk = await checkFFmpeg();
  if (!ffmpegOk) {
    console.log('⚠️ Cảnh báo: Hệ thống có thể không hoạt động đúng do thiếu FFmpeg.');
  }
  cleanupOrphanedFiles(); 
  loadStreams();
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
