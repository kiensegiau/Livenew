/**
 * test_cluster.js — Test cụm 3 VPS GIẢ chạy hoàn toàn trên localhost (3 tiến trình, 3 cổng).
 * Chạy: node test_cluster.js        (cần: npm install trước)
 *
 * An toàn: mỗi "VPS" chạy ở thư mục tạm riêng, bot_config.json giả (Telegram/Zalo/Sentinel TẮT),
 * cluster_nodes.json chỉ trỏ tới 127.0.0.1 → KHÔNG chạm VPS thật. Auth giữa các máy dùng
 * X-Cluster-Secret với STRICT_INTERNAL=1 (không dùng quyền admin theo User-Agent).
 *
 * Kịch bản: boot 3 node, auth, forward start/stop, 404 khi sai serverId,
 * Worker chết → luồng chuyển sang máy khác (+ dừng bản trùng khi sống lại),
 * Master chết → Worker tiếp quản (+ dừng bản trùng khi Master sống lại).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const WORK = path.join(os.tmpdir(), 'livenew_cluster_test');
const SECRET = 'cluster-test-secret';
const BASE_PORT = 3141;
const AFTER_SEC = 6;
const NODES = [
  { id: 'vps1', name: 'VPS 1 (Master)', ip: '127.0.0.1', port: BASE_PORT, isMaster: true },
  { id: 'vps2', name: 'VPS 2 (Worker)', ip: '127.0.0.1', port: BASE_PORT + 1, isMaster: false },
  { id: 'vps3', name: 'VPS 3 (Worker)', ip: '127.0.0.1', port: BASE_PORT + 2, isMaster: false },
];

const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;
let passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(name, cond, detail = '') {
  if (cond) { console.log(G('  ✓ PASS'), name); passed++; }
  else { console.log(R('  ✗ FAIL'), name, detail ? `→ ${detail}` : ''); failed++; }
}

const procs = {};
const logs = {};

function prepareDir(node) {
  const dir = path.join(WORK, node.id);
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

function startNode(node, fresh = true, extraEnv = {}) {
  const dir = fresh ? prepareDir(node) : path.join(WORK, node.id);
  const out = [];
  logs[node.id] = out;
  const p = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(node.port), NODE_ID: node.id, CLUSTER_SECRET: SECRET, STRICT_INTERNAL: '1', SKIP_FFMPEG_CLEANUP: '1', ...extraEnv,
      FAILOVER_AFTER_SEC: String(AFTER_SEC), FAILOVER_TICK_MS: '1000',
      FAILOVER_NET_CHECK_URL: `http://127.0.0.1:${node.port}/api/health`,
      NODE_PATH: path.join(ROOT, 'node_modules'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', d => out.push(d.toString()));
  p.stderr.on('data', d => out.push(d.toString()));
  procs[node.id] = p;
  return p;
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

const urlOf = n => `http://127.0.0.1:${n.port}`;
const node = id => NODES.find(n => n.id === id);

async function call(id, method, p, body, headers) {
  const h = { 'Content-Type': 'application/json', 'X-Cluster-Secret': SECRET, 'X-Cluster-Forwarded': '0', ...headers };
  if (headers && headers['X-Cluster-Secret'] === null) delete h['X-Cluster-Secret'];
  const r = await fetch(urlOf(node(id)) + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

// Danh sách luồng CỤC BỘ của 1 máy (Forwarded=1 + secret để không gom luồng máy khác)
async function localStreams(id) {
  try {
    const r = await call(id, 'GET', '/api/streams', null, { 'X-Cluster-Forwarded': '1' });
    return Array.isArray(r.data) ? r.data : [];
  } catch (_) { return []; }
}

async function waitFor(fn, timeoutMs, stepMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(stepMs); }
  return null;
}

async function waitHealthy(id) {
  return waitFor(async () => (await call(id, 'GET', '/api/health')).status === 200, 20000);
}

const ACTIVE = ['live', 'reconnecting', 'launching', 'scheduled', 'downloading'];
const soon = () => {
  const d = new Date(Date.now() + 3600 * 1000), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const startBody = (key, serverId) => ({
  key, file: 'http://127.0.0.1:9/video.mp4', mode: 'scheduled', minutes: 0,
  scheduledTime: soon(), name: `test-${key}`, ...(serverId ? { serverId } : {}),
});

// Tìm luồng theo key trên các máy đang sống, trả về [{nodeId, stream}]
async function findByKey(key, ids) {
  const found = [];
  for (const id of ids) {
    if (procs[id] && procs[id].exitCode === null) {
      for (const s of await localStreams(id)) if (s.key === key && ACTIVE.includes(s.status)) found.push({ nodeId: id, stream: s });
    }
  }
  return found;
}

// ── Unit test failover.js với cluster giả (chạy trong tiến trình, không cần server) ──
function makeFailover(opts) {
  const stateFile = path.join(WORK, `unit_state_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  Object.assign(process.env, {
    FAILOVER_STATE: stateFile, FAILOVER_AFTER_SEC: '1', FAILOVER_TICK_MS: '3600000', FAILOVER_RETRY_SEC: '1',
    FAILOVER_MAX_RETRY: String(opts.maxRetry || 10), FAILOVER_NET_CHECK_URL: opts.netUrl,
  });
  delete require.cache[require.resolve('./failover')];
  const nodes = [
    { id: 'vps1', name: 'VPS 1 (Master)', ip: '10.0.0.1', port: 3131, isMaster: true, isLocal: true },
    { id: 'vps2', name: 'VPS 2 (Worker)', ip: '10.0.0.2', port: 3131, isMaster: false, isLocal: false },
    { id: 'vps3', name: 'VPS 3 (Worker)', ip: '10.0.0.3', port: 3131, isMaster: false, isLocal: false },
  ];
  const st = { up: true, fwdFail: null, starts: 0, stops: [], notes: [], streams: opts.streams };
  const cm = {
    getNodes: () => nodes, getNode: id => nodes.find(n => n.id === id),
    callNodeApi: async (n, p) => {
      if (n.id !== 'vps2') return { statusCode: 200, data: [] };
      if (!st.up) throw new Error('down');
      return { statusCode: 200, data: p === '/api/health' ? { ok: true } : st.streams };
    },
    selectOptimalNode: async () => ({ nodeId: 'vps3', reason: 'unit' }),
    forwardStreamAction: async (id, action, body) => {
      if (action === 'stop') { st.stops.push(body.id); return { ok: true }; }
      st.starts++;
      return st.fwdFail ? { error: st.fwdFail } : { id: 100 + st.starts };
    },
  };
  const f = require('./failover').init({
    clusterManager: cm, userManager: { listUsers: () => [] }, startStream: () => ({ error: 'x' }),
    extractDriveId: () => null, getLocalSysinfo: () => null, localNodeId: () => 'vps1', notify: m => st.notes.push(m),
  });
  return { f, st };
}

async function runUnit() {
  const KEYS = ['FAILOVER_STATE', 'FAILOVER_AFTER_SEC', 'FAILOVER_TICK_MS', 'FAILOVER_RETRY_SEC', 'FAILOVER_MAX_RETRY', 'FAILOVER_NET_CHECK_URL'];
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  try { await runUnitInner(); } finally { KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }
}

async function runUnitInner() {
  console.log(Y('\n[ 0 ] Unit test failover.js (cluster giả trong tiến trình)'));
  const S = (id, file) => ({ id, key: `unit-key-${id}-abcd`, originalFile: file, mode: 'loop', minutes: 0, status: 'live', name: `S_${id}` });

  {
    const { f, st } = makeFailover({ netUrl: '', streams: [S(7, 'http://x/v.mp4'), S(8, 'C:/local/file.mp4')] });
    await f.tick();                              // chụp snapshot khi vps2 còn sống
    st.up = false; st.fwdFail = 'Lỗi kết nối tới VPS 3';
    await f.tick(); await sleep(1200); await f.tick();   // qua ngưỡng -> chuyển, thất bại tạm thời
    const first = st.notes.join('\n');
    assert('Luồng chuyển thất bại tạm thời được xếp hàng thử lại', /sẽ tự thử lại/.test(first) && f.getState().pendingRetry.vps2?.length === 1, JSON.stringify(f.getState().pendingRetry));
    assert('Luồng dùng file cục bộ bị báo không thể chuyển (không thử lại)', /file cục bộ/.test(first) && !f.getState().pendingRetry.vps2?.some(x => x.id === 8));
    st.fwdFail = null; await sleep(1100);
    await f.tick();                              // retryPending thành công
    assert('Thử lại thành công khi máy đích khỏi lỗi + có tin nhắn THỬ LẠI', /THỬ LẠI/.test(st.notes.join('\n')) && !f.getState().pendingRetry.vps2, st.notes.join('\n').slice(-300));
    assert('Không chuyển trùng (chỉ 1 lần start thành công sau thất bại)', st.starts === 2, `starts=${st.starts}`);
    st.up = true; st.streams = [S(7, 'http://x/v.mp4')];
    await f.tick();                              // máy sự cố sống lại -> dừng bản cũ
    assert('Máy sống lại: dừng đúng bản cũ #7', st.stops.length === 1 && st.stops[0] === 7, JSON.stringify(st.stops));
  }

  {
    const { f, st } = makeFailover({ netUrl: 'http://127.0.0.1:9/never', streams: [S(7, 'http://x/v.mp4')] });
    assert('selfOnline() = false khi máy mất mạng ra ngoài', (await f.selfOnline()) === false);
    await f.tick();
    st.up = false;
    await f.tick(); await sleep(1200); await f.tick(); await f.tick();
    assert('Máy tự mất mạng: KHÔNG chuyển luồng (tránh chạy trùng key)', st.starts === 0 && st.notes.length === 0, `starts=${st.starts} notes=${st.notes.length}`);
  }

  {
    const { f, st } = makeFailover({ netUrl: '', maxRetry: 2, streams: [S(7, 'http://x/v.mp4')] });
    await f.tick();
    st.up = false; st.fwdFail = 'Lỗi kết nối';
    await f.tick(); await sleep(1200); await f.tick();
    await sleep(1100); await f.tick();
    assert('Thử lại quá giới hạn thì báo từ bỏ', /dừng thử/.test(st.notes.join('\n')) && !f.getState().pendingRetry.vps2, st.notes.join('\n').slice(-200));
  }

  {
    // Quorum tiếp quản Master: local = vps2 (Worker id nhỏ nhất), vps3 là Worker còn sống
    for (const peerSeesDown of [true, false]) {
      process.env.FAILOVER_STATE = path.join(WORK, `unit_q_${Date.now()}_${peerSeesDown}.json`);
      Object.assign(process.env, { FAILOVER_AFTER_SEC: '1', FAILOVER_TICK_MS: '3600000', FAILOVER_NET_CHECK_URL: '' });
      delete require.cache[require.resolve('./failover')];
      const nodes = [
        { id: 'vps1', name: 'VPS 1 (Master)', ip: '10.0.0.1', port: 3131, isMaster: true, isLocal: false },
        { id: 'vps2', name: 'VPS 2 (Worker)', ip: '10.0.0.2', port: 3131, isMaster: false, isLocal: true },
        { id: 'vps3', name: 'VPS 3 (Worker)', ip: '10.0.0.3', port: 3131, isMaster: false, isLocal: false },
      ];
      const qs = { masterUp: true, starts: 0, notes: [] };
      const qcm = {
        getNodes: () => nodes, getNode: id => nodes.find(n => n.id === id),
        callNodeApi: async (n, p) => {
          if (n.id === 'vps1') { if (!qs.masterUp) throw new Error('down'); return { statusCode: 200, data: p === '/api/health' ? { ok: true } : [S(1, 'http://x/v.mp4')] }; }
          if (p === '/api/cluster/failover') return { statusCode: 200, data: { down: peerSeesDown ? { vps1: 5 } : {} } };
          return { statusCode: 200, data: { ok: true } };
        },
        selectOptimalNode: async () => ({ nodeId: 'vps3', reason: 'unit' }),
        forwardStreamAction: async (id, action) => { if (action === 'start') qs.starts++; return { id: 100 + qs.starts }; },
      };
      const qf = require('./failover').init({
        clusterManager: qcm, userManager: { listUsers: () => [] }, startStream: () => ({ error: 'x' }),
        extractDriveId: () => null, getLocalSysinfo: () => null, localNodeId: () => 'vps2', notify: m => qs.notes.push(m),
      });
      await qf.tick();                       // snapshot khi Master còn sống
      qs.masterUp = false;
      await qf.tick(); await sleep(1200); await qf.tick();
      if (peerSeesDown) assert('Quorum: Worker khác cũng thấy Master chết → tiếp quản', qs.starts === 1, `starts=${qs.starts}`);
      else assert('Quorum: Worker khác vẫn thấy Master sống → KHÔNG tiếp quản (split-brain)', qs.starts === 0, `starts=${qs.starts}`);
    }
    {
      const src = require('fs').readFileSync(path.join(ROOT, 'telegramBot.js'), 'utf8');
      assert('Sentinel: có tên máy/vai trò, thời gian, ghi chú failover', /peerName/.test(src) && /tự chuyển luồng/.test(src));
    }
    {
      const sn = require('./sheetNodes');
      const csv = 'id,Tên,IP,Port,Vai trò,Trạng thái\r\nvps1,"VPS 1, chính",1.1.1.1,3131,Master,Active\r\nvps2,VPS 2,2.2.2.2,3131,Worker,Active\r\nvps3,VPS 3,3.3.3.3,,Worker,Inactive\r\nBAD ID,x,4.4.4.4,3131,Worker,Active\r\nvps5,VPS 5,5.5.5.5,4000,worker,active\r\n';
      const p = sn.parseNodesCsv(csv);
      assert('Sheet: đọc đúng 3 máy Active (bỏ Inactive + dòng sai id)', p.rows.map(r => r.id).join() === 'vps1,vps2,vps5', p.rows.map(r => r.id).join());
      assert('Sheet: tên có dấu phẩy trong ngoặc kép, port tuỳ chọn', p.rows[0].name === 'VPS 1, chính' && p.rows[2].port === 4000 && p.rows[0].isMaster);
      assert('Sheet: cảnh báo dòng sai id', p.warnings.some(w => /BAD ID|bad id/i.test(w)), JSON.stringify(p.warnings));
      const cur = [{ id: 'vps1', name: 'VPS 1, chính', ip: '1.1.1.1', port: 3131, isMaster: true }, { id: 'vps2', name: 'VPS 2', ip: '2.2.2.2', port: 3131, isMaster: false }];
      const a = sn.computePlan(p.rows, cur, 'vps2');
      assert('Plan: thêm vps5', a.next && a.next.some(n => n.id === 'vps5'));
      assert('Plan: không đổi gì → unchanged', sn.computePlan(p.rows.filter(r => r.id !== 'vps5'), cur, 'vps2').unchanged === true);
      assert('Plan: sheet rỗng → lỗi, không xóa', !!sn.computePlan([], cur, 'vps2').error);
      assert('Plan: 2 Master → lỗi', !!sn.computePlan([{ id: 'a1', name: 'a', ip: '1.1.1.1', port: 1, isMaster: true }, { id: 'a2', name: 'b', ip: '2.2.2.2', port: 1, isMaster: true }], cur, 'vps2').error);
      const swap = sn.computePlan([{ id: 'vps1', name: 'x', ip: '1.1.1.1', port: 3131, isMaster: false }, { id: 'vps2', name: 'VPS 2', ip: '2.2.2.2', port: 3131, isMaster: true }], cur, 'vps2');
      assert('Plan: sheet đổi Master → bị chặn, giữ Master cũ', swap.next ? swap.next.find(n => n.isMaster).id === 'vps1' : true, JSON.stringify(swap));
      assert('Plan: lần đầu (trustMaster) tin sheet cả Master', sn.computePlan([{ id: 'vps1', name: 'x', ip: '1.1.1.1', port: 3131, isMaster: false }, { id: 'vps2', name: 'VPS 2', ip: '2.2.2.2', port: 3131, isMaster: true }], cur, 'vps2', { trustMaster: true }).next.find(n => n.isMaster).id === 'vps2');
      const drop = sn.computePlan([{ id: 'vps1', name: 'VPS 1, chính', ip: '1.1.1.1', port: 3131, isMaster: true }], cur, 'vps2');
      assert('Plan: không gỡ chính máy đang chạy dù thiếu trong sheet', (drop.next ? drop.next.some(n => n.id === 'vps2') : drop.unchanged === true) && (drop.warnings || []).some(w => /vps2/.test(w)), JSON.stringify(drop));
      assert('Sheet: link docs có gid được đổi sang link CSV đúng tab', sn.toFetchUrl('https://docs.google.com/spreadsheets/d/ABC_def-1/edit#gid=777') === 'https://docs.google.com/spreadsheets/d/ABC_def-1/export?format=csv&gid=777');
    }
    const { formatClusterReport } = require('./telegramBot');
    const tel = { cpuUsage: 12, ramUsage: 30, ramUsed: '1.2 GB', ramTotal: '4.0 GB', diskUsage: 45, diskUsed: '20 GB', diskTotal: '50 GB', netSpeedRx: '1.0 Mbps', netSpeedTx: '5.0 Mbps', vpsUptime: '2 ngày 3 giờ' };
    const mk = (id, n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Luồng_${id}*${i}`, status: i % 3 ? 'live' : 'scheduled', lastLog: 'time=00:01:02.00 bitrate= 2500.0kbits/s speed=1.0x', serverId: id, serverName: id, isRemote: id !== 'vps1' }));
    const ov = {
      localNodeId: 'vps1',
      nodes: [
        { id: 'vps2', name: 'VPS 2 (Phụ - Worker)', isMaster: false, isLocal: false, status: 'offline', lastSeen: Date.now() - 120000, telemetry: null },
        { id: 'vps1', name: 'VPS 1 (Chính - Master)', isMaster: true, isLocal: true, status: 'online', telemetry: tel },
        { id: 'vps3', name: 'VPS 3 (Phụ - Worker)', isMaster: false, isLocal: false, status: 'online', telemetry: { ...tel, capacityFull: 'RAM 95%' } },
      ],
      streams: mk('vps1', 30).concat(mk('vps3', 30)),
    };
    const parts = formatClusterReport(ov);
    const text = parts.join('\n');
    assert('Report: liệt kê đủ 3 VPS, Master lên đầu, ghi "Báo cáo từ"', /VPS 1[^\n]*Master/.test(text) && /VPS 2/.test(text) && /VPS 3/.test(text) && text.indexOf('VPS 1') < text.indexOf('VPS 2') && /Báo cáo từ: \*VPS 1/.test(text));
    assert('Report: tổng 2/3 máy online + tổng luồng', /Cụm: \*2\/3\* máy online/.test(text) && /Luồng: \*\d+\/60\*/.test(text), text.slice(0, 300));
    assert('Report: VPS offline hiển thị mất kết nối + failover', /🔴 \*VPS 2[^\n]*OFFLINE/.test(text) && /Mất kết nối/.test(text));
    assert('Report: hiển CPU/RAM/Disk/mạng/uptime mỗi máy online', /CPU `12%`/.test(text) && /RAM `1\.2 GB\/4\.0 GB \(30%\)`/.test(text) && /Disk `20 GB\/50 GB \(45%\)`/.test(text) && /Uptime/.test(text));
    assert('Report: cảnh báo máy đầy tài nguyên', /Đầy tài nguyên: RAM 95%/.test(text));
    assert('Report: escape Markdown tên luồng (_ *)', /Luồng\\_vps1\\\*0/.test(text), text.slice(0, 600));
    assert('Report: giới hạn luồng/máy + tách tin < 4096 ký tự', /và 18 luồng khác/.test(text) && parts.every(p => p.length < 4096), parts.map(p => p.length).join(','));
  }
}

