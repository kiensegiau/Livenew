const http = require('http');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');

const PORT = 3131;
const streams = new Map();
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

// ─── Launch FFmpeg ────────────────────────────────────────────────────────────
function launchFFmpeg(id, key, file, mode, minutes) {
  const loopArg = mode === 'loop' ? ['-stream_loop', '-1'] : [];
  const timeArg = mode === 'loop' && minutes > 0 ? ['-t', String(minutes * 60)] : [];

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
  const info = streams.get(id);
  if (info) {
    info.process = proc;
    info.pid = proc.pid;
    info.status = 'live';
    info.startTime = new Date().toISOString();
  }

  let errBuf = '';
  proc.stderr.on('data', (d) => {
    errBuf = (errBuf + d.toString()).slice(-2000); // keep last 2KB
    const s = streams.get(id);
    if (s) s.lastLog = errBuf.split('\n').filter(Boolean).pop() || '';
  });

  proc.on('close', () => {
    const s = streams.get(id);
    if (s && s.status !== 'stopped') s.status = 'ended';
  });
}

// ─── Start Stream ─────────────────────────────────────────────────────────────
function startStream({ key, file, mode, minutes, scheduledTime }) {
  const id = nextId++;

  if (mode === 'scheduled') {
    const delay = new Date(scheduledTime).getTime() - Date.now();
    if (delay <= 0) return { error: 'Thời gian đặt lịch đã qua rồi!' };

    const info = {
      id, key, file, mode: 'scheduled',
      status: 'scheduled',
      scheduledTime,
      startTime: null,
      process: null, pid: null, lastLog: ''
    };

    info.timer = setTimeout(() => {
      const s = streams.get(id);
      if (s) { s.mode = 'loop'; s.status = 'launching'; }
      launchFFmpeg(id, key, file, 'loop', minutes);
    }, delay);

    streams.set(id, info);
    return { id, status: 'scheduled', scheduledTime };
  }

  const info = {
    id, key, file, mode,
    status: 'launching',
    scheduledTime: null,
    startTime: null,
    process: null, pid: null, lastLog: ''
  };
  streams.set(id, info);
  launchFFmpeg(id, key, file, mode, minutes);
  return { id, status: 'live' };
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
  return true;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => resolve(body));
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const { pathname } = url.parse(req.url);

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
    const body = JSON.parse(await readBody(req));
    const result = startStream(body);
    json(res, result.error ? 400 : 200, result);
    return;
  }

  // API: Stop stream
  if (req.method === 'POST' && pathname === '/api/stop') {
    const { id } = JSON.parse(await readBody(req));
    stopStream(Number(id));
    json(res, 200, { ok: true });
    return;
  }

  // API: List streams
  if (req.method === 'GET' && pathname === '/api/streams') {
    const list = [];
    for (const [, s] of streams) {
      list.push({
        id: s.id,
        keyHint: s.key.substring(0, 6) + '****',
        file: path.basename(s.file),
        mode: s.mode,
        status: s.status,
        startTime: s.startTime,
        scheduledTime: s.scheduledTime,
        lastLog: s.lastLog || ''
      });
    }
    json(res, 200, list);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = `http://localhost:${PORT}`;
  console.log('\n╔══════════════════════════════════════╗');
  console.log(`║  🎬 YouTube Live Controller Ready     ║`);
  console.log(`║  ${addr}              ║`);
  console.log('╚══════════════════════════════════════╝\n');
  exec(`start ${addr}`);
});
