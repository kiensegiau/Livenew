const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const B = (s) => `\x1b[36m${s}\x1b[0m`;

console.log(B('\n══════════════════════════════════════════════════'));
console.log(B('  TEST ĐỘC LẬP & TỰ PHỤC HỒI LUỒNG SONG SONG (A+B)'));
console.log(B('══════════════════════════════════════════════════\n'));

const VIDEO_FILE = path.join(__dirname, 'videos', '0503(1).mp4');
if (!fs.existsSync(VIDEO_FILE)) {
  console.error(R(`❌ Không tìm thấy file video kiểm thử tại: ${VIDEO_FILE}`));
  process.exit(1);
}

let serverA = null;
let serverB = null;

let connACount = 0;
let connBCount = 0;

let dataAReceived = 0;
let dataBReceived = 0;

let activeSocketA = null;

// Tạo Mock TCP Server cho Luồng A
function startServerA() {
  serverA = net.createServer((socket) => {
    connACount++;
    activeSocketA = socket;
    console.log(G(`[Server A] 🔌 Đã kết nối thành công! (Lần kết nối thứ: ${connACount})`));
    socket.on('data', (data) => {
      dataAReceived += data.length;
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      console.log(Y(`[Server A] ❌ Đã đóng socket.`));
    });
  });
  serverA.listen(19350, '127.0.0.1', () => {
    console.log(`[Server A] 🇺🇸 Đang lắng nghe tại tcp://127.0.0.1:19350`);
  });
}

// Tạo Mock TCP Server cho Luồng B
function startServerB() {
  serverB = net.createServer((socket) => {
    connBCount++;
    console.log(G(`[Server B] 🇸🇬 Đã kết nối thành công! (Lần kết nối thứ: ${connBCount})`));
    socket.on('data', (data) => {
      dataBReceived += data.length;
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      console.log(Y(`[Server B] ❌ Đã đóng socket.`));
    });
  });
  serverB.listen(19351, '127.0.0.1', () => {
    console.log(`[Server B] 🇸🇬 Đang lắng nghe tại tcp://127.0.0.1:19351`);
  });
}

// Khởi chạy cả 2 Server ban đầu
startServerA();
startServerB();

// Đợi server khởi động
setTimeout(() => {
  console.log(Y('\n🎬 Khởi chạy FFmpeg song song A+B với bộ trộn FIFO...'));
  
  // Tham số tee + fifo + recover_any_error=1
  const rtmpA = `[f=fifo:fifo_format=mpegts:drop_pkts_on_overflow=1:attempt_recovery=1:recovery_wait_time=2:recover_any_error=1:onfail=ignore]tcp://127.0.0.1:19350`;
  const rtmpB = `[f=fifo:fifo_format=mpegts:drop_pkts_on_overflow=1:attempt_recovery=1:recovery_wait_time=2:recover_any_error=1:onfail=ignore]tcp://127.0.0.1:19351`;
  
  const args = [
    '-re',
    '-i', VIDEO_FILE,
    '-t', '25', // Test trong 25 giây
    '-map', '0',
    '-c', 'copy',
    '-f', 'tee',
    `${rtmpA}|${rtmpB}`
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  proc.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line.includes('Slave') || line.includes('fifo') || line.includes('tee') || line.includes('failed') || line.includes('recovery')) {
      console.log(B(`[FFmpeg Log] ${line}`));
    }
  });

  proc.on('close', (code) => {
    console.log(B('\n═══════════════════════════════════════'));
    console.log(`  Kết quả Test:`);
    console.log(`  - Luồng A nhận: ${(dataAReceived / 1024 / 1024).toFixed(2)} MB (Số lần kết nối: ${connACount})`);
    console.log(`  - Luồng B nhận: ${(dataBReceived / 1024 / 1024).toFixed(2)} MB (Số lần kết nối: ${connBCount})`);
    
    // Luồng B phải nhận liên tục dữ liệu (> 0), Luồng A phải kết nối lại thành công (connACount >= 2)
    const passed = connACount >= 2 && dataBReceived > 0 && dataAReceived > 0;
    if (passed) {
      console.log(G(`  ✓ TẤT CẢ KIỂM THỬ ĐÃ THÀNH CÔNG! HỆ THỐNG TỰ PHỤC HỒI HOÀN HẢO 100%!`));
    } else {
      console.log(R(`  ✗ KIỂM THỬ THẤT BẠI.`));
    }
    console.log(B('═══════════════════════════════════════\n'));
    
    if (serverA) { try { serverA.close(); } catch(_) {} }
    if (serverB) { try { serverB.close(); } catch(_) {} }
    process.exit(passed ? 0 : 1);
  });

  // --- KỊCH BẢN THỬ THÁCH MẠNG ---
  
  // 1. Sau 5 giây: Ngắt socket A và đóng Server A (Luồng A sập kết nối)
  setTimeout(() => {
    console.log(R('\n⚡ [MẠNG ĐỨT] Ngắt kết nối Máy chủ A (Primary)...'));
    if (activeSocketA) {
      activeSocketA.destroy();
    }
    if (serverA) {
      serverA.close(() => {
        console.log(R('[Server A] 🔴 Đã dừng lắng nghe.'));
      });
    }
  }, 5000);

  // 2. Sau 12 giây: Bật lại Server A (Mạng khôi phục cho Luồng A)
  setTimeout(() => {
    console.log(G('\n⚡ [MẠNG KHÔI PHỤC] Khởi động lại Máy chủ A. Chờ bộ trộn FIFO tự động phục hồi...'));
    startServerA();
  }, 12000);

}, 1000);
