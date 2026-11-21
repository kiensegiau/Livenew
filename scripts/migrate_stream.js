const http = require('http');
const https = require('https');
const { Client } = require('ssh2');
const fs = require('fs');

const OLD_VPS_IP = '13.140.208.154';
const NEW_MASTER_IP = '57.129.135.140';
const NEW_WORKER_IP = '57.129.194.73';
const SSH_USER = 'ubuntu';
const SSH_PASS = 'kienkaka2001';

// Read all streams from backup
const streams = JSON.parse(fs.readFileSync('streams_backup_khach.json', 'utf8'));

function callApi(ip, path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const postBody = data ? JSON.stringify(data) : null;
    const req = http.request({
      host: ip,
      port: 3131,
      path: path,
      method: method,
      headers: {
        'User-Agent': 'CyberShieldSecureAgent/1.0',
        'Content-Type': 'application/json',
        ...(postBody ? { 'Content-Length': Buffer.byteLength(postBody) } : {})
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, raw: body }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (postBody) req.write(postBody);
    req.end();
  });
}

function runSsh(ip, cmd, onStdout) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        let out = '';
        stream.on('data', d => {
          const str = d.toString();
          out += str;
          if (onStdout) onStdout(str);
        });
        stream.stderr.on('data', d => {
          const str = d.toString();
          if (onStdout) onStdout('[ERR] ' + str);
        });
        stream.on('close', code => {
          conn.end();
          resolve({ code, out });
        });
      });
    }).on('error', reject)
    .connect({
      host: ip,
      port: 22,
      username: SSH_USER,
      password: SSH_PASS,
      readyTimeout: 20000
    });
  });
}

async function migrateStream(oldStreamId, targetNodeIp = NEW_MASTER_IP, targetServerId = 'vps1') {
  const s = streams.find(item => item.id === oldStreamId);
  if (!s) {
    throw new Error(`Không tìm thấy luồng ID #${oldStreamId} trong bản sao lưu!`);
  }

  console.log(`\n======================================================`);
  console.log(`🚀 BẮT ĐẦU CHUYỂN LUỒNG #${s.id}: "${s.name}" (Chủ: ${s.ownerUsername})`);
  console.log(`📡 Stream Key: ${s.key.slice(0, 8)}... | Chế độ: ${s.mode}`);
  console.log(`🔗 Link Drive: ${s.originalFile || s.file}`);
  console.log(`🖥️ Máy chủ đích: ${targetServerId} (${targetNodeIp})`);
  console.log(`======================================================`);

  const driveUrl = s.originalFile || s.file;

  // Bước 1: Tải video từ Drive về máy chủ đích trước
  console.log(`\n⏳ BƯỚC 1: Đang tải video từ Google Drive về ${targetServerId}...`);
  const destDir = '/home/ubuntu/Livenew/downloads';

  const dlScript = `
node -e "
const { downloadGoogleDriveFile } = require('./driveDownloader.js');
let lastPct = -1;
downloadGoogleDriveFile('${driveUrl}', '${destDir}', (dl, total, pct, spd) => {
  if (pct !== null && pct !== lastPct && pct % 10 === 0) {
    lastPct = pct;
    process.stdout.write(pct + '% ');
  }
}).then(f => {
  console.log('\\n[DL_DONE] ' + f);
}).catch(e => {
  console.error('\\n[DL_ERROR] ' + e.message);
  process.exit(1);
});
"
`;

  let dlSuccess = false;
  let finalFilePath = '';
  await runSsh(targetNodeIp, `cd /home/ubuntu/Livenew && ${dlScript}`, (str) => {
    process.stdout.write(str);
    if (str.includes('[DL_DONE]')) {
      dlSuccess = true;
      const m = str.match(/\[DL_DONE\]\s+([^\r\n]+)/);
      if (m) finalFilePath = m[1].trim();
    }
  });

  if (!dlSuccess || !finalFilePath) {
    throw new Error(`❌ Tải video thất bại trên ${targetServerId}! Dừng chuyển để bảo toàn luồng cũ.`);
  }

  console.log(`\n✅ BƯỚC 1 HOÀN TẤT: Video đã tải xong 100%! Đường dẫn: ${finalFilePath}`);

  // Bước 2: Dừng luồng trên VPS cũ (13.140.208.154)
  console.log(`\n🛑 BƯỚC 2: Dừng luồng #${s.id} trên VPS cũ (13.140.208.154)...`);
  try {
    const stopRes = await callApi(OLD_VPS_IP, '/api/stop', 'POST', { id: s.id });
    console.log(`Dừng VPS cũ kết quả:`, stopRes.data);
  } catch (err) {
    console.warn(`Cảnh báo khi gọi stop trên VPS cũ:`, err.message);
  }

  // Chờ 2 giây để YouTube giải phóng Stream Key
  await new Promise(r => setTimeout(r, 2000));

  // Bước 3: Khởi chạy luồng trên Cụm mới (thông qua Master 57.129.135.140)
  console.log(`\n▶️ BƯỚC 3: Khởi chạy luồng trên Cụm mới (${targetServerId})...`);
  const startPayload = {
    name: s.name,
    key: s.key,
    file: finalFilePath,
    originalFile: driveUrl,
    mode: s.mode || 'loop',
    minutes: s.minutes || 0,
    dualStream: s.dualStream !== false,
    youtubeUrl: s.youtubeUrl || '',
    ownerId: s.ownerId || 'admin_root',
    ownerUsername: s.ownerUsername || 'admin',
    serverId: targetServerId
  };

  const startRes = await callApi(NEW_MASTER_IP, '/api/start', 'POST', startPayload);
  console.log(`Kết quả khởi chạy trên Cụm mới:`, startRes.data);

  if (startRes.data && startRes.data.id) {
    const newId = startRes.data.id;
    console.log(`\n🔍 Đang theo dõi tiến trình luồng #${newId} trong 10 giây...`);
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const stList = await callApi(NEW_MASTER_IP, '/api/streams');
      if (Array.isArray(stList.data)) {
        const liveSt = stList.data.find(x => x.id === newId || x.keyHint === s.keyHint);
        if (liveSt) {
          console.log(`[Giây ${(i+1)*2}] Trạng thái: ${liveSt.status} | Speed: ${liveSt.lastLog || 'N/A'}`);
          if (liveSt.status === 'live') {
            console.log(`\n🎉 LUỒNG #${s.id} ("${s.name}") ĐÃ CHUYỂN THÀNH CÔNG VÀ ĐANG LIVE TRÊN CỤM MỚI!`);
            return { ok: true, streamId: newId, name: s.name, status: liveSt.status };
          }
        }
      }
    }
  }

  return { ok: true, name: s.name };
}

// Export for execution
module.exports = { migrateStream, streams };

if (require.main === module) {
  const streamId = parseInt(process.argv[2]) || 1;
  const targetServerId = process.argv[3] || 'vps1';
  const targetIp = targetServerId === 'vps2' ? NEW_WORKER_IP : NEW_MASTER_IP;
  migrateStream(streamId, targetIp, targetServerId).catch(err => {
    console.error(`❌ Lỗi:`, err.message);
    process.exit(1);
  });
}
