// ─── Tự động chuyển luồng đang chạy khi một VPS (Worker) bị chết ───────────────
// Chạy trên Master (điều phối Worker) và trên Worker (dự phòng khi Master chết). Luồng:
//  1) Mỗi vài giây Master "chụp" danh sách luồng đang hoạt động của từng Worker khi Worker còn sống.
//  2) Worker mất kết nối liên tục quá FAILOVER_AFTER_SEC (mặc định 90s) -> coi là chết -> chuyển các luồng
//     đã chụp sang máy còn sống (đúng quyền máy chủ của chủ luồng, cân bằng tải như luồng mới).
//  3) Worker sống lại -> Master tự dừng bản cũ còn sót trên Worker đó để KHÔNG bị phát trùng Stream Key.
// Chỉ chuyển được luồng có nguồn video lấy lại được (link Google Drive/HTTP). Luồng dùng file cục bộ trên
// máy đã chết không thể chuyển -> chỉ cảnh báo.
const fs = require('fs');
const path = require('path');
const http = require('http');

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
  const retryQ = new Map();     // nodeId -> [{ s, tries, lastTry }] luồng chuyển thất bại tạm thời, sẽ thử lại
  const RETRY_MS = (parseInt(process.env.FAILOVER_RETRY_SEC) || 30) * 1000;
  const MAX_RETRY = parseInt(process.env.FAILOVER_MAX_RETRY) || 10;
  // URL kiểm tra máy này có còn mạng ra ngoài không (rỗng = tắt kiểm tra). Tránh máy mất mạng tự cho rằng các máy khác chết.
  const NET_URL = process.env.FAILOVER_NET_CHECK_URL !== undefined ? process.env.FAILOVER_NET_CHECK_URL : 'http://connectivitycheck.gstatic.com/generate_204';
  let busy = false;

  try {
    if (fs.existsSync(STATE_FILE)) {
      const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      Object.entries(d.snaps || {}).forEach(([k, v]) => snaps.set(k, v));
      Object.entries(d.migrated || {}).forEach(([k, v]) => migrated.set(k, v));
      Object.entries(d.retry || {}).forEach(([k, v]) => retryQ.set(k, v));
    }
  } catch (e) { console.error('[Failover] Không đọc được trạng thái cũ:', e.message); }

  function persist() {
    try {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ snaps: Object.fromEntries(snaps), migrated: Object.fromEntries(migrated), retry: Object.fromEntries(retryQ) }), 'utf8');
      fs.renameSync(tmp, STATE_FILE);
    } catch (_) {}
  }
  function report(entry) { reports.push({ at: new Date().toISOString(), ...entry }); if (reports.length > 100) reports.shift(); }
  function notify(msg) { try { ctx.notify(msg); } catch (_) {} }

  // ── Helper định dạng tin nhắn (Telegram Markdown cũ: escape _ * ` [) ──
  const esc = (t) => String(t == null ? '' : t).replace(/([_*`\[])/g, '\\$1');
  const nowVN = () => new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const roleOf = (n) => (n && n.isMaster) ? 'Master' : 'Worker';
  // Thêm " (Master/Worker)" chỉ khi tên máy chưa nói rõ vai trò (tên mặc định đã có sẵn "Master"/"Worker")
  const roleTag = (n) => (n && /master|worker/i.test(String(n.name || ''))) ? '' : ` (${roleOf(n)})`;
  const nameOf = (id) => { const n = cm.getNode(id); return n ? n.name : String(id); };
  const keyTail = (k) => { const s = String(k || ''); return s.length > 4 ? `…${s.slice(-4)}` : s; };
  const LINE = '━━━━━━━━━━━━━━━━━━';
  const streamLabel = (s) => `${esc(s.name || ('#' + s.id))} (#${s.id}, key ${esc(keyTail(s.key))})`;

  async function probe(node) {
    try { const r = await cm.callNodeApi(node, '/api/health', 'GET', null, 4000); return r.statusCode === 200; }
    catch (_) { return false; }
  }

  // Máy này còn kết nối mạng ra ngoài? (nếu không: không được "tiếp quản" luồng của máy khác vì có thể chính máy này mới là máy mất mạng -> chạy trùng key)
  function selfOnline() {
    if (!NET_URL) return Promise.resolve(true);
    return new Promise(resolve => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const req = http.get(NET_URL, { timeout: 4000 }, (res) => { res.resume(); fin(true); });
        req.on('timeout', () => { req.destroy(); fin(false); });
        req.on('error', () => fin(false));
      } catch (_) { fin(false); }
    });
  }

  // Thử lại các luồng đã chuyển thất bại tạm thời (máy đích chập chờ/đầy...) trong khi máy sự cố vẫn chết
  async function retryPending(node) {
    const q = retryQ.get(node.id);
    if (!q || !q.length) return;
    const now = Date.now();
    const due = q.filter(x => now - (x.lastTry || 0) >= RETRY_MS);
    if (!due.length) return;
    if (!(await selfOnline())) return;
    const recs = migrated.get(node.id) || [];
    const okLines = [], giveUp = [];
    for (const x of due) {
      let r;
      try { r = await migrateOne(node, x.s); } catch (e) { r = { ok: false, why: e.message }; }
      x.tries = (x.tries || 0) + 1; x.lastTry = Date.now();
      report({ node: node.id, streamId: x.s.id, name: x.s.name, event: 'migrate-retry', tries: x.tries, ...r });
      if (r.ok) {
        recs.push({ origId: x.s.id, newServerId: r.newServerId, newId: r.newId, key: x.s.key, name: x.s.name });
        okLines.push(`✅ ${streamLabel(x.s)}\n    ${esc(node.name)} → *${esc(nameOf(r.newServerId))}* (luồng mới #${r.newId}${r.minutesLeft > 0 ? `, còn *${r.minutesLeft}* phút` : ''}, thử lại lần ${x.tries})`);
        q.splice(q.indexOf(x), 1);
      } else if (r.perm || x.tries >= MAX_RETRY) {
        giveUp.push(`❌ ${streamLabel(x.s)}\n    Lý do: ${esc(r.why)} (đã thử ${x.tries} lần, dừng thử)`);
        q.splice(q.indexOf(x), 1);
      }
    }
    migrated.set(node.id, recs);
    if (!q.length) retryQ.delete(node.id);
    persist();
    if (okLines.length || giveUp.length) {
      const lines = [`🔁 *CHUYỂN LUỒNG — THỬ LẠI SAU SỰ CỐ ${esc(node.name)}*`, LINE, `🕒 Thời gian: \`${nowVN()}\``, `🖥️ Máy xử lý: *${esc(nameOf(ctx.localNodeId()))}*${roleTag(cm.getNode(ctx.localNodeId()))}`];
      if (okLines.length) lines.push('', ...okLines);
      if (giveUp.length) lines.push('', ...giveUp);
      notify(lines.join('\n'));
    }
  }

  // Worker còn sống: chụp danh sách luồng + dọn bản trùng nếu vừa được chuyển đi
  async function onUp(node) {
    let list = null;
    try {
      const r = await cm.callNodeApi(node, '/api/streams', 'GET', null, 5000);
      if (r.statusCode === 200 && Array.isArray(r.data)) list = r.data;
    } catch (_) {}
    if (!list) return;
    // Máy vừa khởi động lại có thể đã mở cổng nhưng CHƯA nạp luồng cũ (danh sách rỗng) → chờ ready, nếu không sẽ bỏ sót bản cũ và chạy trùng key
    if (migrated.has(node.id)) {
      try {
        const h = await cm.callNodeApi(node, '/api/health', 'GET', null, 4000);
        if (h && h.data && h.data.ready === false) return;
      } catch (_) { return; }
    }

    const recs = migrated.get(node.id);
    if (recs) {
      const stopped = [], skipped = [], failed = [];
      for (const rec of recs) {
        const stale = list.find(s => s.id === rec.origId && ACTIVE.includes(s.status));
        if (stale) {
          const r = await cm.forwardStreamAction(node.id, 'stop', { id: rec.origId, serverId: node.id });
          console.log(`[Failover] ${node.name} đã sống lại: dừng bản cũ #${rec.origId} (đã chuyển sang ${rec.newServerId}) để tránh trùng key`, r && r.error ? r.error : '');
          const ok = !(r && r.error);
          report({ node: node.id, streamId: rec.origId, event: 'stopped-stale-copy', ok });
          (ok ? stopped : failed).push(`• ${streamLabel({ id: rec.origId, name: rec.name, key: rec.key })} → đang chạy ở *${esc(nameOf(rec.newServerId))}*${ok ? '' : ` (lỗi dừng: ${esc(r.error)})`}`);
        } else {
          skipped.push(`• ${streamLabel({ id: rec.origId, name: rec.name, key: rec.key })}`);
        }
      }
      migrated.delete(node.id);
      retryQ.delete(node.id);
      persist();
      const lines = [
        `♻️ *${esc(node.name)}${roleTag(node)} ĐÃ HOẠT ĐỘNG LẠI*`, LINE,
        `🕒 Thời gian: \`${nowVN()}\``,
        `🖥️ Máy điều phối: *${esc(nameOf(ctx.localNodeId()))}*${roleTag(cm.getNode(ctx.localNodeId()))}`,
        `📊 Đã chuyển đi trước đó: *${recs.length}* luồng | Đã dừng bản cũ: *${stopped.length}* | Lỗi: *${failed.length}*`,
      ];
      if (stopped.length) lines.push('', '🛑 Đã tự dừng bản cũ (tránh phát trùng Stream Key):', ...stopped);
      if (failed.length) lines.push('', '⚠️ Dừng bản cũ THẤT BẠI, cần kiểm tra thủ công:', ...failed);
      if (skipped.length) lines.push('', 'ℹ️ Bản cũ không còn chạy sẵn (không cần dừng):', ...skipped);
      notify(lines.join('\n'));
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
    if (down < AFTER_MS) return;
    if (migrated.has(node.id)) { await retryPending(node); return; }
    if (!(await selfOnline())) { console.warn(`[Failover] ⚠️ ${node.name} không phản hồi nhưng máy này cũng mất mạng ra ngoài → hoãn chuyển luồng (tránh chạy trùng key)`); return; }
    await migrateNode(node);
  }

  function restorable(src) {
    const f = String(src || '');
    return /^https?:\/\//i.test(f) || !!(ctx.extractDriveId && ctx.extractDriveId(f));
  }

  async function migrateOne(node, s) {
    if (!restorable(s.originalFile)) return { ok: false, perm: true, why: 'dùng file cục bộ trên máy đã chết, không thể tự chuyển' };
    let minutes = s.minutes || 0;
    if (minutes > 0 && s.firstLiveTime) {
      const left = Math.ceil(minutes - (Date.now() - new Date(s.firstLiveTime).getTime()) / 60000);
      if (left <= 0) return { ok: false, perm: true, why: 'đã hết thời lượng phát' };
      minutes = left;
    }
    if (s.mode === 'scheduled') {
      const t = new Date(s.scheduledTime).getTime();
      if (!isNaN(t) && t <= Date.now()) return { ok: false, perm: true, why: 'đã quá giờ hẹn' };
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
    if (survivors.length === 0) return { ok: false, perm: true, why: 'máy chủ duy nhất được phép dùng đã chết' };
    const dec = await cm.selectOptimalNode(survivors, ctx.getLocalSysinfo());
    if (!dec || dec.full || !dec.nodeId) return { ok: false, why: (dec && dec.reason) || 'không còn máy chủ phù hợp' };
    if (dec.nodeId === node.id) return { ok: false, perm: true, why: 'máy chủ duy nhất được phép dùng đã chết' };

    const body = {
      key: s.key, file: s.originalFile, mode: s.mode, minutes, scheduledTime: s.scheduledTime,
      scheduledMode: s.scheduledMode, name: s.name, youtubeUrl: s.youtubeUrl,
      ownerId: s.ownerId, ownerUsername: s.ownerUsername, serverId: dec.nodeId
    };
    const res = dec.nodeId === ctx.localNodeId()
      ? ctx.startStream(body)
      : await cm.forwardStreamAction(dec.nodeId, 'start', body);
    if (!res || res.error) return { ok: false, why: (res && res.error) || 'không khởi chạy được' };
    return { ok: true, newServerId: dec.nodeId, newId: res.id, minutesLeft: minutes, reason: dec.reason };
  }

  async function migrateNode(node) {
    const snap = snaps.get(node.id);
    const list = (snap && snap.streams) || [];
    const downSec = downSince.has(node.id) ? Math.round((Date.now() - downSince.get(node.id)) / 1000) : Math.round(AFTER_MS / 1000);
    const me = cm.getNode(ctx.localNodeId());
    migrated.set(node.id, []);   // đánh dấu đã xử lý ngay để không chuyển lặp
    persist();
    console.warn(`[Failover] 🚨 ${node.name} mất kết nối quá ${Math.round(AFTER_MS / 1000)}s. Chuyển ${list.length} luồng sang máy còn sống...`);
    const title = node.isMaster
      ? `🚨 *MASTER ${esc(node.name)} MẤT KẾT NỐI — WORKER TIẾP QUẢN*`
      : `🚨 *WORKER ${esc(node.name)} MẤT KẾT NỐI — TỰ ĐỘNG CHUYỂN LUỒNG*`;
    const head = [
      title, LINE,
      `🕒 Thời gian: \`${nowVN()}\``,
      `🔌 Máy sự cố: *${esc(node.name)}*${roleTag(node)} — \`${esc(node.ip)}:${node.port || 3131}\``,
      `⏱️ Mất kết nối: *${downSec}s* (ngưỡng ${Math.round(AFTER_MS / 1000)}s)`,
      `🖥️ Máy xử lý: *${esc(nameOf(ctx.localNodeId()))}*${roleTag(me)}`,
    ];
    if (list.length === 0) { notify(head.concat(['', 'ℹ️ Không có luồng đang chạy cần chuyển.']).join('\n')); return; }
    const okLines = [], failLines = [];
    const recs = [];
    for (const s of list) {
      let r;
      try { r = await migrateOne(node, s); } catch (e) { r = { ok: false, why: e.message }; }
      report({ node: node.id, streamId: s.id, name: s.name, event: 'migrate', ...r });
      if (r.ok) {
        recs.push({ origId: s.id, newServerId: r.newServerId, newId: r.newId, key: s.key, name: s.name });
        const left = r.minutesLeft > 0 ? `, còn *${r.minutesLeft}* phút` : '';
        okLines.push(`✅ ${streamLabel(s)}\n    ${esc(node.name)} → *${esc(nameOf(r.newServerId))}* (luồng mới #${r.newId}${left})`);
      } else {
        failLines.push(`❌ ${streamLabel(s)}\n    Lý do: ${esc(r.why)}${r.perm ? '' : ' (sẽ tự thử lại)'}`);
        if (!r.perm) { if (!retryQ.has(node.id)) retryQ.set(node.id, []); retryQ.get(node.id).push({ s, tries: 1, lastTry: Date.now() }); }
      }
    }
    migrated.set(node.id, recs);
    persist();
    const lines = head.concat([`📊 Kết quả: ✅ *${okLines.length}* thành công | ❌ *${failLines.length}* thất bại / tổng *${list.length}* luồng`]);
    if (okLines.length) lines.push('', ...okLines);
    if (failLines.length) lines.push('', ...failLines);
    lines.push('', `💡 Khi ${esc(node.name)} hoạt động lại, bản cũ sẽ tự động bị dừng để tránh trùng Stream Key.`);
    notify(lines.join('\n'));
  }

  // Worker đóng vai trò dự phòng cho Master: chỉ Worker có id nhỏ nhất còn sống mới tiếp quản (tránh 2 máy cùng chuyển luồng)
  async function onMasterDown(master, me) {
    if (!downSince.has(master.id)) downSince.set(master.id, Date.now());
    const down = Date.now() - downSince.get(master.id);
    if (down < AFTER_MS) return;
    if (migrated.has(master.id)) { await retryPending(master); return; }
    if (!(await selfOnline())) { console.warn(`[Failover] ⚠️ Master ${master.name} không phản hồi nhưng máy này cũng mất mạng ra ngoài → không tiếp quản (tránh chạy trùng key)`); return; }
    for (const n of cm.getNodes()) {
      if (n.isMaster || n.isLocal || String(n.id) >= String(me.id)) continue;
      if (await probe(n)) return; // có Worker ưu tiên cao hơn còn sống -> để máy đó xử lý
    }
    // Quorum chống split-brain: hỏi các Worker còn sống khác xem họ có thấy Master chết không
    let total = 1, votes = 1;
    for (const n of cm.getNodes()) {
      if (n.isMaster || n.isLocal || n.id === me.id) continue;
      if (!(await probe(n))) continue;
      total++;
      try {
        const r = await cm.callNodeApi(n, '/api/cluster/failover', 'GET', null, 4000);
        if (r && r.statusCode === 200 && r.data && r.data.down && r.data.down[master.id] !== undefined) votes++;
      } catch (_) { total--; }
    }
    if (votes * 2 <= total) { console.warn(`[Failover] ⚠️ Chỉ ${votes}/${total} Worker thấy Master ${master.name} chết → chưa đủ đa số, không tiếp quản`); return; }
    console.warn(`[Failover] 🚨 Master ${master.name} chết (${votes}/${total} Worker đồng thuận), ${me.name} tiếp quản điều phối luồng.`);
    await migrateNode(master);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const me = cm.getNode(ctx.localNodeId());
      if (!me) return;
      if (!me.isMaster) {
        const master = cm.getNodes().find(n => n.isMaster && !n.isLocal);
        if (!master) return;
        if (await probe(master)) {
          if (downSince.has(master.id)) downSince.delete(master.id);
          await onUp(master);
        } else {
          await onMasterDown(master, me);
        }
        return;
      }
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
  console.log(`[Failover] Bật tự động chuyển luồng khi máy chết (sau ${Math.round(AFTER_MS / 1000)}s mất kết nối; Master điều phối Worker, Worker id nhỏ nhất dự phòng cho Master${NET_URL ? '' : '; tắt kiểm tra mạng'})`);

  return {
    tick,
    selfOnline,
    getState: () => ({
      afterSec: Math.round(AFTER_MS / 1000),
      down: Object.fromEntries(Array.from(downSince.entries()).map(([k, v]) => [k, Math.round((Date.now() - v) / 1000)])),
      snapshots: Object.fromEntries(Array.from(snaps.entries()).map(([k, v]) => [k, { at: v.at, streams: v.streams.length }])),
      migrated: Object.fromEntries(migrated),
      pendingRetry: Object.fromEntries(Array.from(retryQ.entries()).map(([k, v]) => [k, v.map(x => ({ id: x.s.id, name: x.s.name, tries: x.tries }))])),
      reports: reports.slice(-50)
    })
  };
}

module.exports = { init };
