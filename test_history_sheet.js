/**
 * test_history_sheet.js — Test ghi lịch sử luồng lên tab LICH_SU_LUONG.
 * Chạy: node test_history_sheet.js
 *
 * Không chạm Google thật: chạy CHÍNH file google_apps_script.js trong vm với SpreadsheetApp giả (bảng tính trong RAM),
 * dựng 1 HTTP server giả làm Web App, 2 VPS giả (vps1 Master, vps2 Worker) trên cổng 3171/3172.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

const ROOT = __dirname;
const WORK = path.join(os.tmpdir(), 'livenew_history_sheet_test');
const SECRET = 'hist-test-secret';
const SHEET_PORT = 3173;
const NODES = [
  { id: 'vps1', name: 'VPS 1 (Master)', ip: '127.0.0.1', port: 3171, isMaster: true },
  { id: 'vps2', name: 'VPS 2 (Worker)', ip: '127.0.0.1', port: 3172, isMaster: false },
];

const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;
let passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(name, cond, detail = '') {
  if (cond) { console.log(G('  ✓ PASS'), name); passed++; }
  else { console.log(R('  ✗ FAIL'), name, detail ? `→ ${detail}` : ''); failed++; }
}
async function waitFor(fn, timeoutMs, stepMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(stepMs); }
  return null;
}

// ── Google Sheet giả ──
function makeSpreadsheet() {
  class Range {
    constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.sh.data[this.r - 1 + i] || [];
        out.push(Array.from({ length: this.nc }, (_, j) => row[this.c - 1 + j] === undefined ? '' : row[this.c - 1 + j]));
      }
      return out;
    }
    setValues(v) {
      v.forEach((row, i) => {
        const ri = this.r - 1 + i;
        while (this.sh.data.length <= ri) this.sh.data.push([]);
        row.forEach((val, j) => { this.sh.data[ri][this.c - 1 + j] = val; });
      });
      return this;
    }
    setValue(v) { return this.setValues([[v]]); }
    setFontWeight() { return this; }
    setNumberFormat() { return this; }
  }
  class Sheet {
    constructor(name) { this.name = name; this.data = []; }
    getName() { return this.name; }
    setName(n) { this.name = n; }
    getLastRow() { return this.data.length; }
    getRange(r, c, nr = 1, nc = 1) { return typeof r === 'string' ? new Range(this, 1, 1, 0, 0) : new Range(this, r, c, nr, nc); }
    getDataRange() { const nc = Math.max(1, ...this.data.map(x => x.length)); return new Range(this, 1, 1, this.data.length, nc); }
    setFrozenRows(n) { this.frozen = n; }
    getFrozenRows() { return this.frozen || 0; }
    deleteRow(i) { this.data.splice(i - 1, 1); }
  }
  const sheets = [];
  const ss = {
    sheets,
    getSheets: () => sheets.slice(),
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = new Sheet(n); sheets.push(s); return s; },
  };
  return ss;
}

function loadAppsScript(ss) {
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ({}) },
    ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate: d => d.toISOString().slice(0, 10) },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'google_apps_script.js'), 'utf8') + `\nDEFAULT_CONFIG.SYNC_SECRET = ${JSON.stringify(SECRET)};`, ctx);
  return (params) => JSON.parse(ctx.doGet({ parameter: params }).s);
}

// ── VPS giả ──
const procs = {}, logs = {};
function prepareDir(n) {
  const dir = path.join(WORK, n.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(ROOT)) if (/\.js$/.test(f) && !/^test|long_test/.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  for (const d of ['videos', 'music', 'temp', 'downloads']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cluster_nodes.json'), JSON.stringify(NODES, null, 2));
  fs.writeFileSync(path.join(dir, 'bot_config.json'), JSON.stringify({ token: '', adminIds: [], password: 'x', polling: false, zalo: { enabled: false }, sentinel: { enabled: false, knownServers: [] } }));
  // Mỗi máy trỏ cùng 1 Web App giả, kèm ?node= để biết máy nào gọi
  fs.writeFileSync(path.join(dir, 'sheet_config.json'), JSON.stringify({ googleSheetScriptUrl: `http://127.0.0.1:${SHEET_PORT}/exec?node=${n.id}`, syncSecret: SECRET, directSheetAuth: false }));
  return dir;
}
function startNode(n, fresh = true) {
  const dir = fresh ? prepareDir(n) : path.join(WORK, n.id);
  const out = []; logs[n.id] = out;
  const p = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { ...process.env, PORT: String(n.port), NODE_ID: n.id, CLUSTER_SECRET: SECRET, STRICT_INTERNAL: '1', SKIP_FFMPEG_CLEANUP: '1',
      HISTORY_SHEET_INTERVAL_MS: '2000', AUTO_MIGRATE: '0', NODE_PATH: path.join(ROOT, 'node_modules') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', d => out.push(d.toString()));
  p.stderr.on('data', d => out.push(d.toString()));
  procs[n.id] = p;
}
function killNode(id) {
  return new Promise(res => { const p = procs[id]; if (!p || p.exitCode !== null) return res(); p.once('exit', () => res()); p.kill(); setTimeout(res, 3000); });
}
const node = id => NODES.find(n => n.id === id);
async function call(id, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${node(id).port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Cluster-Secret': SECRET }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
const soon = () => { const d = new Date(Date.now() + 3600e3), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`; };
async function startStop(entry, key, serverId, name) {
  const r = await call(entry, 'POST', '/api/start', { key, file: 'http://127.0.0.1:9/v.mp4', mode: 'scheduled', minutes: 0, scheduledTime: soon(), name, serverId });
  if (r.data && r.data.id !== undefined) await call(entry, 'POST', '/api/stop', { id: r.data.id, serverId });
  return r;
}

async function run() {
  fs.mkdirSync(WORK, { recursive: true });

  console.log(Y('\n[ 1 ] Apps Script (chạy thật trong môi trường Sheet giả)'));
  {
    const ss = makeSpreadsheet();
    const users = ss.insertSheet('Trang tính1');
    users.data = [['Username', 'Password', 'Tên', 'Số luồng', 'Hạn', 'Server', 'TT', 'Quyền', 'Ghi chú'], ['admin', 'x', 'Admin', 999, 'Vĩnh viễn', 'All', 'Active', 'admin', '']];
    const doGet = loadAppsScript(ss);
    const bad = doGet({ secret: 'sai', action: 'appendHistory', rows: '[]' });
    assert('Sai secret → bị từ chối', !!bad.error);
    const row = (uid, st = 'Đang live') => ['', 'VPS 1', '5', 'Luồng A', 'khach1', 'abcd-efgh-ijkl-mnop', 'Lặp vô hạn', 'Google Drive Video', '12/10/2026 15:00:00', '2:00:00', st, '', '', uid];
    const r1 = doGet({ secret: SECRET, action: 'appendHistory', rows: JSON.stringify([row('u1'), row('u2')]) });
    const tab = ss.getSheetByName('LICH_SU_LUONG');
    assert('Tự tạo tab LICH_SU_LUONG + dòng tiêu đề (cột "Trạng thái")', !!tab && tab.data[0][0] === 'Kết thúc' && tab.data[0][10] === 'Trạng thái' && tab.data[0][13] === 'UID');
    assert('Ghi 2 dòng', r1.ok && r1.added === 2 && tab.data.length === 3, JSON.stringify(r1));
    const r2 = doGet({ secret: SECRET, action: 'appendHistory', rows: JSON.stringify([row('u1', 'Đã dừng'), row('u2'), row('u3')]) });
    assert('UID đã có → cập nhật đúng dòng, UID mới → thêm dòng', r2.added === 1 && r2.updated === 2 && tab.data.length === 4, JSON.stringify(r2));
    assert('Dòng u1 đổi "Đang live" → "Đã dừng" tại chỗ', tab.data[1][13] === 'u1' && tab.data[1][10] === 'Đã dừng' && tab.data[2][10] === 'Đang live');
    const r2b = doGet({ secret: SECRET, action: 'appendHistory', rows: JSON.stringify([row('u4'), row('u4', 'Hoàn thành')]) });
    assert('Cùng 1 lô có 2 bản 1 UID → 1 dòng, lấy bản sau', r2b.added === 1 && tab.data.length === 5 && tab.data[4][10] === 'Hoàn thành', JSON.stringify(r2b));
    tab.data[0][10] = 'Kết quả'; // giả lập tab do bản cũ tạo
    doGet({ secret: SECRET, action: 'appendHistory', rows: JSON.stringify([row('u4', 'Hoàn thành')]) });
    assert('Tab cũ (cột "Kết quả") được đổi tiêu đề thành "Trạng thái"', tab.data[0][10] === 'Trạng thái' && tab.data.length === 5);
    const r3 = doGet({ secret: SECRET, action: 'appendHistory', rows: 'khong-phai-json' });
    assert('rows lỗi → báo lỗi, không ghi bậy', !!r3.error && tab.data.length === 5);
    // Đưa tab lịch sử lên đầu: tài khoản vẫn phải đọc từ tab tài khoản
    ss.sheets.unshift(ss.sheets.pop());
    const u = doGet({ secret: SECRET, action: 'getUsers' });
    assert('Tab lịch sử nằm đầu vẫn đọc đúng tab tài khoản', u.ok && u.total === 1 && u.users[0].username === 'admin', JSON.stringify(u).slice(0, 200));
  }

  console.log(Y('\n[ 2 ] 2 VPS giả đẩy lịch sử lên Web App giả'));
  const ss = makeSpreadsheet();
  ss.insertSheet('DANH_SACH_KHACH_HANG').data = [['Username', 'Password', 'Tên', 'Số luồng', 'Hạn', 'Server', 'TT', 'Quyền', 'Ghi chú'], ['admin', 'x', 'Admin', 999, 'Vĩnh viễn', 'All', 'Active', 'admin', '']];
  const doGet = loadAppsScript(ss);
  const reqs = [];
  let oldScript = false;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const params = Object.fromEntries(u.searchParams);
    reqs.push({ node: params.node, action: params.action });
    let out;
    if (oldScript && params.action === 'appendHistory') out = { error: 'Hành động không hợp lệ' };
    else { try { out = doGet(params); } catch (e) { out = { error: e.message }; } }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  await new Promise(r => srv.listen(SHEET_PORT, '127.0.0.1', r));
  const tab = () => ss.getSheetByName('LICH_SU_LUONG');
  const dataRows = () => (tab() ? tab().data.slice(1) : []);

  try {
    NODES.forEach(n => startNode(n));
    for (const n of NODES) assert(`${n.id} khởi động`, !!(await waitFor(async () => (await call(n.id, 'GET', '/api/health')).status === 200, 20000)));

    const K1 = 'hist1-aaaa-bbbb-cccc-1111', K2 = 'hist2-aaaa-bbbb-cccc-2222';
    // Chạy (đặt lịch, chưa dừng) → phải có dòng "Đang chờ lịch"
    const s1 = await call('vps1', 'POST', '/api/start', { key: K1, file: 'http://127.0.0.1:9/v.mp4', mode: 'scheduled', minutes: 0, scheduledTime: soon(), name: 'Luồng trên Master', serverId: 'vps1' });
    const s2 = await call('vps1', 'POST', '/api/start', { key: K2, file: 'http://127.0.0.1:9/v.mp4', mode: 'scheduled', minutes: 0, scheduledTime: soon(), name: 'Luồng trên Worker', serverId: 'vps2' });
    assert('Tạo 2 luồng đặt lịch (Master + Worker)', s1.data && s1.data.id !== undefined && s2.data && s2.data.id !== undefined, JSON.stringify([s1, s2]));
    const runRows = await waitFor(() => dataRows().length >= 2 && dataRows().every(r => r[10] === 'Đang chờ lịch') ? dataRows() : null, 20000);
    assert('Luồng đang chạy được ghi ngay: 2 dòng "Đang chờ lịch"', !!runRows && runRows.length === 2, JSON.stringify(dataRows()));
    let uids = {};
    if (runRows) {
      const a = runRows.find(r => r[3] === 'Luồng trên Master'), b = runRows.find(r => r[3] === 'Luồng trên Worker');
      assert('Dòng đang chạy: cột Kết thúc trống, Stream Key ĐẦY ĐỦ', a && a[0] === '' && a[5] === K1 && b && b[5] === K2, JSON.stringify([a, b]));
      if (a && b) uids = { a: a[13], b: b[13] };
    }
    await sleep(5000);
    assert('Đang chạy qua nhiều chu kỳ không sinh thêm dòng', dataRows().length === 2, `rows=${dataRows().length}`);
    // Dừng → CÙNG dòng đổi thành "Đã dừng"
    await call('vps1', 'POST', '/api/stop', { id: s1.data.id, serverId: 'vps1' });
    await call('vps1', 'POST', '/api/stop', { id: s2.data.id, serverId: 'vps2' });
    const got = await waitFor(() => dataRows().length >= 2 && dataRows().every(r => r[10] === 'Đã dừng') ? dataRows() : null, 20000);
    assert('Dừng → 2 dòng cũ đổi thành "Đã dừng", không thêm dòng', !!got && got.length === 2, JSON.stringify(dataRows()));
    if (got) {
      const byName = n => got.find(r => r[3] === n);
      const a = byName('Luồng trên Master'), b = byName('Luồng trên Worker');
      assert('Đúng máy chủ cho từng dòng', a && a[1] === 'VPS 1 (Master)' && b && b[1] === 'VPS 2 (Worker)', JSON.stringify([a && a[1], b && b[1]]));
      assert('UID giữ nguyên (cập nhật tại chỗ)', a && b && a[13] === uids.a && b[13] === uids.b, JSON.stringify([uids, a && a[13], b && b[13]]));
      assert('Có giờ kết thúc, thời lượng dạng h:mm:ss', a && /\d{1,2}:\d{2}:\d{2}/.test(a[0]) && /^\d+:\d{2}:\d{2}$/.test(a[9]), JSON.stringify(a));
      assert('Stream Key đầy đủ ở dòng kết thúc', a && a[5] === K1 && b && b[5] === K2);
      assert('Có UID riêng cho từng dòng', a && b && a[13] && b[13] && a[13] !== b[13]);
    }
    await sleep(6000);
    assert('Sau vài chu kỳ không bị nhân đôi', dataRows().length === 2, `rows=${dataRows().length}`);
    const pushers = new Set(reqs.filter(r => r.action === 'appendHistory').map(r => r.node));
    assert('Chỉ Master (vps1) ghi lên Sheet, Worker không ghi', pushers.size === 1 && pushers.has('vps1'), JSON.stringify([...pushers]));

    console.log(Y('\n[ 3 ] Master khởi động lại khi có luồng đang chạy → không ghi trùng'));
    const K5 = 'hist5-aaaa-bbbb-cccc-5555';
    const s5 = await call('vps1', 'POST', '/api/start', { key: K5, file: 'http://127.0.0.1:9/v.mp4', mode: 'scheduled', minutes: 0, scheduledTime: soon(), name: 'Luồng qua restart', serverId: 'vps1' });
    await waitFor(() => dataRows().some(r => r[3] === 'Luồng qua restart') ? true : null, 20000);
    await killNode('vps1');
    startNode(node('vps1'), false);
    await waitFor(async () => (await call('vps1', 'GET', '/api/health')).status === 200, 20000);
    await sleep(6000);
    assert('Khởi động lại Master không nhân đôi dòng', dataRows().length === 3, `rows=${dataRows().length}`);
    await call('vps1', 'POST', '/api/stop', { id: s5.data && s5.data.id, serverId: 'vps1' });
    const r5 = await waitFor(() => { const r = dataRows().find(x => x[3] === 'Luồng qua restart'); return r && r[10] === 'Đã dừng' ? r : null; }, 20000);
    assert('Sau restart, dừng luồng → vẫn cập nhật đúng dòng cũ', !!r5 && dataRows().length === 3, JSON.stringify(dataRows().map(r => [r[3], r[10]])));

    console.log(Y('\n[ 3b ] Master khởi động lại lần nữa (không còn luồng chạy) → không ghi trùng'));
    await killNode('vps1');
    startNode(node('vps1'), false);
    await waitFor(async () => (await call('vps1', 'GET', '/api/health')).status === 200, 20000);
    await sleep(6000);
    assert('Khởi động lại Master không nhân đôi dòng', dataRows().length === 3, `rows=${dataRows().length}`);

    console.log(Y('\n[ 4 ] Master sập → lịch sử trên Worker được ghi bù khi Master sống lại'));
    await killNode('vps1');
    const K3 = 'hist3-aaaa-bbbb-cccc-3333';
    await startStop('vps2', K3, 'vps2', 'Luồng lúc Master sập');
    await sleep(5000);
    assert('Master sập: chưa ai ghi (Worker không tự ghi)', dataRows().length === 3, `rows=${dataRows().length}`);
    startNode(node('vps1'), false);
    const back = await waitFor(() => dataRows().some(r => r[3] === 'Luồng lúc Master sập') ? true : null, 30000);
    assert('Master sống lại → ghi bù dòng của Worker', !!back && dataRows().length === 4, `rows=${dataRows().length}`);

    console.log(Y('\n[ 5 ] Apps Script cũ (chưa triển khai lại) → chỉ cảnh báo, không hỏng gì'));
    oldScript = true;
    await startStop('vps1', 'hist4-aaaa-bbbb-cccc-4444', 'vps1', 'Luồng lúc script cũ');
    const warned = await waitFor(() => /Apps Script chưa có chức năng ghi lịch sử/.test(logs.vps1.join('')), 15000);
    assert('Có cảnh báo hướng dẫn triển khai lại Apps Script', !!warned);
    assert('Server vẫn chạy bình thường', (await call('vps1', 'GET', '/api/health')).status === 200);
    oldScript = false;
    const late = await waitFor(() => dataRows().some(r => r[3] === 'Luồng lúc script cũ') ? true : null, 15000);
    assert('Triển khai lại xong → tự ghi bù dòng bị lỡ', !!late && dataRows().length === 5, `rows=${dataRows().length}`);
    const uidList = dataRows().map(r => r[13]);
    assert('Toàn bộ tab không có UID trùng, không còn dòng "Đang..." treo', new Set(uidList).size === uidList.length && dataRows().every(r => !/^Đang/.test(r[10])), JSON.stringify(dataRows().map(r => [r[3], r[10]])));
  } finally {
    srv.close();
  }
}

(async () => {
  let code = 0;
  try { await run(); } catch (e) { console.error(R('Lỗi test:'), e); code = 1; }
  for (const id of Object.keys(procs)) { try { procs[id].kill(); } catch (_) {} }
  await sleep(500);
  if (failed > 0 && process.env.SHOW_LOGS) for (const id of Object.keys(logs)) console.log(`\n--- log ${id} ---\n${logs[id].join('').split('\n').slice(-40).join('\n')}`);
  console.log(`\n═══ Kết quả: ${passed} PASS  ${failed} FAIL ═══`);
  process.exit(failed > 0 || code ? 1 : 0);
})();
