const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

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

  const options = { headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  } };
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
        const actionMatch = htmlBody.match(/action="([^"]+)"/);
        const confirmMatch = htmlBody.match(/name="confirm"\s+value="([^"]+)"/);
        const uuidMatch = htmlBody.match(/name="uuid"\s+value="([^"]+)"/);
        const idMatch = htmlBody.match(/name="id"\s+value="([^"]+)"/);

        if (actionMatch && confirmMatch && idMatch) {
          let bypassUrl = actionMatch[1];
          bypassUrl += `?id=${idMatch[1]}&export=download&confirm=${confirmMatch[1]}`;
          if (uuidMatch) bypassUrl += `&uuid=${uuidMatch[1]}`;
          return fetchUrl(bypassUrl, newCookieString, attempt + 1, destPath, onProgress, resolve, reject);
        } else {
          return reject(new Error("Giải mã Bypass Virus thất bại."));
        }
      });
      return;
    }

    if (res.statusCode === 200) {
      let totalBytes = parseInt(res.headers['content-length'], 10) || 0;
      let filename = `drive_video_${Date.now()}.mp4`; // Đặt tên mặc định an toàn
      
      const finalDest = path.join(destPath, filename);
      if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });

      const fileStream = fs.createWriteStream(finalDest);
      let downloadedBytes = 0;

      res.pipe(fileStream);

      // Cập nhật tiến độ mỗi 1 giây để tránh gửi quá nhiều log
      let lastReport = 0;
      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (onProgress) {
          const now = Date.now();
          if (now - lastReport > 1000) {
            const percentage = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : null;
            onProgress(downloadedBytes, totalBytes, percentage);
            lastReport = now;
          }
        }
      });

      fileStream.on('finish', () => {
        fileStream.close();
        resolve(finalDest);
      });

      fileStream.on('error', (err) => {
        fs.unlinkSync(finalDest);
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
