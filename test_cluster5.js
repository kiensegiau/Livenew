/**
 * test_cluster5.js — Test cụm 5 VPS GIẢ (localhost, cổng 3141-3145) khi có máy gặp sự cố.
 * Chạy: node test_cluster5.js
 * An toàn: thư mục tạm riêng, token Telegram/Zalo rỗng, chỉ trỏ 127.0.0.1 (không chạm VPS thật).
 *
 * Kịch bản: boot 5 node → điều phối chéo → 1 Worker chết (luồng tự chuyển, vẫn điều phối chéo,
 * thông báo vẫn về Master) → Master chết (Worker tiếp quản, thông báo Worker tự gửi vì không về được Master)
 * → các máy sống lại (dừng bản trùng key).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const WORK = path.join(os.tmpdir(), 'livenew_cluster5_test');
const SECRET = 'cluster-test-secret';
const BASE_PORT = 3141;
const AFTER_SEC = 6;
const NODES = [1, 2, 3, 4, 5].map(i => ({
  id: `vps${i}`, name: `VPS ${i} (${i === 1 ? 'Master' : 'Worker'})`, ip: '127.0.0.1', port: BASE_PORT + i - 1, isMaster: i === 1,
}));

const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;
let passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(name, cond, detail = '') {
  if (cond) { console.log(G('  ✓ PASS'), name); passed++; }
  else { console.log(R('  ✗ FAIL'), name, detail ? `→ ${detail}` : ''); failed++; }
}

const procs = {}, logs = {};

function prepareDir(n) {
  const dir = path.join(WORK, n.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(ROOT)) {
    if (/\.js$/.test(f) && !/^test|long_test/.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  for (const d of ['videos', 'music', 'temp', 'downloads']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cluster_nodes.json'), JSON.stringify(NODES, null, 2));
  fs.writeFileSync(path.join(dir, 'bot_config.json'), JSON.stringify({
    token: '', adminIds: [], password: 'x', polling: false,
    zalo: { enabled: false }, sentinel: { enabled: false, knownServers: [] },
  }));
  return dir;
}

function startNode(n, fresh = true) {
  const dir = fresh ? prepareDir(n) : path.join(WORK, n.id);
  const out = [];
  logs[n.id] = out;
  const p = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(n.port), NODE_ID: n.id, CLUSTER_SECRET: SECRET, STRICT_INTERNAL: '1', SKIP_FFMPEG_CLEANUP: '1',
      FAILOVER_AFTER_SEC: String(AFTER_SEC), FAILOVER_TICK_MS: '1000',
      FAILOVER_NET_CHECK_URL: `http://127.0.0.1:${n.port}/api/health`,
      NODE_PATH: path.join(ROOT, 'node_modules'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', d => out.push(d.toString()));
  p.stderr.on('data', d => out.push(d.toString()));
  procs[n.id] = p;
}

function killNode(id) {
  return new Promise(res => {
    const p = procs[id];
    if (!p || p.exitCode !== null) return res();
    p.once('exit', () => res());
    p.kill();
    setTimeout(res, 3000);
  });
}

const node = id => NODES.find(n => n.id === id);
const urlOf = n => `http://127.0.0.1:${n.port}`;
async function call(id, method, p, body, headers) {
  const h = { 'Content-Type': 'application/json', 'X-Cluster-Secret': SECRET, 'X-Cluster-Forwarded': '0', ...headers };
  const r = await fetch(urlOf(node(id)) + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
async function localStreams(id) {
  try { const r = await call(id, 'GET', '/api/streams', null, { 'X-Cluster-Forwarded': '1' }); return Array.isArray(r.data) ? r.data : []; }
  catch (_) { return []; }
}
async function waitFor(fn, timeoutMs, stepMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(stepMs); }
  return null;
}
const waitHealthy = id => waitFor(async () => (await call(id, 'GET', '/api/health')).status === 200, 20000);
const ACTIVE = ['live', 'reconnecting', 'launching', 'scheduled', 'downloading'];
const alive = () => NODES.map(n => n.id).filter(id => procs[id] && procs[id].exitCode === null);
async function findByKey(key, ids) {
  const found = [];
  for (const id of ids) {
    if (procs[id] && procs[id].exitCode === null) {
      for (const s of await localStreams(id)) if (s.key === key && ACTIVE.includes(s.status)) found.push({ nodeId: id, stream: s });
    }
  }
  return found;
}
const soon = () => {
  const d = new Date(Date.now() + 3600 * 1000), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const startBody = (key, serverId) => ({
  key, file: 'http://127.0.0.1:9/video.mp4', mode: 'scheduled', minutes: 0,
  scheduledTime: soon(), name: `test-${key}`, ...(serverId ? { serverId } : {}),
});
const logText = id => (logs[id] || []).join('');
const allLogs = () => Object.values(logs).map(l => l.join('')).join('\n');

async function run() {
  fs.mkdirSync(WORK, { recursive: true });

  console.log(Y('\n═══ TEST CỤM 5 VPS GIẢ (cổng 3141-3145) ═══'));
  console.log(Y('\n[ 1 ] Khởi động 5 node'));
  NODES.forEach(n => startNode(n));
  for (const n of NODES) assert(`${n.id} health OK (cổng ${n.port})`, !!(await waitHealthy(n.id)));

  console.log(Y('\n[ 2 ] Điều phối chéo giữa 5 máy: vào 1 máy, tạo luồng ở 4 máy còn lại'));
  const keys = {};
  for (const target of ['vps1', 'vps2', 'vps3', 'vps4', 'vps5']) {
    const entry = target === 'vps3' ? 'vps5' : (target === 'vps1' ? 'vps4' : 'vps3');
    keys[target] = `x${target}-aaaa-bbbb-cccc-dddd`;
    const r = await call(entry, 'POST', '/api/start', startBody(keys[target], target));
    assert(`Vào ${entry}, tạo luồng trên ${target}`, !r.data?.error && (await findByKey(keys[target], [target])).length === 1, JSON.stringify(r.data));
  }
  // Thêm 1 luồng nữa lên vps4 để thử chuyển nhiều luồng khi vps4 chết
  const k4b = 'x4b-aaaa-bbbb-cccc-dddd';
  await call('vps2', 'POST', '/api/start', startBody(k4b, 'vps4'));
  for (const id of alive()) {
    const all = await call(id, 'GET', '/api/streams');
    const n = Array.isArray(all.data) ? all.data.filter(s => /^test-x/.test(s.name)).length : 0;
    assert(`Vào ${id} thấy đủ 6 luồng của cả cụm`, n === 6, `n=${n}`);
  }

  console.log(Y('\n[ 3 ] Thông báo từ mọi Worker đều chuyển về Master (vps1)'));
  for (const w of ['vps2', 'vps3', 'vps4', 'vps5']) {
    await call(w, 'POST', '/api/start', { key: `ntf-${w}-aaaa-bbbb-cccc`, file: 'khong_ton_tai_xyz.mp4', mode: 'loop', minutes: 0, name: `ntf-${w}` }, { 'X-Cluster-Forwarded': '1' });
  }
  await waitFor(async () => /Nhận thông báo từ VPS 5/.test(logText('vps1')), 10000);
  for (const [i, w] of [[2, 'vps2'], [3, 'vps3'], [4, 'vps4'], [5, 'vps5']]) {
    assert(`Master nhận thông báo từ ${w}`, new RegExp(`Nhận thông báo từ VPS ${i}`).test(logText('vps1')));
    assert(`${w} có log chuyển tiếp về Master`, /\[Notify\] ➡️/.test(logText(w)));
  }
  assert('Master không tự chuyển tiếp thông báo đi đâu', !/\[Notify\] ➡️/.test(logText('vps1')));

  console.log(Y('\n[ 4 ] Worker vps4 gặp sự cố → 2 luồng của nó tự chuyển sang máy còn sống'));
  await sleep(3500);
  await killNode('vps4');
  console.log(`    → vps4 đã bị tắt, chờ ~${AFTER_SEC + 10}s...`);
  const movedAll = await waitFor(async () => {
    const a = await findByKey(keys.vps4, ['vps1', 'vps2', 'vps3', 'vps5']);
    const b = await findByKey(k4b, ['vps1', 'vps2', 'vps3', 'vps5']);
    return a.length && b.length ? { a, b } : null;
  }, (AFTER_SEC + 20) * 1000);
  assert('Cả 2 luồng của vps4 được chuyển đi', !!movedAll);
  if (movedAll) assert('Mỗi luồng chỉ chạy trên đúng 1 máy (không trùng key)', movedAll.a.length === 1 && movedAll.b.length === 1);
  assert('Luồng của các máy khác không bị đụng (vẫn đúng 1 bản)',
    (await Promise.all(['vps1', 'vps2', 'vps3', 'vps5'].map(t => findByKey(keys[t], alive())))).every(f => f.length === 1));
  assert('Có thông báo WORKER mất kết nối', /WORKER VPS 4/.test(allLogs()));
  const r4 = await call('vps2', 'POST', '/api/start', startBody('after4-aaaa-bbbb-cccc-dddd', 'vps5'));
  assert('Cụm còn 4 máy vẫn điều phối chéo bình thường', !r4.data?.error && (await findByKey('after4-aaaa-bbbb-cccc-dddd', ['vps5'])).length === 1, JSON.stringify(r4.data));
  const rep = await waitFor(async () => {
    const r = await call('vps1', 'GET', '/api/cluster/report');
    const t = ((r.data && r.data.messages) || []).join('\n');
    return /Cụm: \*4\/5\*/.test(t) ? t : null;
  }, 30000);
  assert('Báo cáo cụm: 4/5 online, vps4 OFFLINE', !!rep && /🔴 \*VPS 4/.test(rep), rep && rep.slice(0, 300));

  console.log(Y('\n[ 5 ] Master vps1 gặp sự cố → Worker tiếp quản'));
  await sleep(3500);
  await killNode('vps1');
  console.log(`    → vps1 đã bị tắt, chờ ~${AFTER_SEC + 10}s...`);
  const m = await waitFor(async () => {
    const f = await findByKey(keys.vps1, ['vps2', 'vps3', 'vps5']);
    return f.length ? f : null;
  }, (AFTER_SEC + 20) * 1000);
  assert('Luồng của Master được chuyển sang Worker', !!m);
  if (m) assert('Không chạy trùng giữa các Worker', m.length === 1, `n=${m.length}`);
  const took = id => /WORKER TIẾP QUẢN/.test(logText(id));
  await waitFor(async () => took('vps2') || took('vps3') || took('vps5'), 20000);
  await sleep(2000);
  assert('Chỉ vps2 (id nhỏ nhất còn sống) tiếp quản; vps3, vps5 không tự chuyển trùng', took('vps2') && !took('vps3') && !took('vps5'), `vps2=${took('vps2')} vps3=${took('vps3')} vps5=${took('vps5')}`);
  const r5 = await call('vps5', 'POST', '/api/start', startBody('after1-aaaa-bbbb-cccc-dddd', 'vps3'));
  assert('Khi Master chết, vào Worker vps5 vẫn tạo được luồng ở vps3', !r5.data?.error && (await findByKey('after1-aaaa-bbbb-cccc-dddd', ['vps3'])).length === 1, JSON.stringify(r5.data));
  const r5b = await call('vps3', 'POST', '/api/stop', { id: r5.data && r5.data.id, serverId: 'vps3' });
  assert('Vào Worker vẫn dừng được luồng', r5b.data?.ok === true, JSON.stringify(r5b.data));
  const before = logText('vps5').length;
  await call('vps5', 'POST', '/api/start', { key: 'ntf-nomaster-aaaa-bbbb', file: 'khong_ton_tai_xyz.mp4', mode: 'loop', minutes: 0, name: 'ntf-nomaster' }, { 'X-Cluster-Forwarded': '1' });
  const fb = await waitFor(async () => /Không chuyển được về Master/.test(logText('vps5').slice(before)), 15000);
  assert('Master chết: Worker không mất tin, tự gửi tại chỗ (fallback)', !!fb);

  console.log(Y('\n[ 6 ] Máy hỏng sống lại → dừng bản cũ, tránh trùng Stream Key'));
  startNode(node('vps4'), false);
  startNode(node('vps1'), false);
  assert('vps4 sống lại', !!(await waitHealthy('vps4')));
  assert('vps1 sống lại', !!(await waitHealthy('vps1')));
  const c4 = await waitFor(async () => { const s = (await localStreams('vps4')).filter(x => x.key === keys.vps4 || x.key === k4b); return s.length && s.every(x => !ACTIVE.includes(x.status)) ? s : null; }, 20000);
  assert('Luồng cũ trên vps4 bị dừng', !!c4);
  const c1 = await waitFor(async () => { const s = (await localStreams('vps1')).find(x => x.key === keys.vps1); return s && !ACTIVE.includes(s.status) ? s : null; }, 20000);
  assert('Luồng cũ trên vps1 bị dừng', !!c1);
  for (const k of [keys.vps1, keys.vps4, k4b]) {
    assert(`Key ${k.slice(0, 5)}… chỉ chạy đúng 1 nơi`, (await findByKey(k, alive())).length === 1);
  }

  console.log(Y('\n[ 7 ] Kiểm tra chéo kỹ: trùng key, sửa, dừng, dọn, máy đích chết, bấm đồng thời'));
  {
    // Chờ danh sách/telemetry ổn định sau khi vps1, vps4 sống lại
    await waitFor(async () => { const r = await call('vps2', 'GET', '/api/streams'); return Array.isArray(r.data) && r.data.some(s => s.serverId === 'vps1'); }, 15000);
    const d1 = await call('vps2', 'POST', '/api/start', startBody(keys.vps3, 'vps5'));
    assert('Vào vps2 tạo luồng ở vps5 bằng key đang chạy ở vps3 → bị chặn', d1.status === 400 && /Stream Key/.test(d1.data?.error || ''), JSON.stringify(d1.data));
    const d2 = await call('vps4', 'POST', '/api/start', startBody(keys.vps3));
    assert('Vào vps4 tạo luồng tự chọn máy bằng key đang chạy ở vps3 → bị chặn', d2.status === 400, JSON.stringify(d2.data));
    assert('Key vps3 vẫn chỉ 1 bản sau 2 lần thử trùng', (await findByKey(keys.vps3, alive())).length === 1);

    const s5 = (await localStreams('vps5')).find(s => s.key === keys.vps5);
    const e1 = await call('vps2', 'POST', '/api/edit', { id: s5.id, serverId: 'vps5', key: keys.vps3, name: s5.name, file: s5.originalFile || s5.file, mode: s5.mode, minutes: 0, scheduledTime: s5.scheduledTime });
    assert('Vào vps2 sửa luồng vps5 sang key đang chạy ở vps3 → bị chặn', e1.status === 400, JSON.stringify(e1.data));
    const e2 = await call('vps2', 'POST', '/api/edit', { id: s5.id, serverId: 'vps5', key: keys.vps5, name: 'doi-ten-cheo' });
    const s5b = (await localStreams('vps5')).find(s => s.id === s5.id);
    assert('Vào vps2 đổi tên luồng vps5 (giữ key) → thành công', e2.status === 200 && s5b && s5b.name === 'doi-ten-cheo', `status=${e2.status} name=${s5b && s5b.name}`);

    const st = await call('vps3', 'POST', '/api/stop', { id: 987654, serverId: 'vps5' });
    assert('Vào vps3 dừng luồng không tồn tại ở vps5 → 404 (không báo ok giả)', st.status === 404 && !st.data?.ok, `status=${st.status} ${JSON.stringify(st.data)}`);
    const un = await call('vps3', 'POST', '/api/start', startBody('unk-aaaa-bbbb-cccc-dddd', 'vps9'));
    assert('Chỉ định máy không có trong cụm → lỗi', un.status === 400, JSON.stringify(un.data));

    // Máy đích chết: chỉ định rõ máy -> báo lỗi, KHÔNG âm thầm chạy chỗ khác
    await killNode('vps5');
    const dead = await call('vps2', 'POST', '/api/start', startBody('dead-aaaa-bbbb-cccc-dddd', 'vps5'));
    assert('Chỉ định máy đang chết → báo lỗi', dead.status >= 400, JSON.stringify(dead.data));
    assert('…và không tạo luồng ở máy khác', (await findByKey('dead-aaaa-bbbb-cccc-dddd', alive())).length === 0);
    const ds = await call('vps2', 'POST', '/api/stop', { id: s5.id, serverId: 'vps5' });
    assert('Dừng luồng trên máy đang chết → lỗi kết nối (502), không báo ok giả', ds.status === 502 && !ds.data?.ok, `status=${ds.status} ${JSON.stringify(ds.data)}`);
    startNode(node('vps5'), false);
    assert('vps5 sống lại', !!(await waitHealthy('vps5')));

    // Dọn luồng đã dừng từ 1 Worker -> dọn cả cụm
    const hadStopped = (await localStreams('vps3')).some(s => s.key === 'after1-aaaa-bbbb-cccc-dddd' && s.status === 'stopped');
    const cl = await call('vps4', 'POST', '/api/clear', {});
    const still = (await localStreams('vps3')).some(s => s.key === 'after1-aaaa-bbbb-cccc-dddd');
    assert('Vào vps4 bấm Dọn → xoá luồng đã dừng ở vps3', hadStopped && cl.status === 200 && !still, `had=${hadStopped} cleared=${cl.data && cl.data.cleared} still=${still}`);
    assert('Dọn không đụng luồng đang hoạt động', (await findByKey(keys.vps3, alive())).length === 1 && (await findByKey(keys.vps2, alive())).length === 1);

    // Bấm đồng thời cùng 1 key từ 2 máy khác nhau, đích khác nhau
    const rk = 'race-aaaa-bbbb-cccc-dddd';
    const rr = await Promise.all([
      call('vps2', 'POST', '/api/start', startBody(rk, 'vps3')),
      call('vps4', 'POST', '/api/start', startBody(rk, 'vps1')),
      call('vps5', 'POST', '/api/start', startBody(rk, 'vps2')),
      call('vps3', 'POST', '/api/start', startBody(rk)),
    ]);
    const nRace = (await findByKey(rk, alive())).length;
    console.log(`    Bấm đồng thời 4 máy: mã trả về ${rr.map(x => x.status).join(', ')}, số bản chạy = ${nRace}`);
    assert('Bấm đồng thời cùng key từ 4 máy → chỉ 1 bản chạy', nRace === 1, `n=${nRace}`);
    assert('Đúng 1 lệnh thành công, 3 lệnh bị từ chối', rr.filter(x => x.status === 200).length === 1, rr.map(x => x.status).join(','));
    // Sau khi dừng, tạo lại ngay cùng key phải được (không bị kẹt giữ chỗ)
    const winner = (await findByKey(rk, alive()))[0];
    if (winner) await call(winner.nodeId, 'POST', '/api/stop', { id: winner.stream.id, serverId: winner.nodeId });
    const again = await call('vps2', 'POST', '/api/start', startBody(rk, 'vps4'));
    assert('Dừng xong tạo lại ngay cùng key → được (không bị kẹt)', again.status === 200, JSON.stringify(again.data));
  }
}

(async () => {
  let code = 0;
  try { await run(); } catch (e) { console.error(R('Lỗi test:'), e); code = 1; }
  for (const id of Object.keys(procs)) { try { procs[id].kill(); } catch (_) {} }
  await sleep(500);
  if (failed > 0 && process.env.SHOW_LOGS) {
    for (const id of Object.keys(logs)) console.log(`\n--- log ${id} ---\n${logs[id].join('').split('\n').slice(-30).join('\n')}`);
  }
  console.log(`\n═══ Kết quả: ${passed} PASS  ${failed} FAIL ═══`);
  process.exit(failed > 0 || code ? 1 : 0);
})();