async function run() {
  fs.mkdirSync(WORK, { recursive: true });
  await runUnit();
  console.log(Y('\n[ 0b ] Dọn dẹp khẩn cấp: xóa file mồ côi, KHÔNG đụng file đang dùng'));
  {
    const solo = { ...node('vps1'), port: BASE_PORT + 8 };
    const dir = prepareDir(solo);
    const dl = path.join(dir, 'downloads');
    const old = Date.now() - 20 * 60 * 1000;
    const mk = (name, ageMs) => { const f = path.join(dl, name); fs.writeFileSync(f, 'x'.repeat(1024)); const t = new Date(Date.now() - ageMs); fs.utimesSync(f, t, t); return f; };
    const orphanOld = mk('orphan_old.mp4', 20 * 60 * 1000);
    const orphanNew = mk('orphan_new.mp4', 30 * 1000);
    const activeFile = mk('active_in_use.mp4', 20 * 60 * 1000);
    fs.mkdirSync(path.join(dl, 'temp_chunks_old'), { recursive: true });
    startNode(solo, false, { DISK_CLEAN_PCT: '1', RESOURCE_MONITOR_MS: '1500', FAILOVER_AFTER_SEC: '3600' });
    const ok = await waitFor(async () => (await fetch(urlOf(solo) + '/api/health')).status === 200, 20000);
    assert('Node thử dọn dẹp khởi động', !!ok);
    const body = { key: 'clean-aaaa-bbbb-cccc-dddd', file: activeFile, mode: 'scheduled', minutes: 0, scheduledTime: soon(), name: 'clean-active' };
    const r = await fetch(urlOf(solo) + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cluster-Secret': SECRET }, body: JSON.stringify(body) });
    const rj = await r.json().catch(() => ({}));
    assert('Tạo luồng dùng file trong downloads/', r.status === 200 && !rj.error, JSON.stringify(rj));
    const gone = await waitFor(async () => !fs.existsSync(orphanOld), 15000);
    assert('Dọn khẩn cấp xóa file mồ côi cũ (>5 phút)', !!gone);
    assert('Giữ file mồ côi mới (<5 phút)', fs.existsSync(orphanNew));
    assert('Giữ file đang được luồng sử dụng', fs.existsSync(activeFile));
    await sleep(3500);
    assert('File đang dùng vẫn còn sau nhiều vòng dọn', fs.existsSync(activeFile));
    const stopR = await fetch(urlOf(solo) + '/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cluster-Secret': SECRET }, body: JSON.stringify({ id: rj.id }) });
    assert('Dừng luồng thành công', stopR.status === 200, `status=${stopR.status}`);
    const gone2 = await waitFor(async () => !fs.existsSync(activeFile), 8000);
    assert('Live dừng xong → file tạm được dọn ngay', !!gone2);
    const rs = await fetch(urlOf(solo) + '/api/restart', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cluster-Secret': SECRET }, body: JSON.stringify({ id: rj.id }) });
    const rsj = await rs.json().catch(() => ({}));
    assert('Bật lại luồng đã dọn file → báo lỗi rõ ràng (không chạy với file mất)', /dọn/.test(JSON.stringify(rsj)), `status=${rs.status} ${JSON.stringify(rsj)}`);
    await killNode('vps1');
  }

  console.log(Y('\n[ 0d ] Chỉ có 1 VPS duy nhất làm Master (cluster_nodes.json chỉ 1 máy)'));
  {
    const solo = { id: 'vps1', name: 'VPS 1 (Master)', ip: '127.0.0.1', port: BASE_PORT + 9, isMaster: true };
    const dir = prepareDir(solo);
    fs.writeFileSync(path.join(dir, 'cluster_nodes.json'), JSON.stringify([{ id: 'vps1', name: 'VPS 1 (Master)', ip: '127.0.0.1', port: solo.port, isMaster: true, isLocal: true }]));
    startNode(solo, false, { FAILOVER_AFTER_SEC: '3' });
    assert('1 VPS: khởi động', !!(await waitFor(async () => (await fetch(urlOf(solo) + '/api/health')).status === 200, 20000)));
    const H = { 'Content-Type': 'application/json', 'X-Cluster-Secret': SECRET };
    const r = await fetch(urlOf(solo) + '/api/start', { method: 'POST', headers: H, body: JSON.stringify(startBody('solo-aaaa-bbbb-cccc-dddd')) });
    const rj = await r.json().catch(() => ({}));
    assert('1 VPS: tạo luồng chạy ngay trên máy này (không chuyển đi đâu)', r.status === 200 && !rj.error && rj.id !== undefined, JSON.stringify(rj));
    const list = await fetch(urlOf(solo) + '/api/streams', { headers: H }).then(x => x.json()).catch(() => []);
    assert('1 VPS: luồng nằm trong danh sách, serverId = vps1', Array.isArray(list) && list.some(s => s.key === 'solo-aaaa-bbbb-cccc-dddd' && (!s.serverId || s.serverId === 'vps1')), JSON.stringify(list).slice(0, 200));
    const rep = await fetch(urlOf(solo) + '/api/cluster/report', { headers: H }).then(x => x.json()).catch(() => ({}));
    assert('1 VPS: báo cáo cụm 1/1 máy online', rep.overview && rep.overview.nodes && rep.overview.nodes.length === 1, JSON.stringify(rep).slice(0, 200));
    await sleep(6000);
    const log = (logs.vps1 || []).join('');
    assert('1 VPS: không có lỗi failover/không gọi máy khác', !/Failover\] 🚨/.test(log), log.slice(-300));
    const stop = await fetch(urlOf(solo) + '/api/stop', { method: 'POST', headers: H, body: JSON.stringify({ id: rj.id }) });
    assert('1 VPS: dừng luồng thành công', stop.status === 200);
    await killNode('vps1');
  }

  console.log(Y('\n[ 0c ] Danh sách VPS từ Google Sheet (sheet giả chạy trên localhost)'));
  {
    const httpm = require('http');
    let csv = '', code = 200;
    const sheet = httpm.createServer((req, res) => { res.writeHead(code, { 'Content-Type': 'text/csv; charset=utf-8' }); res.end(csv); });
    await new Promise(r => sheet.listen(BASE_PORT + 20, '127.0.0.1', r));
    const hdr = 'id,Tên,IP,Port,Vai trò,Trạng thái\r\n';
    const row = (id, port, role, st = 'Active') => `${id},${id.toUpperCase()},127.0.0.1,${port},${role},${st}\r\n`;
    csv = hdr + row('vps1', BASE_PORT, 'Master') + row('vps2', BASE_PORT + 1, 'Worker') + row('vps4', BASE_PORT + 3, 'Worker');
    const n4 = { id: 'vps4', name: 'VPS 4', ip: '127.0.0.1', port: BASE_PORT + 3, isMaster: false };
    startNode(n4, true, { NODES_SHEET_URL: `http://127.0.0.1:${BASE_PORT + 20}/nodes.csv`, NODES_SYNC_SEC: '5', SHEET_NODES_MARKER: path.join(WORK, 'vps4', '.marker') });
    assert('Node dùng sheet khởi động', !!(await waitFor(async () => (await fetch(urlOf(n4) + '/api/health')).status === 200, 20000)));
    const list4 = async () => { const r = await fetch(urlOf(n4) + '/api/cluster/nodes', { headers: { 'X-Cluster-Secret': SECRET } }); const d = await r.json().catch(() => null); return Array.isArray(d) ? d : []; };
    const ids = async () => (await list4()).map(x => x.id).sort().join();
    const first = await waitFor(async () => (await ids()) === 'vps1,vps2,vps4' ? true : null, 20000);
    assert('Danh sách mặc định (vps1,vps2,vps3) được thay bằng danh sách trong sheet', !!first, await ids());
    assert('vps4 tự nhận ra mình (isLocal) từ NODE_ID/sheet', !!(await list4()).find(x => x.id === 'vps4' && x.isLocal));
    // Thêm 1 dòng vps5 + tắt vps2 (Inactive)
    csv = hdr + row('vps1', BASE_PORT, 'Master') + row('vps2', BASE_PORT + 1, 'Worker', 'Inactive') + row('vps4', BASE_PORT + 3, 'Worker') + row('vps5', 3150, 'Worker');
    const upd = await waitFor(async () => (await ids()) === 'vps1,vps4,vps5' ? true : null, 20000);
    assert('Thêm dòng vps5 + Inactive vps2 → cụm cập nhật tự động', !!upd, await ids());
    // Sheet lỗi (HTTP 500) → giữ nguyên
    code = 500; await sleep(7000);
    assert('Sheet lỗi → giữ nguyên danh sách, không xóa máy nào', (await ids()) === 'vps1,vps4,vps5', await ids());
    code = 200;
    // Sheet rỗng → giữ nguyên
    csv = hdr; await sleep(7000);
    assert('Sheet rỗng → giữ nguyên danh sách', (await ids()) === 'vps1,vps4,vps5', await ids());
    // Đổi Master trong sheet → bị chặn
    csv = hdr + row('vps1', BASE_PORT, 'Worker') + row('vps4', BASE_PORT + 3, 'Master') + row('vps5', 3150, 'Worker');
    await sleep(7000);
    const mm = (await list4()).find(x => x.isMaster);
    assert('Sheet đổi Master → bị chặn, Master vẫn là vps1', mm && mm.id === 'vps1', JSON.stringify(mm));
    const st = await fetch(urlOf(n4) + '/api/cluster/sheet-nodes', { headers: { 'X-Cluster-Secret': SECRET } }).then(r => r.json()).catch(() => ({}));
    assert('Endpoint /api/cluster/sheet-nodes báo trạng thái + cảnh báo đổi Master', st.enabled === true && (st.warnings || []).some(w => /Master/.test(w)), JSON.stringify(st));
    await killNode('vps4');
    await new Promise(r => sheet.close(r));
  }


  fs.mkdirSync(WORK, { recursive: true });

  console.log(Y('\n═══ TEST CỤM 3 VPS GIẢ (localhost) ═══'));
  console.log(Y('\n[ 1 ] Khởi động 3 node & nhận diện vai trò'));
  NODES.forEach(n => startNode(n));
  for (const n of NODES) {
    const ok = await waitHealthy(n.id);
    assert(`${n.id} health OK (cổng ${n.port})`, !!ok);
    if (ok) {
      const h = await call(n.id, 'GET', '/api/health');
      assert(`${n.id} nhận đúng node id`, h.data && h.data.node === n.id, JSON.stringify(h.data));
    }
  }

  console.log(Y('\n[ 2 ] Xác thực: STRICT_INTERNAL tắt quyền admin theo User-Agent'));
  {
    const ua = await call('vps1', 'GET', '/api/streams', null, { 'User-Agent': 'CyberShieldSecureAgent/1.0', 'X-Cluster-Secret': null });
    assert('Chỉ có User-Agent → 401', ua.status === 401, `status=${ua.status}`);
    const bad = await call('vps1', 'GET', '/api/streams', null, { 'X-Cluster-Secret': 'wrong' });
    assert('Secret sai → 401', bad.status === 401, `status=${bad.status}`);
    const ok = await call('vps1', 'GET', '/api/streams');
    assert('Secret đúng → 200', ok.status === 200, `status=${ok.status}`);
  }

  console.log(Y('\n[ 2b ] VPS mới tự đăng ký vào cụm (MASTER_URL, không thêm tay)'));
  {
    const n4 = { id: 'vps4', name: 'VPS 4', ip: '127.0.0.1', port: BASE_PORT + 3, isMaster: false };
    startNode(n4, true, { MASTER_URL: urlOf(node('vps1')), NODE_IP: '127.0.0.1', NODE_NAME: 'VPS 4 (Worker)' });
    assert('vps4 khởi động', !!(await waitFor(async () => (await fetch(urlOf(n4) + '/api/health')).status === 200, 20000)));
    const hasOn = async (id, nid) => { const r = await call(id, 'GET', '/api/cluster/nodes'); return Array.isArray(r.data) && r.data.some(x => x.id === nid); };
    assert('Master (vps1) có vps4 trong cụm sau khi tự đăng ký', !!(await waitFor(() => hasOn('vps1', 'vps4'), 15000)));
    assert('Worker cũ (vps2) cũng nhận được vps4', !!(await waitFor(() => hasOn('vps2', 'vps4'), 15000)));
    const mine = await waitFor(async () => {
      const r = await fetch(urlOf(n4) + '/api/cluster/nodes', { headers: { 'X-Cluster-Secret': SECRET } });
      const d = await r.json().catch(() => null);
      return Array.isArray(d) && d.length === 4 && d.find(x => x.id === 'vps4' && x.isLocal) ? d : null;
    }, 15000);
    assert('vps4 nhận đủ danh sách 4 máy và tự nhận ra mình', !!mine);
    await killNode('vps4');
    const rm = await call('vps1', 'POST', '/api/cluster/nodes/remove', { id: 'vps4' });
    assert('Gỡ vps4 khỏi cụm (dọn để các phần sau chạy với 3 máy)', rm.status === 200 && !(await hasOn('vps1', 'vps4')), JSON.stringify(rm.data));
    await waitFor(async () => !(await hasOn('vps2', 'vps4')) && !(await hasOn('vps3', 'vps4')), 10000);
  }

  console.log(Y('\n[ 3 ] Chuyển tiếp start/stop giữa các máy'));
  {
    const key = 'fwd1-aaaa-bbbb-cccc-dddd';
    const r = await call('vps1', 'POST', '/api/start', startBody(key, 'vps2'));
    assert('Master start luồng chỉ định vps2', !r.data?.error && r.data?.id !== undefined, JSON.stringify(r.data));
    const on2 = await findByKey(key, ['vps2']);
    const on1 = await findByKey(key, ['vps1']);
    assert('Luồng nằm trên vps2', on2.length === 1);
    assert('Luồng KHÔNG nằm trên vps1', on1.length === 0);

    const wrong = await call('vps1', 'POST', '/api/stop', { id: r.data.id });
    assert('Stop sai serverId → 404 (không báo ok giả)', wrong.status === 404, `status=${wrong.status} ${JSON.stringify(wrong.data)}`);

    const stop = await call('vps1', 'POST', '/api/stop', { id: r.data.id, serverId: 'vps2' });
    assert('Stop đúng serverId (qua Master) → ok', stop.data?.ok === true, JSON.stringify(stop.data));
    const after = (await localStreams('vps2')).find(s => s.id === r.data.id);
    assert('Luồng trên vps2 chuyển sang stopped', after && after.status === 'stopped', `status=${after && after.status}`);

    const rs = await call('vps1', 'POST', '/api/restart', { id: 999999, serverId: 'vps1' });
    assert('Restart luồng không tồn tại → lỗi', !!rs.data?.error, JSON.stringify(rs.data));
  }

  console.log(Y('\n[ 4 ] Cân bằng tải: nhiều luồng không chỉ định máy'));
  {
    const placed = {};
    for (let i = 0; i < 6; i++) {
      const r = await call('vps1', 'POST', '/api/start', startBody(`lb0${i}-aaaa-bbbb-cccc-dddd`));
      if (r.data?.error) console.log('    ', r.data.error);
      const sid = r.data?.serverId || (r.data?.autoBalanced ? r.data.serverName : 'vps1');
      placed[sid] = (placed[sid] || 0) + 1;
    }
    console.log('    Phân bổ:', JSON.stringify(placed));
    const total = (await Promise.all(['vps1', 'vps2', 'vps3'].map(localStreams))).flat()
      .filter(s => /^lb0/.test(s.key || '') && ACTIVE.includes(s.status)).length;
    assert('Cả 6 luồng được nhận (không mất luồng)', total === 6, `total=${total}`);
  }

  console.log(Y('\n[ 4b ] Báo cáo TỔNG QUÁT cả cụm (tin Telegram/Zalo) — 3 VPS online'));
  {
    const rep = async (id) => { const r = await call(id, 'GET', '/api/cluster/report'); return { status: r.status, parts: (r.data && r.data.messages) || [], ov: r.data && r.data.overview }; };
    const a = await waitFor(async () => { const r = await rep('vps1'); return /Cụm: \*3\/3\*/.test(r.parts.join('\n')) ? r : null; }, 25000);
    assert('/api/cluster/report trả về báo cáo, 3/3 máy online', !!a, JSON.stringify((await rep('vps1')).parts).slice(0, 400));
    if (a) {
      const text = a.parts.join('\n');
      assert('Báo cáo liệt kê cả 3 VPS kèm CPU/RAM/Disk', /VPS 1/.test(text) && /VPS 2/.test(text) && /VPS 3/.test(text) && (text.match(/CPU `/g) || []).length === 3 && /RAM `/.test(text) && /Disk `/.test(text), text.slice(0, 500));
      assert('Báo cáo có luồng của MÁY KHÁC (giống web gom toàn cụm)', (a.ov.streams || []).some(s => s.isRemote) && /test-lb0/.test(text), `remote=${(a.ov.streams || []).filter(s => s.isRemote).length}`);
      const nLb = (a.ov.streams || []).filter(s => /^test-lb0/.test(s.name)).length;
      assert('Báo cáo: gộp đúng 6 luồng cân bằng tải từ cả 3 máy', nLb === 6, `n=${nLb}`);
      assert('Tiêu đề + thời gian + "Báo cáo từ" Master', /BÁO CÁO CỤM VPS/.test(text) && /Thời gian:/.test(text) && /Báo cáo từ: \*VPS 1/.test(text));
      assert('Mỗi tin < 4096 ký tự (giới hạn Telegram)', a.parts.every(p => p.length < 4096));
    }
    const w = await rep('vps2');
    assert('Xem từ Worker (vps2) cũng thấy đủ cụm, "Báo cáo từ: VPS 2"', /Báo cáo từ: \*VPS 2/.test(w.parts.join('\n')) && /VPS 1/.test(w.parts.join('\n')) && /VPS 3/.test(w.parts.join('\n')), w.parts.join('\n').slice(0, 300));
    const noAuth = await call('vps1', 'GET', '/api/cluster/report', null, { 'X-Cluster-Secret': null });
    assert('Không đăng nhập → 401 (không lộ báo cáo)', noAuth.status === 401, `status=${noAuth.status}`);
  }

  console.log(Y('\n[ 5 ] Worker (vps2) chết → luồng tự chuyển sang máy còn sống'));
  {
    const key = 'wkr1-aaaa-bbbb-cccc-dddd';
    const r = await call('vps1', 'POST', '/api/start', startBody(key, 'vps2'));
    assert('Tạo luồng trên vps2', !r.data?.error, JSON.stringify(r.data));
    await sleep(3500); // chờ Master chụp snapshot
    await killNode('vps2');
    console.log(`    → vps2 đã bị tắt, chờ ~${AFTER_SEC + 6}s để failover...`);
    const moved = await waitFor(async () => {
      const f = await findByKey(key, ['vps1', 'vps3']);
      return f.length ? f : null;
    }, (AFTER_SEC + 15) * 1000);
    assert('Luồng được chuyển sang máy còn sống', !!moved, 'không thấy luồng ở vps1/vps3');
    if (moved) assert('Luồng chỉ chạy trên đúng 1 máy (không trùng key)', moved.length === 1, `n=${moved.length}`);

    console.log('    → bật lại vps2 (giữ dữ liệu cũ)...');
    startNode(node('vps2'), false);
    assert('vps2 sống lại', !!(await waitHealthy('vps2')));
    const cleaned = await waitFor(async () => {
      const s = (await localStreams('vps2')).find(x => x.key === key);
      return s && !ACTIVE.includes(s.status) ? s : null;
    }, 15000);
    assert('Bản cũ trên vps2 bị dừng (tránh trùng Stream Key)', !!cleaned);
    const all = Object.values(logs).map(l => l.join('')).join('\n');
    assert('Tin nhắn: tiêu đề WORKER mất kết nối + tên máy sự cố/máy xử lý', /WORKER VPS 2 \\\(Worker\)|WORKER VPS 2 \(Worker\)/.test(all) && /Máy xử lý: \*VPS 1/.test(all));
    assert('Tin nhắn: có thời gian, thời gian mất kết nối, key, luồng mới', /Thời gian:/.test(all) && /Mất kết nối: \*\d+s\*/.test(all) && /key …/.test(all) && /luồng mới #\d+/.test(all));
    const gotRevive = await waitFor(async () => { const t = Object.values(logs).map(l => l.join('')).join('\n'); return /HOẠT ĐỘNG LẠI/.test(t) && /Đã tự dừng bản cũ/.test(t); }, 10000);
    assert('Tin nhắn: thông báo VPS 2 hoạt động lại + đã dừng bản cũ', !!gotRevive);
  }

  console.log(Y('\n[ 6 ] Master (vps1) chết → Worker tiếp quản'));
  {
    const key = 'mst1-aaaa-bbbb-cccc-dddd';
    const r = await call('vps1', 'POST', '/api/start', startBody(key, 'vps1'));
    assert('Tạo luồng trên vps1 (Master)', !r.data?.error, JSON.stringify(r.data));
    await sleep(3500); // chờ Worker chụp snapshot của Master
    await killNode('vps1');
    console.log(`    → vps1 đã bị tắt, chờ ~${AFTER_SEC + 6}s để Worker tiếp quản...`);
    const moved = await waitFor(async () => {
      const f = await findByKey(key, ['vps2', 'vps3']);
      return f.length ? f : null;
    }, (AFTER_SEC + 15) * 1000);
    assert('Luồng của Master được chuyển sang Worker', !!moved, 'không thấy luồng ở vps2/vps3');
    if (moved) {
      assert('Không bị chạy trùng giữa 2 Worker', moved.length === 1, `n=${moved.length}`);
      console.log(`    → luồng được cân bằng tải tới ${moved[0].nodeId} (vps2 là Worker id nhỏ nhất → máy điều phối)`);
      const took = id => /WORKER TIẾP QUẢN/.test((logs[id] || []).join(''));
      assert('Chỉ vps2 (id nhỏ nhất) tiếp quản, vps3 không tự chuyển trùng', took('vps2') && !took('vps3'), `vps2=${took('vps2')} vps3=${took('vps3')}`);
    }

    console.log('    → bật lại vps1 (giữ dữ liệu cũ)...');
    startNode(node('vps1'), false);
    assert('vps1 sống lại', !!(await waitHealthy('vps1')));
    const cleaned = await waitFor(async () => {
      const s = (await localStreams('vps1')).find(x => x.key === key);
      return s && !ACTIVE.includes(s.status) ? s : null;
    }, 15000);
    assert('Bản cũ trên vps1 bị dừng (tránh trùng Stream Key)', !!cleaned);
    const all2 = Object.values(logs).map(l => l.join('')).join('\n');
    assert('Tin nhắn: tiêu đề MASTER mất kết nối — WORKER tiếp quản', /MASTER VPS 1 .*WORKER TIẾP QUẢN/.test(all2));
    assert('Tin nhắn: ghi rõ Master/Worker và máy xử lý là VPS 2', /Máy xử lý: \*VPS 2[^\n]*Worker/.test(all2) && /Máy sự cố: \*VPS 1[^\n]*Master/.test(all2));
  }

  console.log(Y('\n[ 7 ] Chỉ còn 1 VPS sống vẫn phục vụ được'));
  {
    await killNode('vps2');
    await killNode('vps3');
    const h = await call('vps1', 'GET', '/api/health');
    assert('vps1 vẫn hoạt động khi 2 máy kia chết', h.status === 200);
    const r = await call('vps1', 'POST', '/api/start', startBody('solo-aaaa-bbbb-cccc-dddd-eeee'));
    assert('Vẫn tạo được luồng mới (chạy tại máy còn sống)', !r.data?.error, JSON.stringify(r.data));
    const off = await waitFor(async () => {
      const rr = await call('vps1', 'GET', '/api/cluster/report');
      const t = ((rr.data && rr.data.messages) || []).join('\n');
      return /Cụm: \*1\/3\*/.test(t) ? t : null;
    }, 30000);
    assert('Báo cáo khi chỉ còn 1 VPS: 1/3 online, 2 máy OFFLINE mất kết nối', !!off && (off.match(/OFFLINE/g) || []).length === 2 && /🔴 \*VPS 2/.test(off) && /🔴 \*VPS 3/.test(off), off && off.slice(0, 500));
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
