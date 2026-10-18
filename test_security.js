/**
 * test_security.js — Kiểm tra lỗ hổng "giả User-Agent là có quyền admin" đã bị đóng.
 * Chạy: node test_security.js   (server chạy KHÔNG đặt STRICT_INTERNAL, giống VPS thật)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const WORK = path.join(os.tmpdir(), 'livenew_security_test');
const SECRET = 'sec-test-secret-1234567890';
const UA = 'Mozilla/5.0 Chrome/120 CyberShieldSecureAgent/1.0';
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;
let passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(name, cond, detail = '') {
  if (cond) { console.log(G('  ✓ PASS'), name); passed++; }
  else { console.log(R('  ✗ FAIL'), name, detail ? `→ ${detail}` : ''); failed++; }
}
const procs = [];
function start(id, port, extraEnv = {}) {
  const dir = path.join(WORK, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(ROOT)) if (/\.js$/.test(f) && !/^test|long_test/.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  for (const d of ['videos', 'music', 'temp', 'downloads']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cluster_nodes.json'), JSON.stringify([{ id, name: id, ip: '127.0.0.1', port, isMaster: true }]));
  fs.writeFileSync(path.join(dir, 'bot_config.json'), JSON.stringify({ token: '', adminIds: [], password: 'x', polling: false, zalo: { enabled: false }, sentinel: { enabled: false, knownServers: [] } }));
  const env = { ...process.env, PORT: String(port), NODE_ID: id, CLUSTER_SECRET: SECRET, SKIP_FFMPEG_CLEANUP: '1', HISTORY_SHEET: '0', NODE_PATH: path.join(ROOT, 'node_modules'), ...extraEnv };
  delete env.STRICT_INTERNAL; delete env.ALLOW_APP_UA;
  Object.assign(env, extraEnv);
  const out = [];
  const p = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => out.push(d.toString())); p.stderr.on('data', d => out.push(d.toString()));
  procs.push(p);
  return out;
}
async function req(port, method, p, headers = {}, body) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
async function waitUp(port) {
  for (let i = 0; i < 40; i++) { try { if ((await req(port, 'GET', '/api/health')).status === 200) return true; } catch (_) {} await sleep(500); }
  return false;
}

(async () => {
  try {
    console.log(Y('\n[ 1 ] Server mặc định (không STRICT_INTERNAL) — giả User-Agent KHÔNG còn là admin'));
    const P = 3181;
    start('sec1', P);
    assert('Server khởi động', await waitUp(P));
    const H = { 'User-Agent': UA };
    const H2 = { 'User-Agent': UA, 'X-Cluster-Forwarded': '1' };
    const cases = [
      ['GET', '/api/streams'], ['GET', '/api/sysinfo'], ['GET', '/api/history'], ['GET', '/api/cluster/nodes'],
      ['GET', '/api/sheet-config'], ['POST', '/api/start', { key: 'x', file: 'a.mp4', mode: 'loop' }],
      ['POST', '/api/cluster/notify', { channel: 'telegram', text: 'spam' }],
      ['POST', '/api/cluster/reserve-key', { key: 'k', token: 't' }],
      ['POST', '/api/cluster/nodes', { id: 'evil', ip: '1.2.3.4' }],
    ];
    for (const [m, p, b] of cases) {
      const r1 = await req(P, m, p, H, b);
      const r2 = await req(P, m, p, H2, b);
      assert(`Giả UA → ${m} ${p} bị chặn (401)`, r1.status === 401 && r2.status === 401, `${r1.status}/${r2.status}`);
    }
    const nodes = await req(P, 'GET', '/api/cluster/nodes', { 'X-Cluster-Secret': SECRET });
    assert('Kẻ giả UA không thêm được máy lạ vào cụm', Array.isArray(nodes.data) && !nodes.data.some(n => n.id === 'evil'));

    const wrong = await req(P, 'GET', '/api/streams', { 'X-Cluster-Secret': SECRET.replace(/.$/, 'X') });
    assert('Secret sai 1 ký tự (cùng độ dài) → 401', wrong.status === 401, `status=${wrong.status}`);
    const uni = await req(P, 'GET', '/api/streams', { 'X-Cluster-Secret': encodeURIComponent('ặ'.repeat(10)) });
    assert('Secret lạ → 401, server không sập', uni.status === 401 && await waitUp(P));
    const ok = await req(P, 'GET', '/api/streams', { 'X-Cluster-Secret': SECRET });
    assert('Secret đúng (máy trong cụm) → 200', ok.status === 200, `status=${ok.status}`);
    const sentinel = await req(P, 'GET', '/api/sysinfo', { 'User-Agent': UA, 'X-Cluster-Secret': SECRET });
    assert('Kiểu gọi của Sentinel (UA + secret) → 200 có dữ liệu', sentinel.status === 200 && !!sentinel.data && !!sentinel.data.platform, `status=${sentinel.status}`);
    const health = await req(P, 'GET', '/api/health');
    assert('/api/health vẫn công khai (để kiểm tra sống/chết)', health.status === 200);
    const page = await fetch(`http://127.0.0.1:${P}/`, { headers: H });
    assert('Trang web vẫn mở được (hiện màn đăng nhập)', page.status === 200);

    console.log(Y('\n[ 2 ] Bật lại kiểu cũ chỉ khi chủ động đặt ALLOW_APP_UA=1'));
    const P2 = 3182;
    start('sec2', P2, { ALLOW_APP_UA: '1' });
    assert('Server (ALLOW_APP_UA=1) khởi động', await waitUp(P2));
    assert('ALLOW_APP_UA=1 → giả UA được vào (đúng như cấu hình)', (await req(P2, 'GET', '/api/streams', H)).status === 200);
    const P3 = 3183;
    start('sec3', P3, { ALLOW_APP_UA: '1', STRICT_INTERNAL: '1' });
    assert('Server (ALLOW_APP_UA=1 + STRICT_INTERNAL=1) khởi động', await waitUp(P3));
    assert('STRICT_INTERNAL=1 luôn thắng → giả UA bị chặn', (await req(P3, 'GET', '/api/streams', H)).status === 401);
  } catch (e) { console.error(R('Lỗi test:'), e); failed++; }
  procs.forEach(p => { try { p.kill(); } catch (_) {} });
  await sleep(500);
  console.log(`\n═══ Kết quả: ${passed} PASS  ${failed} FAIL ═══`);
  process.exit(failed ? 1 : 0);
})();
