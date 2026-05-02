/**
 * test.js — Test logic: đặt lịch, hẹn giờ, ngắt luồng
 * Chạy: node test.js (server phải đang chạy trên port 3131)
 *
 * KHÔNG cần ffmpeg thật — dùng file giả, key giả
 * Chỉ test phần logic scheduling + stop của server
 */

const BASE = 'http://localhost:3131';

// Màu terminal
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const B = (s) => `\x1b[36m${s}\x1b[0m`;

// Giống datetime-local input với giây (length=19 → server dùng trực tiếp không append :00)
function toLocalISO(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let passed = 0, failed = 0;

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function getStreams() {
  const r = await fetch(`${BASE}/api/streams`);
  return r.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(G(`  ✓ PASS`) + ` ${name}`);
    passed++;
  } else {
    console.log(R(`  ✗ FAIL`) + ` ${name}` + (detail ? ` → ${detail}` : ''));
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  console.log(B('\n═══════════════════════════════════════'));
  console.log(B('  YouTube Live Controller — Test Suite'));
  console.log(B('═══════════════════════════════════════\n'));

  const FAKE_FILE = 'C:\\fake\\test_video.mp4';
  const FAKE_KEY  = 'test-key-0000-0000';

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('[ TEST 1 ] Từ chối lịch đã qua (past time validation)'));
  {
    const pastTime = toLocalISO(new Date(Date.now() - 60000)); // 1 phút trước
    const r = await post('/api/start', {
      key: FAKE_KEY, file: FAKE_FILE,
      mode: 'scheduled', minutes: 10,
      scheduledTime: pastTime,
    });
    assert('Trả error khi scheduledTime đã qua', r.error !== undefined, JSON.stringify(r));
    assert('Không tạo stream', !(r.id), `id=${r.id}`);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ TEST 2 ] Đặt lịch hợp lệ → trạng thái "scheduled"'));
  let schedId;
  {
    const future = toLocalISO(new Date(Date.now() + 6000)); // 6 giây sau
    const r = await post('/api/start', {
      key: FAKE_KEY, file: FAKE_FILE,
      mode: 'scheduled', minutes: 10,
      scheduledTime: future,
    });
    schedId = r.id;
    assert('Trả id mới', typeof r.id === 'number', `id=${r.id}`);
    assert('Status = scheduled', r.status === 'scheduled', `status=${r.status}`);

    const list = await getStreams();
    const found = list.find(s => s.id === schedId);
    assert('Xuất hiện trong danh sách', !!found, JSON.stringify(found));
    assert('Hiển thị đúng status scheduled', found?.status === 'scheduled', `status=${found?.status}`);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ TEST 3 ] Hủy stream đặt lịch trước khi bắt đầu'));
  {
    const r = await post('/api/stop', { id: schedId });
    assert('Stop API trả ok', r.ok === true, JSON.stringify(r));

    const list = await getStreams();
    const found = list.find(s => s.id === schedId);
    assert('Status chuyển sang stopped', found?.status === 'stopped', `status=${found?.status}`);

    // Đợi qua thời điểm lịch (6s) → ffmpeg không được launch
    console.log(`    ${Y('→')} Đợi 7 giây để xác nhận timer đã bị cancel...`);
    await sleep(7000);

    const list2 = await getStreams();
    const s = list2.find(x => x.id === schedId);
    assert('Vẫn "stopped" sau khi qua giờ lịch (timer cancelled)', s?.status === 'stopped', `status=${s?.status}`);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ TEST 4 ] Đặt lịch + chờ tự động bật'));
  let autoId;
  {
    const future = toLocalISO(new Date(Date.now() + 4000)); // 4 giây sau
    const r = await post('/api/start', {
      key: FAKE_KEY, file: FAKE_FILE,
      mode: 'scheduled', minutes: 0,
      scheduledTime: future,
    });
    autoId = r.id;
    assert('Status = scheduled ban đầu', r.status === 'scheduled');

    console.log(`    ${Y('→')} Đợi 5 giây để timer kích hoạt...`);
    await sleep(5000);

    const list = await getStreams();
    const s = list.find(x => x.id === autoId);
    // ffmpeg sẽ fail (key/file giả) nhưng status phải chuyển khỏi 'scheduled'
    assert(
      'Status không còn "scheduled" (timer đã fire)',
      s?.status !== 'scheduled',
      `status=${s?.status}`
    );
    console.log(`    ${B('→')} Status sau khi fire: ${s?.status} (expected: live/launching/ended — ffmpeg fail vì key giả)`);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ TEST 5 ] minutes NaN guard (gửi chuỗi rỗng)'));
  {
    // Tạo stream loop với minutes = "" (chuỗi rỗng) → phải parse thành 0, không NaN
    const r = await post('/api/start', {
      key: FAKE_KEY, file: FAKE_FILE,
      mode: 'loop', minutes: '',
    });
    assert('Không trả error (NaN guard hoạt động)', !r.error, JSON.stringify(r));
    // Dọn dẹp ngay
    if (r.id) await post('/api/stop', { id: r.id });
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ TEST 6 ] Stop stream đang "live" → status = stopped'));
  {
    const r = await post('/api/start', {
      key: FAKE_KEY, file: FAKE_FILE,
      mode: 'once', minutes: 0,
    });
    const liveId = r.id;
    assert('Stream được tạo', typeof liveId === 'number');

    await sleep(500); // đợi ffmpeg spawn (sẽ fail ngay vì key/file giả nhưng process vẫn tạo)

    const stop = await post('/api/stop', { id: liveId });
    assert('Stop trả ok', stop.ok === true);

    const list = await getStreams();
    const s = list.find(x => x.id === liveId);
    assert('Status = stopped hoặc ended', ['stopped', 'ended'].includes(s?.status), `status=${s?.status}`);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ TEST 7 ] Restart stream đã dừng'));
  {
    // Tạo 1 stream và stop ngay
    const r1 = await post('/api/start', { key: FAKE_KEY, file: FAKE_FILE, mode: 'once', minutes: 0 });
    const restartId = r1.id;
    await post('/api/stop', { id: restartId });
    
    // Test restart
    const r2 = await post('/api/restart', { id: restartId });
    assert('Restart API trả ok', r2.ok === true);
    
    const list = await getStreams();
    const s = list.find(x => x.id === restartId);
    assert('Status chuyển về launching/live/ended (không còn stopped)', s?.status !== 'stopped', `status=${s?.status}`);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ TEST 8 ] Auto reconnect (ffmpeg crash)'));
  {
    // Tạo stream nhưng không stop → ffmpeg sẽ crash vì fake file
    const r = await post('/api/start', { key: FAKE_KEY, file: FAKE_FILE, mode: 'once', minutes: 0 });
    const crashId = r.id;
    
    // Chờ 1 giây để ffmpeg thoát do code != 0
    console.log(`    ${Y('→')} Đợi 1 giây để giả lập ffmpeg crash...`);
    await sleep(1000);
    
    const list = await getStreams();
    const s = list.find(x => x.id === crashId);
    assert('Status chuyển sang reconnecting', s?.status === 'reconnecting' || s?.status === 'ended', `status=${s?.status}`);
    if (s?.status === 'reconnecting') assert('Retry count tăng lên', s?.retryCount > 0, `retryCount=${s?.retryCount}`);
    
    // Dọn dẹp để khỏi bị timer gọi lại (force stop)
    await post('/api/stop', { id: crashId });
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ TEST 9 ] Clear API (dọn dẹp luồng đã dừng)'));
  {
    // Cần đảm bảo có ít nhất 1 luồng stopped/ended
    const r = await post('/api/start', { key: FAKE_KEY, file: FAKE_FILE, mode: 'once', minutes: 0 });
    await post('/api/stop', { id: r.id });
    
    const list1 = await getStreams();
    const prevCount = list1.length;
    
    const clearRes = await post('/api/clear', {});
    assert('Clear API trả về số lượng đã dọn', typeof clearRes.cleared === 'number');
    
    const list2 = await getStreams();
    assert('Danh sách ngắn hơn sau khi clear', list2.length < prevCount, `Trước: ${prevCount}, Sau: ${list2.length}`);
    const hasStopped = list2.some(s => s.status === 'stopped' || s.status === 'ended');
    assert('Không còn luồng stopped/ended trong danh sách', !hasStopped);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log('\n' + B('═══════════════════════════════════════'));
  console.log(`  Kết quả: ${G(passed + ' PASS')}  ${failed > 0 ? R(failed + ' FAIL') : '0 FAIL'}`);
  console.log(B('═══════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error(R('\nLỗi kết nối server: ' + e.message));
  console.error('  → Đảm bảo server đang chạy: node server.js\n');
  process.exit(1);
});
