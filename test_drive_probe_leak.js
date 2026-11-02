/**
 * test_drive_probe_leak.js — Bước 1 tải Drive (getDirectDownloadInfo):
 *  1) Không được giữ socket sau khi chuyển hướng / đọc header file (trước đây rò rỉ → hết 64 socket → treo vĩnh viễn)
 *  2) Server treo không trả lời → phải báo lỗi sau thời gian chờ, không kẹt mãi
 * Chạy: node test_drive_probe_leak.js [đường_dẫn_module]   (mặc định ./driveDownloader)
 */
process.env.DRIVE_PROBE_TIMEOUT_MS = process.env.DRIVE_PROBE_TIMEOUT_MS || '2000';
const http = require('http');
const path = require('path');
const D = require(path.resolve(process.argv[2] || './driveDownloader'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓ PASS' : '✗ FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`treo quá ${ms}ms`)), ms))]);

const BIG = Buffer.alloc(256 * 1024, 1);
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/r')) { res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/f` }); res.end('chuyen huong'); return; }
  if (req.url.startsWith('/f')) {
    // Giả lập file lớn: gửi dần, không bao giờ kết thúc nhanh → client phải tự hủy
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(BIG.length * 1000) });
    const t = setInterval(() => { if (!res.write(BIG)) {} }, 50);
    res.on('close', () => clearInterval(t));
    return;
  }
  if (req.url.startsWith('/hang')) return; // không trả lời
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = D._agents ? D._agents.httpAgent : null;

  console.log('\n[ 1 ] 100 lần lấy thông tin tải liên tiếp (pool chỉ 64 socket)');
  let done = 0, err = null;
  try {
    for (let i = 0; i < 100; i++) {
      const info = await withTimeout(D.getDirectDownloadInfo(`${base}/r?i=${i}`, '', 1), 3000);
      if (info && info.totalBytes > 0) done++;
    }
  } catch (e) { err = e.message; }
  ok('Cả 100 lần đều xong, không bị treo', done === 100, err ? `dừng ở lần ${done + 1}: ${err}` : '');
  ok('Đọc đúng dung lượng file từ header', done > 0);
  if (agent) {
    await new Promise(r => setTimeout(r, 300));
    const busy = Object.values(agent.sockets).reduce((a, l) => a + l.length, 0);
    ok('Không còn socket bị giữ sau khi xong', busy === 0, `đang giữ ${busy}`);
  }

  console.log('\n[ 2 ] Server treo không trả lời');
  const t0 = Date.now();
  let msg = '';
  try { await withTimeout(D.getDirectDownloadInfo(`${base}/hang`, '', 1), 8000); msg = 'không lỗi?'; }
  catch (e) { msg = e.message; }
  ok('Báo lỗi sau thời gian chờ (không kẹt mãi)', /không phản hồi/.test(msg), `${msg} (${Date.now() - t0}ms)`);

  console.log(`\n═══ Kết quả: ${pass} PASS  ${fail} FAIL ═══\n`);
  server.close();
  process.exit(fail ? 1 : 0);
})();
