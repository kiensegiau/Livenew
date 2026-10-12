// ─── Tự động chuyển luồng đang chạy khi một VPS (Worker) bị chết ───────────────
// Chỉ chạy trên Master. Luồng:
//  1) Mỗi vài giây Master "chụp" danh sách luồng đang hoạt động của từng Worker khi Worker còn sống.
//  2) Worker mất kết nối liên tục quá FAILOVER_AFTER_SEC (mặc định 90s) -> coi là chết -> chuyển các luồng
//     đã chụp sang máy còn sống (đúng quyền máy chủ của chủ luồng, cân bằng tải như luồng mới).
//  3) Worker sống lại -> Master tự dừng bản cũ còn sót trên Worker đó để KHÔNG bị phát trùng Stream Key.
// Chỉ chuyển được luồng có nguồn video lấy lại được (link Google Drive/HTTP). Luồng dùng file cục bộ trên
// máy đã chết không thể chuyển -> chỉ cảnh báo.
const fs = require('fs');
const path = require('path');

const ACTIVE = ['live', 'reconnecting', 'launching', 'scheduled', 'downloading'];
const STATE_FILE = process.env.FAILOVER_STATE || path.join(__dirname, 'cluster_failover_state.json');

function init(ctx) {
  if (process.env.AUTO_MIGRATE === '0') {
    console.log('[Failover] Tắt tự động chuyển luồng (AUTO_MIGRATE=0)');
    return null;
  }
  const AFTER_MS = (parseInt(process.env.FAILOVER_AFTER_SEC) || 90) * 1000;
  const TICK_MS = parseInt(process.env.FAILOVER_TICK_MS) || 10000;
  const cm = ctx.clusterManager;

  const snaps = new Map();      // nodeId -> { at, streams: [...] }
  const downSince = new Map();  // nodeId -> timestamp bắt đầu mất kết nối
  const migrated = new Map();   // nodeId -> [{ origId, newServerId, newId, key, name }]
  const reports = [];           // nhật ký kết quả chuyển luồng (tối đa 100)
  let busy = false;

  try {
    if (fs.existsSync(STATE_FILE)) {
      const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      Object.entries(d.snaps || {}).forEach(([k, v]) => snaps.set(k, v));
      Object.entries(d.migrated || {}).forEach(([k, v]) => migrated.set(k, v));
    }
  } catch (e) { console.error('[Failover] Không đọc được trạng thái cũ:', e.message); }

  function persist() {
    try {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ snaps: Object.fromEntries(snaps), migrated: Object.fromEntries(migrated) }), 'utf8');
      fs.renameSync(tmp, STATE_FILE);
    } catch (_) {}
  }
  function report(entry) { reports.push({ at: new Date().toISOString(), ...entry }); if (reports.length > 100) reports.shift(); }
  function notify(msg) { try { ctx.notify(msg); } catch (_) {} }

  async function probe(node) {
    try { const r = await cm.callNodeApi(node, '/api/health', 'GET', null, 4000); return r.statusCode === 200; }
    catch (_) { return false; }
  }

  // Worker còn sống: chụp danh sách luồng + dọn bản trùng nếu vừa được chuyển đi
  async function onUp(node) {
    let list = null;
    try {
      const r = await cm.callNodeApi(node, '/api/streams', 'GET', null, 5000);
      if (r.statusCode === 200 && Array.isArray(r.data)) list = r.data;
    } catch (_) {}
    if (!list) return;

    const recs = migrated.get(node.id);
    if (recs) {
      for (const rec of recs) {
        const stale = list.find(s => s.id === rec.origId && ACTIVE.includes(s.status));
        if (stale) {
          const r = await cm.forwardStreamAction(node.id, 'stop', { id: rec.origId, serverId: node.id });
          console.log(`[Failover] ${node.name} đã sống lại: dừng bản cũ #${rec.origId} (đã chuyển sang ${rec.newServerId}) để tránh trùng key`, r && r.error ? r.error : '');
          report({ node: node.id, streamId: rec.origId, event: 'stopped-stale-copy', ok: !(r && r.error) });
          notify(`♻️ *${node.name} đã hoạt động lại*\nĐã tự dừng bản cũ của luồng "${rec.name || rec.origId}" vì luồng đã được chuyển sang ${rec.newServerId} (tránh phát trùng Stream Key).`);
        }
      }
      migrated.delete(node.id);
      persist();
    }

    snaps.set(node.id, {
      at: Date.now(),
      streams: list.filter(s => ACTIVE.includes(s.status) && s.key).map(s => ({
        id: s.id, key: s.key, originalFile: s.originalFile, mode: s.mode, minutes: s.minutes || 0,
        scheduledTime: s.scheduledTime, scheduledMode: s.scheduledMode, name: s.name, youtubeUrl: s.youtubeUrl,
        ownerId: s.ownerId, ownerUsername: s.ownerUsername, status: s.status, firstLiveTime: s.firstLiveTime || null
      }))
    });
    persist();
  }

  async function onDown(node) {
    if (!downSince.has(node.id)) downSince.set(node.id, Date.now());
    const down = Date.now() - downSince.get(node.id);
    if (down < AFTER_MS || migrated.has(node.id)) return;
    await migrateNode(node);
  }

  function restorable(src) {
    const f = String(src || '');
    return /^https?:\/\//i.test(f) || !!(ctx.extractDriveId && ctx.extractDriveId(f));
  }

  async function migrateOne(node, s) {
    if (!restorable(s.originalFile)) return { ok: false, why: 'dùng file cục bộ trên máy đã chết, không thể tự chuyển' };
    let minutes = s.minutes || 0;
    if (minutes > 0 && s.firstLiveTime) {
      const left = Math.ceil(minutes - (Date.now() - new Date(s.firstLiveTime).getTime()) / 60000);
      if (left <= 0) return { ok: false, why: 'đã hết thời lượng phát' };
      minutes = left;
    }
    if (s.mode === 'scheduled') {
      const t = new Date(s.scheduledTime).getTime();
      if (!isNaN(t) && t <= Date.now()) return { ok: false, why: 'đã quá giờ hẹn' };
    }
    let allowed = ['all'];
    try {
      const u = ctx.userManager.listUsers().find(x => x.id === s.ownerId || x.username === s.ownerUsername);
      if (u && Array.isArray(u.allowedServers) && u.allowedServers.length) allowed = u.allowedServers;
    } catch (_) {}
    // Loại máy đã chết khỏi danh sách được phép (tránh chờ timeout khi dò tải) rồi chọn máy tối ưu như luồng mới
    const deadId = String(node.id).toLowerCase();
    const pool = allowed.map(a => String(a).toLowerCase()).includes('all')
      ? cm.getNodes().map(n => n.id)
      : allowed.map(a => String(a).toLowerCase());
    const survivors = pool.filter(id => id !== deadId);
    if (survivors.length === 0) return { ok: false, why: 'máy chủ duy nhất được phép dùng đã chết' };
    const dec = await cm.selectOptimalNode(survivors, ctx.getLocalSysinfo());
    if (!dec || dec.full || !dec.nodeId) return { ok: false, why: (dec && dec.reason) || 'không còn máy chủ phù hợp' };
    if (dec.nodeId === node.id) return { ok: false, why: 'máy chủ duy nhất được phép dùng đã chết' };

    const body = {
      key: s.key, file: s.originalFile, mode: s.mode, minutes, scheduledTime: s.scheduledTime,
      scheduledMode: s.scheduledMode, name: s.name, youtubeUrl: s.youtubeUrl,
      ownerId: s.ownerId, ownerUsername: s.ownerUsername, serverId: dec.nodeId
    };
    const res = dec.nodeId === ctx.localNodeId()
      ? ctx.startStream(body)
      : await cm.forwardStreamAction(dec.nodeId, 'start', body);
    if (!res || res.error) return { ok: false, why: (res && res.error) || 'không khởi chạy được' };
    return { ok: true, newServerId: dec.nodeId, newId: res.id };
  }

  async function migrateNode(node) {
    const snap = snaps.get(node.id);
    const list = (snap && snap.streams) || [];
    migrated.set(node.id, []);   // đánh dấu đã xử lý ngay để không chuyển lặp
    persist();
    console.warn(`[Failover] 🚨 ${node.name} mất kết nối quá ${Math.round(AFTER_MS / 1000)}s. Chuyển ${list.length} luồng sang máy còn sống...`);
    if (list.length === 0) { notify(`🚨 *${node.name} mất kết nối*\nKhông có luồng đang chạy cần chuyển.`); return; }
    const okLines = [], failLines = [];
    const recs = [];
    for (const s of list) {
      let r;
      try { r = await migrateOne(node, s); } catch (e) { r = { ok: false, why: e.message }; }
      report({ node: node.id, streamId: s.id, name: s.name, event: 'migrate', ...r });
      if (r.ok) {
        recs.push({ origId: s.id, newServerId: r.newServerId, newId: r.newId, key: s.key, name: s.name });
        okLines.push(`✅ "${s.name || s.id}" → ${r.newServerId}`);
      } else {
        failLines.push(`❌ "${s.name || s.id}": ${r.why}`);
      }
    }
    migrated.set(node.id, recs);
    persist();
    notify(`🚨 *${node.name} MẤT KẾT NỐI — TỰ ĐỘNG CHUYỂN LUỒNG*\n━━━━━━━━━━━━━━━━━━\n${okLines.concat(failLines).join('\n')}`);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const me = cm.getNode(ctx.localNodeId());
      if (!me || !me.isMaster) return;   // chỉ Master điều phối
      for (const node of cm.getNodes()) {
        if (node.isLocal) continue;
        if (await probe(node)) {
          if (downSince.has(node.id)) downSince.delete(node.id);
          await onUp(node);
        } else {
          await onDown(node);
        }
      }
    } catch (e) {
      console.error('[Failover] Lỗi vòng kiểm tra:', e.message);
    } finally { busy = false; }
  }

  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  console.log(`[Failover] Bật tự động chuyển luồng khi Worker chết (sau ${Math.round(AFTER_MS / 1000)}s mất kết nối, chỉ Master điều phối)`);

  return {
    tick,
    getState: () => ({
      afterSec: Math.round(AFTER_MS / 1000),
      down: Object.fromEntries(Array.from(downSince.entries()).map(([k, v]) => [k, Math.round((Date.now() - v) / 1000)])),
      snapshots: Object.fromEntries(Array.from(snaps.entries()).map(([k, v]) => [k, { at: v.at, streams: v.streams.length }])),
      migrated: Object.fromEntries(migrated),
      reports: reports.slice(-50)
    })
  };
}

module.exports = { init };
