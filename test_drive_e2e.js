// Test tải TRỌN VẸN qua downloadGoogleDriveFile (lấy link → chia luồng tải Range → ghép → so sánh từng byte)
// Máy chủ giả đóng vai Google: drive.google.com (127.0.0.1) chuyển hướng sang drive.usercontent (localhost), hỗ trợ Range
const http = require('http'), https = require('https'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const D = require(path.resolve(process.argv[2] || './driveDownloader'));
const mk = (n, seed) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; };
const FILES = { BIG: mk(60 * 1024 * 1024, 7), SMALL: mk(1024 * 1024, 3) };
let port;
let truncOnce = false;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/uc') { res.writeHead(303, { Location: `http://localhost:${port}/download?id=${u.searchParams.get('id')}` }); res.end('moved'); return; }
  if (u.pathname === '/download') {
    const id = u.searchParams.get('id') || '';
    const buf = id.startsWith('BIG') ? FILES.BIG : FILES.SMALL;
    const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || '');
    // Giả lập: bước probe (không có Range) vẫn trả 200 video/mp4, nhưng khi tải chunk (có Range) thì Google chạm ngưỡng quota và trả 200 text/html
    if (id.startsWith('QUOTACHUNK') && m) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>Too many users have viewed or downloaded this file recently. Quota exceeded.</body></html>');
      return;
    }
    if (id.startsWith('TRUNCCHUNK') && m && !truncOnce) {
      truncOnce = true;
      const s = +m[1], e = m[2] ? +m[2] : buf.length - 1;
      const half = Math.floor((e - s + 1) / 2);
      res.writeHead(206, { 'Content-Length': e - s + 1, 'Content-Type': 'video/mp4' });
      res.end(buf.subarray(s, s + half)); // đóng kết nối sớm khi mới gửi 1/2 chunk
      return;
    }
    if (m) { const s = +m[1], e = m[2] ? +m[2] : buf.length - 1; res.writeHead(206, { 'Content-Length': e - s + 1, 'Content-Type': 'video/mp4' }); res.end(buf.subarray(s, e + 1)); }
    else { res.writeHead(200, { 'Content-Length': buf.length, 'Content-Type': 'video/mp4' }); res.end(buf); }
    return;
  }
  res.writeHead(404); res.end();
});
// Chuyển hướng mọi yêu cầu https://drive.google.com sang máy chủ giả (không đụng Google thật)
const origGet = https.get;
https.get = (url, opts, cb) => http.get(String(url).replace('https://drive.google.com', `http://127.0.0.1:${port}`), { ...opts, agent: D._agents.httpAgent }, cb);
const held = () => Object.values(D._agents.httpAgent.sockets).reduce((a, l) => a + l.length, 0);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : fail++; console.log(`  ${c ? '✓ PASS' : '✗ FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('TREO')), ms))]);

server.listen(0, '127.0.0.1', async () => {
  port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd_e2e_'));
  try {
    console.log('\n[ 1 ] Tải trọn file 60MB (4 luồng song song)');
    const f = await withTimeout(D.downloadGoogleDriveFile('https://drive.google.com/file/d/BIGFILE00001/view', dir, () => {}), 60000);
    const got = fs.readFileSync(f);
    ok('Ghép xong, đúng dung lượng', got.length === FILES.BIG.length, `${got.length} bytes`);
    ok('Nội dung khớp từng byte (SHA-256)', sha(got) === sha(FILES.BIG));
    fs.unlinkSync(f);

    console.log('\n[ 2 ] 80 lần tải trọn liên tiếp (vượt ngưỡng 64 của code cũ)');
    let done = 0, err = '';
    for (let i = 1; i <= 80; i++) {
      try {
        const p = await withTimeout(D.downloadGoogleDriveFile(`https://drive.google.com/file/d/SMALLFILE${String(i).padStart(4, '0')}/view`, dir, () => {}), 10000);
        if (sha(fs.readFileSync(p)) === sha(FILES.SMALL)) done++;
        fs.unlinkSync(p);
      } catch (e) { err = `lần ${i}: ${e.message}`; break; }
    }
    ok('Cả 80 lần tải đều xong và đúng nội dung', done === 80, err || `${done}/80`);

    console.log('\n[ 3 ] Probe 200 OK nhưng tải chunk bị trả 200 text/html (hết quota giữa chừng) → phải báo DRIVE_QUOTA, không lưu HTML thành .mp4');
    let quotaErr = null;
    try {
      await withTimeout(D.downloadGoogleDriveFile('https://drive.google.com/file/d/QUOTACHUNK001/view', dir, () => {}), 15000);
    } catch (e) { quotaErr = e; }
    ok('Bắt đúng mã lỗi DRIVE_QUOTA khi chunk trả HTML', quotaErr && quotaErr.code === 'DRIVE_QUOTA', quotaErr ? `${quotaErr.code}: ${quotaErr.message.slice(0, 60)}` : 'không báo lỗi!');

    console.log('\n[ 4 ] Kết nối đóng sớm làm thiếu byte ở chunk → tự phát hiện và tải bù đủ 100%');
    const fTrunc = await withTimeout(D.downloadGoogleDriveFile('https://drive.google.com/file/d/TRUNCCHUNK001/view', dir, () => {}), 15000);
    const gotTrunc = fs.readFileSync(fTrunc);
    ok('Tải bù đủ dung lượng & đúng SHA-256 sau khi bị ngắt sớm', gotTrunc.length === FILES.SMALL.length && sha(gotTrunc) === sha(FILES.SMALL));
    fs.unlinkSync(fTrunc);

    await new Promise(r => setTimeout(r, 300));
    ok('Không còn kết nối bị giữ', held() === 0, `đang giữ ${held()}`);
    const leftovers = fs.readdirSync(dir);
    ok('Không để lại thư mục/phân đoạn tạm', leftovers.length === 0, leftovers.join(',') || 'sạch');
  } catch (e) { ok('Không lỗi bất ngờ', false, e.message); }
  console.log(`\n═══ Kết quả: ${pass} PASS  ${fail} FAIL ═══\n`);
  https.get = origGet; server.close(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
});

