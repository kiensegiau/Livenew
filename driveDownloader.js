const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// Cấu hình Keep-Alive Agent để tối ưu hóa kết nối TCP, giảm thời gian handshake và tận dụng băng thông VPS 1Gbps tốt hơn
const keepAliveTimeout = 15000;
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  keepAliveMsecs: keepAliveTimeout
});
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  keepAliveMsecs: keepAliveTimeout
});

function extractDriveId(url) {
  let m = url.match(/\/file\/d\/([a-zA-Z0-9_\-]+)/);
  if (m) return m[1];
  m = url.match(/[?&]id=([a-zA-Z0-9_\-]+)/);
  if (m) return m[1];
  m = url.match(/\/u\/\d+\/d\/([a-zA-Z0-9_\-]+)/);
  if (m) return m[1];
  m = url.match(/\/open\?id=([a-zA-Z0-9_\-]+)/);
  if (m) return m[1];
  return null;
}

function fetchUrl(url, cookieString, attempt, destPath, onProgress, resolve, reject) {
  if (attempt > 3) return reject(new Error("Quá số vòng Redirect tối đa của Google Drive."));

  const options = { 
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    },
    agent: url.startsWith('https://') ? httpsAgent : httpAgent
  };
  if (cookieString) options.headers['Cookie'] = cookieString;

  const transport = url.startsWith('http://') ? http : https;
  transport.get(url, options, (res) => {

    let newCookieString = cookieString;
    if (res.headers['set-cookie']) {
      newCookieString = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    }

    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      let redirectUrl = res.headers.location;
      const confirmTokenMatch = newCookieString.match(/download_warning_[^=]+=([^;]+)/);
      if (confirmTokenMatch && !redirectUrl.includes('confirm=')) {
        redirectUrl += `&confirm=${confirmTokenMatch[1]}`;
      }
      return fetchUrl(redirectUrl, newCookieString, attempt + 1, destPath, onProgress, resolve, reject);
    }

    if (res.statusCode === 200 && res.headers['content-type'] && res.headers['content-type'].includes('text/html')) {
      let htmlBody = '';
      res.on('data', chunk => htmlBody += chunk);
      res.on('end', () => {
        // Debug: In một đoạn HTML để kiểm tra nếu cần (chỉ 500 ký tự đầu)
        console.log(`[Drive Debug] Phản hồi từ Google (500 ký tự đầu):\n${htmlBody.substring(0, 500)}...`);

        if (htmlBody.includes("Quota exceeded")) {
          return reject(new Error("File này đã vượt quá hạn mức tải xuống của Google Drive trong hôm nay. 👉 Cách sửa: Hãy 'Tạo bản sao' file này trên Drive và dùng link của bản sao đó."));
        }

        const actionMatch = htmlBody.match(/action="([^"]+)"/i);
        const confirmMatch = htmlBody.match(/name="confirm"\s+value="([^"]+)"/i) 
                          || htmlBody.match(/confirm=([a-zA-Z0-9_\-]+)/i)
                          || htmlBody.match(/"confirm":"([a-zA-Z0-9_\-]+)"/i); // Tìm trong JSON/Script
        
        const uuidMatch = htmlBody.match(/name="uuid"\s+value="([^"]+)"/i);
        const idMatch = htmlBody.match(/name="id"\s+value="([^"]+)"/i) 
                     || htmlBody.match(/id=([a-zA-Z0-9_\-]+)/i);

        if (confirmMatch) {
          const confirmToken = confirmMatch[1];
          console.log(`[Drive Debug] ✅ Đã tìm thấy mã xác nhận: ${confirmToken}`);
          const fileId = idMatch ? idMatch[1] : extractDriveId(url);
          const finalAction = actionMatch ? actionMatch[1].replace(/&amp;/g, '&') : "https://drive.google.com/uc";
          
          let bypassUrl = finalAction;
          if (!bypassUrl.includes('?')) bypassUrl += '?';
          if (!bypassUrl.includes('id=')) bypassUrl += `&id=${fileId}`;
          bypassUrl += `&export=download&confirm=${confirmToken}`;
          if (uuidMatch) bypassUrl += `&uuid=${uuidMatch[1]}`;
          
          return fetchUrl(bypassUrl, newCookieString, attempt + 1, destPath, onProgress, resolve, reject);
        } else {
          console.error(`[Drive Debug] ❌ Thất bại: Không tìm thấy nút 'Xác nhận tải xuống' trong HTML.`);
          return reject(new Error("Giải mã Bypass Virus thất bại. Google có thể đang yêu cầu đăng nhập hoặc link bị giới hạn."));
        }
      });
      return;
    }

    if (res.statusCode === 200) {
      let totalBytes = parseInt(res.headers['content-length'], 10) || 0;
      let filename = `drive_video_${Date.now()}.mp4`; // Đặt tên mặc định an toàn
      
      const finalDest = path.join(destPath, filename);
      if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });

      // Cầu nối bộ đệm 4MB giữa Network và Disk để giải phóng Socket đọc tối đa
      const { PassThrough } = require('stream');
      const bufferBridge = new PassThrough({ highWaterMark: 1024 * 1024 * 4 });

      // Tăng bộ đệm ghi file lên 4MB để giảm tải I/O đĩa, tăng tốc độ ghi
      const fileStream = fs.createWriteStream(finalDest, { highWaterMark: 1024 * 1024 * 4 });

      res.pipe(bufferBridge).pipe(fileStream);

      // Cập nhật tiến độ mỗi 1 giây bằng cách đọc trực tiếp bytesWritten (Siêu nhẹ, không tốn CPU lắng nghe dồn dập)
      let lastReport = Date.now();
      let lastReportBytes = 0;

      const progressInterval = setInterval(() => {
        const downloadedBytes = fileStream.bytesWritten;
        const now = Date.now();
        const timePassed = now - lastReport;
        if (timePassed >= 1000) {
          const percentage = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : null;
          const speedBytesPerSec = (downloadedBytes - lastReportBytes) / (timePassed / 1000);
          
          if (onProgress) {
            onProgress(downloadedBytes, totalBytes, percentage, speedBytesPerSec);
          }
          
          lastReport = now;
          lastReportBytes = downloadedBytes;
        }
      }, 1000);

      fileStream.on('finish', () => {
        clearInterval(progressInterval);
        fileStream.close();
        resolve(finalDest);
      });

      fileStream.on('error', (err) => {
        clearInterval(progressInterval);
        try { fs.unlinkSync(finalDest); } catch (_) {}
        reject(err);
      });
      return;
    }

    reject(new Error(`Bị từ chối quyền truy cập (Code: ${res.statusCode}). File Drive có bật chế độ Chia Sẻ không?`));
  }).on('error', reject);
}

function downloadGoogleDriveFile(driveUrl, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const fileId = extractDriveId(driveUrl);
    if (!fileId) return reject(new Error("Link Google Drive không hợp lệ!"));

    const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    fetchUrl(initialUrl, "", 1, destPath, onProgress, resolve, reject);
  });
}

module.exports = {
  downloadGoogleDriveFile,
  extractDriveId
};
