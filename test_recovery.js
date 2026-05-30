const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const B = (s) => `\x1b[36m${s}\x1b[0m`;

console.log(B('\n══════════════════════════════════════════════════'));
console.log(B('  KIỂM THỬ KHẢ NĂNG PHỤC HỒI LIÊN TỤC CỦA FIFO MUXER'));
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
let activeSocketB = null;

// Tạo Mock TCP Server cho Luồng A
function startServerA() {
  serverA = net.createServer((socket) => {
    connACount++;
    activeSocketA = socket;
    console.log(G(`[Server A] 🔌 Đã thiết lập kết nối thành công! (Lần kết nối thứ: ${connACount})`));
    socket.on('data', (data) => {
      dataAReceived += data.length;
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      console.log(Y(`[Server A] ❌ Đã ngắt socket kết nối.`));
    });
  });
  serverA.listen(19350, '127.0.0.1', () => {
    console.log(`[Server A] 🇺🇸 Đang sẵn sàng lắng nghe tại tcp://127.0.0.1:19350`);
  });
}

// Tạo Mock TCP Server cho Luồng B
function startServerB() {
  serverB = net.createServer((socket) => {
    connBCount++;
    activeSocketB = socket;
    console.log(G(`[Server B] 🇸🇬 Đã thiết lập kết nối thành công! (Lần kết nối thứ: ${connBCount})`));
    socket.on('data', (data) => {
      dataBReceived += data.length;
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      console.log(Y(`[Server B] ❌ Đã ngắt socket kết nối.`));
    });
  });
  serverB.listen(19351, '127.0.0.1', () => {
    console.log(`[Server B] 🇸🇬 Đang sẵn sàng lắng nghe tại tcp://127.0.0.1:19351`);
  });
}

// Khởi chạy cả 2 Server ban đầu
startServerA();
startServerB();

// Đợi server khởi động
setTimeout(() => {
  console.log(Y('\n🎬 Khởi chạy FFmpeg song song A+B với bộ trộn đệm FIFO thực tế...'));
  
  // Tham số tee + fifo + recover_any_error=1
  // Sử dụng format=mpegts với cấu hình phục hồi chặt chẽ
  const rtmpA = `[f=fifo:fifo_format=mpegts:drop_pkts_on_overflow=1:attempt_recovery=1:recovery_wait_time=2:recover_any_error=1:onfail=ignore]tcp://127.0.0.1:19350`;
  const rtmpB = `[f=fifo:fifo_format=mpegts:drop_pkts_on_overflow=1:attempt_recovery=1:recovery_wait_time=2:recover_any_error=1:onfail=ignore]tcp://127.0.0.1:19351`;
  
  // Thực hiện transcode siêu nhẹ (ultrafast) để tránh lỗi bitstream filter H.264 AnnexB cũ khi reconnection trên TCP
  const args = [
    '-re',
    '-i', VIDEO_FILE,
    '-t', '22', // Test trong 22 giây
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-c:a', 'aac',
    '-f', 'tee',
    `${rtmpA}|${rtmpB}`
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  proc.stderr.on('data', (d) => {
    const line = d.toString().trim();
    // In các dòng log liên quan đến kết nối và khôi phục của FIFO/TEE
    if (line.includes('Slave') || line.includes('fifo') || line.includes('tee') || line.includes('failed') || line.includes('recovery') || line.includes('successful')) {
      console.log(B(`[FFmpeg Log] ${line}`));
    }
  });

  proc.on('close', (code) => {
    console.log(B('\n═══════════════════════════════════════'));
    console.log(`  BÁO CÁO KẾT QUẢ KIỂM THỬ PHỤC HỒI CHI TIẾT:`);
    console.log(`  - Luồng A (Primary):`);
    console.log(`    ├─ Tổng số lần kết nối: ${connACount} lần (Mong muốn: 2 lần - 1 trước đứt, 1 sau phục hồi)`);
    console.log(`    └─ Lưu lượng nhận: ${(dataAReceived / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  - Luồng B (Backup):`);
    console.log(`    ├─ Tổng số lần kết nối: ${connBCount} lần (Mong muốn: 1 lần duy nhất - Không bao giờ đứt)`);
    console.log(`    └─ Lưu lượng nhận: ${(dataBReceived / 1024 / 1024).toFixed(2)} MB`);
    
    // Đánh giá: Luồng B chạy liên tục không đứt (connBCount === 1), Luồng A kết nối lại thành công sau sập (connACount === 2)
    const passed = connACount === 2 && connBCount === 1 && dataAReceived > 0 && dataBReceived > 0;
    
    if (passed) {
      console.log(G(`  ✓ XÁC NHẬN: LUỒNG B KHÔNG BỊ ẢNH HƯỞNG & LUỒNG A PHỤC HỒI THÀNH CÔNG DUY NHẤT 1 LẦN VÀ ỔN ĐỊNH!`));
      console.log(G(`  ✓ HỆ THỐNG TỰ PHỤC HỒI (SELF-HEALING) ĐẠT TIÊU CHUẨN 100/100 ĐIỂM!`));
    } else {
      console.log(R(`  ✗ KIỂM THỬ CHƯA ĐẠT TIÊU CHUẨN ĐỐI XỨNG TUYỆT ĐỐI (Lần kết nối A: ${connACount}, B: ${connBCount})`));
    }
    console.log(B('═══════════════════════════════════════\n'));
    
    if (serverA) { try { serverA.close(); } catch(_) {} }
    if (serverB) { try { serverB.close(); } catch(_) {} }
    process.exit(passed ? 0 : 1);
  });

  // --- KỊCH BẢN THỬ THÁCH MẠNG CHI TIẾT ---
  
  // 1. Sau 5 giây: Ngắt socket A và đóng Server A hoàn toàn (Luồng A đứt mạng)
  setTimeout(() => {
    console.log(R('\n⚡ [SỰ CỐ] Đột ngột ngắt kết nối và đóng Máy chủ A (Primary)...'));
    if (activeSocketA) {
      activeSocketA.destroy();
    }
    if (serverA) {
      serverA.close(() => {
        console.log(R('[Server A] 🔴 Đã ngừng lắng nghe cổng 19350.'));
      });
    }
  }, 5000);

  // 2. Sau 12 giây: Mở lại Server A (Mạng khôi phục cho Luồng A)
  setTimeout(() => {
    console.log(G('\n⚡ [PHỤC HỒI] Khởi động lại Máy chủ A. Chờ bộ đệm FIFO tự động kết nối lại...'));
    startServerA();
  }, 12000);

}, 1000);
