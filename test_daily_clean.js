/**
 * test_daily_clean.js — Dọn dẹp cuối ngày: đúng giờ thì xóa luồng đã dừng/kết thúc, không đụng luồng đang live / đặt lịch.
 *  - Máy A: DAILY_CLEAN_TIME = giờ VN hiện tại + 1 phút → tới giờ phải dọn
 *  - Máy B: DAILY_CLEAN_TIME = giờ VN hiện tại - 1 phút (bật máy SAU giờ dọn) → KHÔNG được xóa ngay
 * Chạy: node test_daily_clean.js   (mất ~2 phút)
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const WORK = path.join(os.tmpdir(), 'livenew_daily_clean_test');
const SECRET = 'daily-clean-test-secret-12345';
const FAKE_FF = path.join(WORK, 'fake_ffmpeg.exe');
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;
let passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(name, cond, detail = '') {
  if (cond) { console.log(G('  ✓ PASS'), name); passed++; }
  else { console.log(R('  ✗ FAIL'), name, detail ? `→ ${detail}` : ''); failed++; }
}
function vnMinutes() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
}
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const procs = [];
function start(id, port, extraEnv) {
  const dir = path.join(WORK, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(ROOT)) if (/\.js$/.test(f) && !/^test|long_test/.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  for (const d of ['videos', 'music', 'temp', 'downloads']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'videos', 'a.mp4'), 'fake');
  fs.copyFileSync(FAKE_FF, path.join(dir, 'ffmpeg.exe'));
  fs.writeFileSync(path.join(dir, 'cluster_nodes.json'), JSON.stringify([{ id, name: id, ip: '127.0.0.1', port, isMaster: true }]));
  fs.writeFileSync(path.join(dir, 'bot_config.json'), JSON.stringify({ token: '', adminIds: [], password: 'x', polling: false, zalo: { enabled: false }, sentinel: { enabled: false, knownServers: [] } }));
  const env = { ...process.env, PORT: String(port), NODE_ID: id, CLUSTER_SECRET: SECRET, STRICT_INTERNAL: '1', SKIP_FFMPEG_CLEANUP: '1', HISTORY_SHEET: '0', SHEET_NODES: '0', AUTO_MIGRATE: '0', DRIVE_AUTO_COPY: '0', PURGE_INTERVAL_MS: String(24 * 3600 * 1000), DAILY_CLEAN_KEEP_MIN: '0', NODE_PATH: path.join(ROOT, 'node_modules'), ...extraEnv };
  delete env.DAILY_CLEAN;
  const out = [];
  const p = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => out.push(d.toString())); p.stderr.on('data', d => out.push(d.toString()));
  procs.push(p);
  return { dir, out, port };
}
async function call(port, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Cluster-Secret': SECRET }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
async function waitUp(port) {
  for (let i = 0; i < 40; i++) { try { if ((await call(port, 'GET', '/api/health')).status === 200) return true; } catch (_) {} await sleep(500); }
  return false;
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(500); }
  return null;
}
const list = async port => {
  // Chỉ lấy luồng CỤC BỘ của máy đó (không gom từ máy khác trong cụm)
  const r = await fetch(`http://127.0.0.1:${port}/api/streams`, { headers: { 'X-Cluster-Secret': SECRET, 'X-Cluster-Forwarded': '1' } });
  try { return await r.json(); } catch (_) { return []; }
};

async function seed(node) {
  const file = path.join(node.dir, 'videos', 'a.mp4');
  const future = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 16);
  const live = await call(node.port, 'POST', '/api/start', { key: 'live-key-' + node.port, file, mode: 'loop', minutes: 0, name: 'Đang live', serverId: node.dir.endsWith('dcA') ? 'dcA' : 'dcB' });
  const done = await call(node.port, 'POST', '/api/start', { key: 'done-key-' + node.port, file, mode: 'loop', minutes: 0, name: 'Đã dừng', serverId: node.dir.endsWith('dcA') ? 'dcA' : 'dcB' });
  const sched = await call(node.port, 'POST', '/api/start', { key: 'sched-key-' + node.port, file, mode: 'scheduled', scheduledMode: 'loop', scheduledTime: future, minutes: 0, name: 'Đặt lịch', serverId: node.dir.endsWith('dcA') ? 'dcA' : 'dcB' });
  const ids = { live: live.data && live.data.id, done: done.data && done.data.id, sched: sched.data && sched.data.id };
  await waitFor(async () => (await list(node.port)).filter(s => s.status === 'live').length >= 2);
  await call(node.port, 'POST', '/api/stop', { id: ids.done, serverId: node.dir.endsWith('dcA') ? 'dcA' : 'dcB' });
  await waitFor(async () => { const s = (await list(node.port)).find(x => x.id === ids.done); return s && s.status === 'stopped'; });
  return ids;
}

(async () => {
  try {
    fs.mkdirSync(WORK, { recursive: true });
    execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/out:' + FAKE_FF, path.join(ROOT, 'test_fixtures', 'fake_ffmpeg.cs')]);
    let now = vnMinutes();
    if (now >= 23 * 60 + 57 || now < 2) { console.log(Y('Gần nửa đêm, chờ qua 00:02 rồi chạy lại.')); process.exit(0); }
    const A = start('dcA', 3241, { DAILY_CLEAN_TIME: hhmm(now + 2) });
    const B = start('dcB', 3242, { DAILY_CLEAN_TIME: hhmm(now - 1) });
    assert('2 máy khởi động', (await waitUp(A.port)) && (await waitUp(B.port)));
    assert('Log báo đã bật dọn cuối ngày đúng giờ', !!(await waitFor(() => A.out.join('').includes(`dọn dẹp cuối ngày lúc ${hhmm(now + 2)}`), 10000)), A.out.join('').slice(-400));

    console.log(Y('\n[ 1 ] Tạo 3 luồng mỗi máy: đang live / đã dừng / đặt lịch'));
    const ia = await seed(A), ib = await seed(B);
    const la = await list(A.port);
    assert('Máy A có đủ 3 luồng trước giờ dọn', la.length === 3 && la.find(s => s.id === ia.done).status === 'stopped', JSON.stringify(la.map(s => [s.id, s.status])));

    console.log(Y(`\n[ 2 ] Chờ tới giờ dọn ${hhmm(now + 2)} (≤ ~3 phút)...`));
    const cleaned = await waitFor(() => A.out.join('').includes('Dọn dẹp cuối ngày'), 200000);
    assert('Tới giờ: máy A chạy dọn dẹp cuối ngày', !!cleaned, A.out.join('').slice(-600));
    const la2 = await list(A.port);
    assert('Luồng ĐÃ DỪNG bị xóa', !la2.some(s => s.id === ia.done), JSON.stringify(la2.map(s => [s.id, s.status])));
    assert('Luồng ĐANG LIVE còn nguyên và vẫn live', la2.some(s => s.id === ia.live && s.status === 'live'));
    assert('Luồng ĐẶT LỊCH còn nguyên', la2.some(s => s.id === ia.sched && s.status === 'scheduled'));
    assert('Log ghi đúng số luồng đã xóa (1)', /Dọn dẹp cuối ngày [\d-]+: xóa 1 luồng/.test(A.out.join('')), (A.out.join('').match(/Dọn dẹp cuối ngày.*/) || [''])[0]);
    const hist = (await call(A.port, 'GET', '/api/history')).data || [];
    assert('Luồng bị dọn vẫn còn trong Lịch sử', hist.some(h => h.name === 'Đã dừng'), JSON.stringify(hist.map(h => h.name)));
    const backup = JSON.parse(fs.readFileSync(path.join(A.dir, 'streams_backup.json'), 'utf8'));
    assert('File sao lưu không còn luồng đã xóa', !backup.some(s => s.id === ia.done));

    console.log(Y('\n[ 3 ] Máy bật SAU giờ dọn: không xóa ngay, để tới tối hôm sau'));
    const lb = await list(B.port);
    assert('Máy B vẫn giữ luồng đã dừng', lb.some(s => s.id === ib.done && s.status === 'stopped'), JSON.stringify(lb.map(s => [s.id, s.status])));
    assert('Máy B không chạy dọn cuối ngày', !B.out.join('').includes('Dọn dẹp cuối ngày'));

    console.log(Y('\n[ 4 ] Chỉ chạy 1 lần/ngày'));
    await sleep(65000);
    const runs = (A.out.join('').match(/Dọn dẹp cuối ngày [\d-]+:/g) || []).length;
    assert('Sau 1 phút nữa không chạy lại lần 2', runs === 1, `runs=${runs}`);
  } catch (e) {
    console.log(R('LỖI TEST: ' + e.stack));
    failed++;
  } finally {
    procs.forEach(p => { try { p.kill(); } catch (_) {} });
    console.log(`\nKết quả: ${G(passed + ' PASS')}, ${failed ? R(failed + ' FAIL') : '0 FAIL'}`);
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  }
})();
