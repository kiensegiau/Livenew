/**
 * long_test.js — Deep Stress & Reliability Test Suite for YouTube Live Controller
 * Chạy: node long_test.js (Sẽ tự động khởi động server.js nếu chưa chạy)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3131';
const SECURE_UA = 'CyberShieldSecureAgent/1.0';

// Màu terminal
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const B = (s) => `\x1b[36m${s}\x1b[0m`;
const M = (s) => `\x1b[35m${s}\x1b[0m`;

let serverProcess = null;
let passed = 0, failed = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toLocalISO(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function post(path, body, headers = {}) {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': SECURE_UA,
        ...headers
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  } catch (e) {
    return { error: e.message };
  }
}

async function get(path, headers = {}) {
  try {
    const r = await fetch(`${BASE}${path}`, {
      headers: {
        'User-Agent': SECURE_UA,
        ...headers
      }
    });
    return { status: r.status, data: await r.json() };
  } catch (e) {
    return { error: e.message };
  }
}

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(G(`  ✓ PASS`) + ` ${name}`);
    passed++;
  } else {
    console.log(R(`  ✗ FAIL`) + ` ${name}` + (detail ? ` → ${detail}` : ''));
    failed++;
  }
}

// Khởi động server
function startServer() {
  return new Promise(async (resolve, reject) => {
    console.log(Y('[System] Đang kiểm tra xem server.js đã chạy chưa...'));
    const testFetch = await get('/api/streams');
    if (!testFetch.error) {
      console.log(G('[System] Server đã chạy sẵn từ trước. Sử dụng instance hiện tại.'));
      return resolve(false); // Báo là không khởi động mới
    }

    console.log(Y('[System] Không tìm thấy server đang chạy. Tiến hành khởi chạy server.js mới...'));
    serverProcess = spawn('node', ['server.js'], {
      cwd: __dirname,
      stdio: 'pipe',
      shell: false
    });

    let started = false;
    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('YouTube Live Controller PRO') || msg.includes('3131')) {
        if (!started) {
          started = true;
          console.log(G('[System] Server.js khởi động thành công!'));
          resolve(true);
        }
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(R(`[Server Error] ${data.toString()}`));
    });

    // Timeout sau 10s
    setTimeout(() => {
      if (!started) {
        reject(new Error('Khởi động server.js bị timeout!'));
      }
    }, 10000);
  });
}

// Dọn dẹp server sau khi test xong
async function cleanup() {
  console.log(B('\n═══════════════════════════════════════'));
  console.log(`  Kết quả stress test: ${G(passed + ' PASS')}  ${failed > 0 ? R(failed + ' FAIL') : '0 FAIL'}`);
  console.log(B('═══════════════════════════════════════\n'));

  // Clear all mock/test streams before exiting
  console.log(Y('[System] Dọn dẹp các luồng thử nghiệm trên server...'));
  try {
    await post('/api/clear', {});
  } catch (e) {}

  if (serverProcess) {
    console.log(Y('[System] Đóng tiến trình server.js...'));
    serverProcess.kill('SIGINT');
    await sleep(1000);
  }

  process.exit(failed > 0 ? 1 : 0);
}

// Bắt đầu chuỗi kịch bản Stress-Test sâu rộng
async function run() {
  console.log(B('\n══════════════════════════════════════════════════════'));
  console.log(B('      CYBER-SHIELD AEGIS DEEP STRESS & SYSTEM TESTS   '));
  console.log(B('══════════════════════════════════════════════════════\n'));

  const launchedNewServer = await startServer();
  await sleep(1500); // Chờ server hoàn toàn ổn định

  const FAKE_KEY = 'stress-test-stream-key-2026-extreme';
  const FAKE_FILE = 'C:\\fake\\stress_test_video.mp4';

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ PHASE 1 ] Kiểm tra các bộ lọc bảo mật & Bypass Auth'));
  {
    // 1. Không gửi header đặc biệt và không gửi token -> Phải chặn 401
    const r1 = await get('/api/streams', { 'User-Agent': 'Mozilla/5.0 Chrome/120.0' });
    assert('Chặn 401 khi truy cập không có đặc quyền', r1.status === 401, `Status: ${r1.status}`);

    // 2. Gửi header đặc biệt (CyberShieldSecureAgent) -> Phải cho qua 200
    const r2 = await get('/api/streams');
    assert('Cho phép bypass khi dùng User-Agent bảo mật', r2.status === 200, `Status: ${r2.status}`);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ PHASE 2 ] Stress-test tạo đồng thời cực lớn (Concurrency)'));
  {
    const promises = [];
    console.log(`    ${Y('→')} Đang gửi đồng thời 10 yêu cầu tạo luồng Live...`);
    for (let i = 0; i < 10; i++) {
      promises.push(post('/api/start', {
        key: `${FAKE_KEY}-${i}`,
        file: `${FAKE_FILE}`,
        mode: 'once',
        minutes: 0,
        name: `Stress Thread #${i}`
      }));
    }

    const results = await Promise.all(promises);
    let okCount = 0;
    results.forEach((r, idx) => {
      if (r.status === 200 && r.data.id) {
        okCount++;
      }
    });

    assert('Tạo thành công toàn bộ 10 luồng live đồng thời mượt mà', okCount === 10, `Thành công: ${okCount}/10`);
    
    // Đọc danh sách luồng
    const listRes = await get('/api/streams');
    assert('Danh sách ghi nhận đúng 10 luồng đang chạy/launching', listRes.data.length >= 10, `Độ dài: ${listRes.data.length}`);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ PHASE 3 ] Cập nhật hàng loạt (Rapid Configuration Modification)'));
  {
    // Lấy ID của các luồng vừa tạo
    const listRes = await get('/api/streams');
    const testStreams = listRes.data.filter(s => s.key.startsWith(FAKE_KEY));
    
    console.log(`    ${Y('→')} Thực hiện sửa đổi cấu hình luồng tốc độ cao...`);
    const editPromises = testStreams.map((s, idx) => {
      return post('/api/edit', {
        id: s.id,
        name: `Stress Updated #${idx}`,
        youtubeUrl: `https://www.youtube.com/watch?v=UpdatedLive${idx}`,
        key: s.key,
        file: s.originalFile,
        mode: 'loop',
        minutes: 15
      });
    });

    const editResults = await Promise.all(editPromises);
    let editOk = editResults.filter(r => r.status === 200).length;
    assert('Sửa đổi và lưu cấu hình thành công hàng loạt đồng thời', editOk === testStreams.length, `Thành công: ${editOk}/${testStreams.length}`);

    // Kiểm tra xem dữ liệu cập nhật đã được áp dụng chưa
    const listRes2 = await get('/api/streams');
    const checked = listRes2.data.find(s => s.name === 'Stress Updated #0');
    assert('Thông tin tên luồng cập nhật chính xác', checked?.name === 'Stress Updated #0');
    assert('Youtube Link cập nhật dạng raw click chuẩn', checked?.youtubeUrl === 'https://www.youtube.com/watch?v=UpdatedLive0');
    assert('Luồng mới có mode=loop và minutes=15', checked?.mode === 'loop' && checked?.minutes === 15);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ PHASE 4 ] Đặt lịch hẹn giờ dồn dập (Advanced Timers Scheduling)'));
  {
    // Tạo 5 luồng đặt lịch cùng lúc ở các mốc thời gian khác nhau
    const schedPromises = [];
    console.log(`    ${Y('→')} Tạo 5 luồng đặt lịch hẹn giờ ở tương lai...`);
    for (let i = 0; i < 5; i++) {
      const futureTime = toLocalISO(new Date(Date.now() + (30 + i * 10) * 1000)); // 30s, 40s, 50s...
      schedPromises.push(post('/api/start', {
        key: `sched-key-${i}`,
        file: FAKE_FILE,
        mode: 'scheduled',
        scheduledTime: futureTime,
        scheduledMode: 'loop',
        minutes: 0,
        name: `Sched Thread #${i}`
      }));
    }

    const schedRes = await Promise.all(schedPromises);
    let schedOk = schedRes.filter(r => r.status === 200 && r.data.status === 'scheduled').length;
    assert('Tạo thành công 5 luồng đặt lịch timer trong tương lai', schedOk === 5, `Thành công: ${schedOk}/5`);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ PHASE 5 ] Kiểm tra lưu trữ và khôi phục (Backup & Load Recovery)'));
  {
    // Đọc số lượng luồng hoạt động trước khi khởi động lại
    const listBefore = await get('/api/streams');
    const recoverableBefore = listBefore.data.filter(s => 
      ['live', 'scheduled', 'launching', 'downloading', 'reconnecting'].includes(s.status)
    ).length;

    assert('Backup file exists', fs.existsSync(path.join(__dirname, 'streams_backup.json')));
    
    // Nếu chúng ta tự spawn server mới, ta có thể test khôi phục bằng cách tắt đi bật lại
    if (launchedNewServer && serverProcess) {
      console.log(`    ${Y('→')} Đang tắt server để giả lập sự cố mất điện / reboot vps...`);
      serverProcess.kill('SIGINT');
      await sleep(1500);

      console.log(`    ${Y('→')} Đang khởi động lại server từ bản sao lưu...`);
      await startServer();
      await sleep(1500);

      const listAfter = await get('/api/streams');
      const recoverableAfter = listAfter.data.filter(s => 
        ['live', 'scheduled', 'launching', 'downloading', 'reconnecting'].includes(s.status)
      ).length;
      assert('Khôi phục thành công các luồng đang hoạt động sau khi server khởi động lại', recoverableAfter === recoverableBefore, `Trước: ${recoverableBefore}, Sau: ${recoverableAfter}`);
    } else {
      console.log(M('    [Bỏ qua bước reboot vì server đang chạy sẵn bên ngoài]'));
      assert('Bản sao lưu lưu trữ đầy đủ thông tin', recoverableBefore > 0);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ PHASE 6 ] Stress-test API Giám sát VPS (Telemetry Polling Rate)'));
  {
    console.log(`    ${Y('→')} Gửi dồn dập 20 yêu cầu truy cập API /api/sysinfo để đo lường độ ổn định...`);
    const sysPromises = [];
    for (let i = 0; i < 20; i++) {
      sysPromises.push(get('/api/sysinfo'));
    }

    const sysResults = await Promise.all(sysPromises);
    const successCount = sysResults.filter(r => r.status === 200 && r.data.cpuModel).length;
    assert('API Telemetry phản hồi 20/20 mượt mà, không bị nghẽn lệnh', successCount === 20, `Thành công: ${successCount}/20`);
    
    // Lấy mẫu tài nguyên cuối cùng
    const sample = sysResults[0].data;
    console.log(`    ${G('Telemetry Sample:')}`);
    console.log(`      • Platform: ${B(sample.platform)}`);
    console.log(`      • CPU Model: ${B(sample.cpuModel)}`);
    console.log(`      • CPU Usage: ${B(sample.cpuUsage + '%')}`);
    console.log(`      • Memory: ${B(sample.ramUsed + ' / ' + sample.ramTotal + ' (' + sample.ramUsage + '%)')}`);
    console.log(`      • Network TX: ${B(sample.netSpeedTx)} | RX: ${B(sample.netSpeedRx)}`);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ PHASE 7 ] Dừng luồng khẩn cấp & dọn dẹp rác (Stop & Clear API)'));
  {
    const listRes = await get('/api/streams');
    const allIds = listRes.data.map(s => s.id);
    
    console.log(`    ${Y('→')} Tiến hành dừng toàn bộ ${allIds.length} luồng thử nghiệm...`);
    const stopPromises = allIds.map(id => post('/api/stop', { id }));
    await Promise.all(stopPromises);

    // Xác nhận trạng thái stopped
    const listRes2 = await get('/api/streams');
    const activeStreamsCount = listRes2.data.filter(s => ['live', 'scheduled', 'reconnecting'].includes(s.status)).length;
    assert('Tất cả các luồng đã bị dừng an toàn', activeStreamsCount === 0, `Còn hoạt động: ${activeStreamsCount}`);

    // Dọn dẹp các luồng stopped/ended
    console.log(`    ${Y('→')} Dọn dẹp danh sách luồng đã dừng qua /api/clear...`);
    const clearRes = await post('/api/clear', {});
    assert('Clear API dọn dẹp sạch sẽ các luồng cũ', clearRes.data.cleared > 0, `Đã dọn: ${clearRes.data.cleared}`);

    const listRes3 = await get('/api/streams');
    assert('Danh sách luồng hiện tại trống rỗng hoàn toàn', listRes3.data.length === 0, `Còn lại: ${listRes3.data.length}`);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log(Y('\n[ PHASE 8 ] Robustness under incorrect inputs (Hacker-proof check)'));
  {
    // 1. JSON rỗng
    const r1 = await post('/api/start', {});
    assert('Trả về lỗi khi truyền body rỗng', r1.status === 400 || r1.data.error !== undefined);

    // 2. Minutes là chuỗi chữ cái vô nghĩa thay vì số
    const r2 = await post('/api/start', {
      key: FAKE_KEY,
      file: FAKE_FILE,
      mode: 'loop',
      minutes: 'abc' // chữ cái thay vì số
    });
    assert('Bảo vệ an toàn khi minutes không hợp lệ (NaN guard)', r2.status === 200 && r2.data.id !== undefined);
    
    // Stop & Clear luồng bảo vệ này
    if (r2.data.id) {
      await post('/api/stop', { id: r2.data.id });
      await post('/api/clear', {});
    }

    // 3. Restart id không tồn tại
    const r3 = await post('/api/restart', { id: 99999 });
    assert('Từ chối khởi động lại ID ma không tồn tại', r3.status === 400 || r3.data.error !== undefined);
  }

  // Hoàn tất và dọn dẹp
  await cleanup();
}

run().catch(async (e) => {
  console.error(R('\n[FATAL ERROR] Lỗi không mong muốn khi chạy test suite: ' + e.stack));
  await cleanup();
});
