/**
 * test_startup_race.js — Lệnh bật luồng tới NGAY lúc máy vừa khởi động (trước khi khôi phục xong danh sách luồng)
 *  Trước đây: luồng mới có thể lấy trùng ID luồng cũ / ghi đè streams_backup.json (mất luồng cũ) / bị khôi phục lần 2 (tải Drive 2 lần).
 *  Giờ: lệnh được giữ lại tới khi khôi phục xong → không mất, không trùng.
 * Chạy: node test_startup_race.js
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const WORK = path.join(os.tmpdir(), 'livenew_startup_race_test');
const SECRET = 'startup-race-secret-1234567';
const FAKE_FF = path.join(WORK, 'fake_ffmpeg.exe');
const PORT = 3271;
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`;
let passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(name, cond, detail = '') {
  if (cond) { console.log(G('  ✓ PASS'), name); passed++; }
  else { console.log(R('  ✗ FAIL'), name, detail ? `→ ${String(detail).slice(0, 500)}` : ''); failed++; }
}
let proc;
(async () => {
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/out:' + FAKE_FF, path.join(ROOT, 'test_fixtures', 'fake_ffmpeg.cs')]);
    const dir = path.join(WORK, 'n1');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(ROOT)) if (/\.js$/.test(f) && !/^test|long_test/.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
    fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
    for (const d of ['videos', 'music', 'temp', 'downloads']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    const vid = path.join(dir, 'videos', 'a.mp4');
    fs.writeFileSync(vid, 'fake');
    fs.copyFileSync(FAKE_FF, path.join(dir, 'ffmpeg.exe'));
    fs.writeFileSync(path.join(dir, 'cluster_nodes.json'), JSON.stringify([{ id: 'n1', name: 'n1', ip: '127.0.0.1', port: PORT, isMaster: true }]));
    fs.writeFileSync(path.join(dir, 'bot_config.json'), JSON.stringify({ token: '', adminIds: [], password: 'x', polling: false, zalo: { enabled: false }, sentinel: { enabled: false, knownServers: [] } }));
    fs.writeFileSync(path.join(dir, 'sheet_config.json'), JSON.stringify({ syncSecret: SECRET, googleSheetScriptUrl: '', driveCopyUrls: [] }));
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 2 * 864e5).toISOString();
    // 3 luồng cũ đang chạy/hẹn giờ, ID 1..3
    const old = [1, 2, 3].map(id => ({ id, name: 'Cũ ' + id, key: `old-key-000${id}`, file: vid, originalFile: vid, mode: id === 3 ? 'scheduled' : 'loop', scheduledMode: 'loop', scheduledTime: id === 3 ? future : null, minutes: 0, status: id === 3 ? 'scheduled' : 'live', ownerId: 'admin_root', ownerUsername: 'admin', serverId: 'n1', createdAt: now, updatedAt: now }));
    fs.writeFileSync(path.join(dir, 'streams_backup.json'), JSON.stringify(old));

    const env = { ...process.env, PORT: String(PORT), NODE_ID: 'n1', CLUSTER_SECRET: SECRET, STRICT_INTERNAL: '1', SKIP_FFMPEG_CLEANUP: '1', HISTORY_SHEET: '0', SHEET_NODES: '0', AUTO_MIGRATE: '0', DRIVE_AUTO_COPY: '0', NODE_PATH: path.join(ROOT, 'node_modules') };
    proc = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; proc.stdout.on('data', d => out.push(d.toString())); proc.stderr.on('data', d => out.push(d.toString()));

    // Bắn lệnh bật luồng NGAY khi cổng vừa mở (trước khi khôi phục xong)
    const H = { 'Content-Type': 'application/json', 'X-Cluster-Secret': SECRET };
    let r = null;
    for (let i = 0; i < 200 && !r; i++) {
      try {
        const rr = await fetch(`http://127.0.0.1:${PORT}/api/start`, { method: 'POST', headers: H, body: JSON.stringify({ key: 'new-key-0009', file: vid, mode: 'loop', minutes: 0, name: 'Mới', serverId: 'n1' }) });
        r = { status: rr.status, data: await rr.json().catch(() => null) };
      } catch (_) { await sleep(25); }
    }
    const restoredAt = out.join('').indexOf('khôi phục');
    assert('Lệnh bật luồng sớm được nhận (200)', r && r.status === 200 && r.data && r.data.id, JSON.stringify(r));
    assert('Luồng mới KHÔNG trùng ID luồng cũ (ID > 3)', r && r.data && r.data.id > 3, JSON.stringify(r && r.data));
    await sleep(3000);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/api/streams`, { headers: { ...H, 'X-Cluster-Forwarded': '1' } })).json();
    assert('Còn đủ 3 luồng cũ + 1 luồng mới', list.length === 4 && [1, 2, 3].every(id => list.some(s => s.id === id)), JSON.stringify(list.map(s => [s.id, s.status])));
    const backup = JSON.parse(fs.readFileSync(path.join(dir, 'streams_backup.json'), 'utf8'));
    assert('streams_backup.json còn đủ 4 luồng (không bị ghi đè mất luồng cũ)', backup.length === 4, JSON.stringify(backup.map(s => s.id)));
    const starts = (out.join('').match(/\[Stream #(\d+)\] 🚀/g) || []).filter(x => x.includes(`#${r.data.id}]`)).length;
    assert('Luồng mới chỉ khởi chạy 1 lần', starts === 1, `starts=${starts}`);
    console.log(`    (log có dòng khôi phục: ${restoredAt >= 0})`);
  } catch (e) {
    console.log(R('LỖI TEST: ' + e.stack)); failed++;
  } finally {
    try { proc && proc.kill(); } catch (_) {}
    console.log(`\nKết quả: ${G(passed + ' PASS')}, ${failed ? R(failed + ' FAIL') : '0 FAIL'}`);
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  }
})();
