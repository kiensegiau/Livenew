const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Khai báo các thư mục làm việc
const DIRS = {
  videos: path.join(__dirname, 'videos'),
  music: path.join(__dirname, 'music'),
  outputs: path.join(__dirname, 'outputs'),
  temp: path.join(__dirname, 'temp')
};

// Đảm bảo các thư mục luôn tồn tại
Object.values(DIRS).forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[System] Đã tạo thư mục: ${dir}`);
  }
});

// Hàm trộn ngẫu nhiên mảng
function shuffleArray(array) {
  const newArr = [...array];
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
  }
  return newArr;
}

function runVideoMaker() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║        🎬 AUTO VIDEO MAKER           ║');
  console.log('╚══════════════════════════════════════╝\n');

  // 1. Lọc và lấy ngẫu nhiên 1 video
  const videoFiles = fs.readdirSync(DIRS.videos).filter(f => f.match(/\.(mp4|mov|mkv|avi)$/i));
  if (videoFiles.length === 0) {
    console.error(`❌ LỖI: Không tìm thấy file video nào!`);
    console.log(`👉 Vui lòng copy ít nhất 1 video vào thư mục: ${DIRS.videos}`);
    return;
  }
  const randomVideo = videoFiles[Math.floor(Math.random() * videoFiles.length)];
  const videoPath = path.join(DIRS.videos, randomVideo);
  console.log(`🎞️  Video nền đã chọn: ${randomVideo}`);

  // 2. Lọc và trộn nhạc
  const musicFiles = fs.readdirSync(DIRS.music).filter(f => f.match(/\.(mp3|wav|m4a|aac)$/i));
  if (musicFiles.length === 0) {
    console.error(`❌ LỖI: Không tìm thấy file nhạc nào!`);
    console.log(`👉 Vui lòng copy nhạc vào thư mục: ${DIRS.music}`);
    return;
  }
  
  // Lấy ngẫu nhiên tối đa 25 bài hát
  const shuffledMusic = shuffleArray(musicFiles);
  const selectedMusic = shuffledMusic.slice(0, 25);
  console.log(`🎵 Đã chọn ngẫu nhiên ${selectedMusic.length} bài hát để ghép nối.`);

  // 3. Xây dựng tham số cho FFmpeg Filter Complex
  const args = [
    '-stream_loop', '-1',
    '-i', `"${videoPath}"`
  ];

  // Thêm từng bài nhạc làm input
  selectedMusic.forEach(file => {
    args.push('-i', `"${path.join(DIRS.music, file)}"`);
  });

  // Tạo chuỗi filter_complex
  // Xử lý hình ảnh trước: scale video nền
  let filterStr = `[0:v]scale=1920:1080[vout];`;
  
  // Xử lý âm thanh: nối tất cả audio lại
  for (let i = 1; i <= selectedMusic.length; i++) {
    filterStr += `[${i}:a:0]`;
  }
  filterStr += `concat=n=${selectedMusic.length}:v=0:a=1[aout]`;

  const timestamp = Date.now();
  const outputFileName = `mix_${timestamp}.mp4`;
  const outputPath = path.join(DIRS.outputs, outputFileName);
  
  const localFF = path.join(__dirname, 'ffmpeg.exe');
  const ffmpegCmd = fs.existsSync(localFF) ? `"${localFF}"` : 'ffmpeg';

  args.push(
    '-filter_complex', filterStr,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-b:v', '6800k',
    '-r', '30',
    '-g', '60',
    '-keyint_min', '60',
    '-preset', 'fast',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-y',
    `"${outputPath}"`
  );

  console.log(`\n⏳ Đang tiến hành ghép nối video và âm thanh...`);
  console.log(`(Đang chạy chế độ ép Bitrate 3800k & Tự động cân bằng định dạng Audio)`);
  
  const proc = spawn(ffmpegCmd, args, { 
    shell: true, 
    stdio: 'inherit', // Hiển thị luôn thanh tiến trình của FFmpeg ra màn hình
    cwd: __dirname 
  });

  proc.on('close', (code) => {
    if (code === 0) {
      console.log(`\n✅ HOÀN TẤT XUẤT SẮC!`);
      console.log(`🎉 Video của bạn đã sẵn sàng tại:`);
      console.log(`👉 ${outputPath}\n`);
      
      // Xóa video phôi sau khi dùng xong
      try {
        fs.unlinkSync(videoPath);
        console.log(`[System] 🗑 Đã xóa video phôi: ${randomVideo}`);
      } catch (err) {
        console.error(`[System] ⚠️ Không thể xóa video phôi: ${err.message}`);
      }
    } else {
      console.error(`\n❌ RẤT TIẾC, ĐÃ CÓ LỖI XẢY RA TRONG QUÁ TRÌNH GHÉP (Mã lỗi: ${code}).`);
    }
  });
}

runVideoMaker();
