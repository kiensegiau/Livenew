/**
 * youtubeViewer.js - Module đọc chỉ số Livestream YouTube (Mắt xem live, view, like)
 * Tích hợp tự động cho Hệ thống Livenew:
 * - Hỗ trợ qua Google Apps Script Web App (không cần API Key trên VPS, không sợ lộ kênh)
 * - Hỗ trợ qua YouTube Data API v3 chính thức (nếu cấu hình API Key)
 * - Tự động tách Video ID từ bất kỳ link YouTube Live nào
 */

const https = require('https');
const http = require('http');

/**
 * Trích xuất 11 ký tự Video ID từ link YouTube bất kỳ
 * Hỗ trợ:
 * - https://www.youtube.com/watch?v=ABC123xyz00
 * - https://youtu.be/ABC123xyz00
 * - https://youtube.com/live/ABC123xyz00
 * - https://www.youtube.com/embed/ABC123xyz00
 * - https://www.youtube.com/shorts/ABC123xyz00
 * - Hoặc ID trần: ABC123xyz00
 */
function extractYouTubeVideoId(url) {
  if (!url) return null;
  const str = String(url).trim();
  const m = str.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?.*v=|live\/|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;
  return null;
}

/**
 * Gọi HTTP GET hỗ trợ chuyển hướng (redirect) an toàn cho Google Apps Script Web App
 */
function fetchWithRedirect(urlStr, maxRedirects = 5, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Quá nhiều chuyển hướng (redirect loop)'));
    
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(new Error('URL không hợp lệ: ' + urlStr));
    }

    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'LivenewYouTubeAgent/1.0',
        'Accept': 'application/json, text/plain, */*'
      },
      timeout: timeoutMs
    }, (res) => {
      // Xử lý chuyển hướng 301, 302, 307 (Google Apps Script luôn trả về 302)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const nextUrl = new URL(res.headers.location, url).toString();
        res.resume(); // Tiêu thụ hết stream cũ
        return resolve(fetchWithRedirect(nextUrl, maxRedirects - 1, timeoutMs));
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Hết thời gian chờ phản hồi (${timeoutMs}ms)`));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Lấy chỉ số thống kê của một hoặc nhiều video từ Apps Script hoặc YouTube Data API
 * @param {Array<string>} videoIds - Danh sách Video ID
 * @param {Object} options - { scriptUrl, apiKey }
 * @returns {Promise<Object>} Map { [videoId]: { viewers, views, likes, isLive, title } }
 */
async function fetchLiveStats(videoIds, { scriptUrl, apiKey } = {}) {
  if (!videoIds || videoIds.length === 0) return {};
  const validIds = Array.from(new Set(videoIds.map(v => extractYouTubeVideoId(v)).filter(Boolean)));
  if (validIds.length === 0) return {};

  const result = {};

  // Cách 1: Ưu tiên dùng Apps Script Web App (miễn phí, không cần Google Cloud Console/Billing)
  if (scriptUrl && scriptUrl.startsWith('http')) {
    try {
      const sep = scriptUrl.includes('?') ? '&' : '?';
      const targetUrl = `${scriptUrl}${sep}action=live_stats&videoIds=${encodeURIComponent(validIds.join(','))}`;
      const raw = await fetchWithRedirect(targetUrl, 5, 12000);
      const json = JSON.parse(raw);
      
      if (json && json.items) {
        return json.items;
      } else if (json && json.ok && json.viewers !== undefined && validIds.length === 1) {
        // Hỗ trợ trường hợp script đơn giản trả về trực tiếp 1 video
        result[validIds[0]] = {
          viewers: json.viewers,
          views: json.views || 0,
          likes: json.likes || 0,
          isLive: json.isLive !== false,
          title: json.title || ''
        };
        return result;
      }
    } catch (e) {
      console.warn(`[YouTube Viewer] ⚠️ Lỗi đọc chỉ số qua Apps Script: ${e.message}`);
    }
  }

  // Cách 2: Dự phòng dùng YouTube Data API v3 (nếu có API Key cấu hình)
  if (apiKey) {
    try {
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,statistics,snippet&id=${encodeURIComponent(validIds.join(','))}&key=${encodeURIComponent(apiKey)}`;
      const raw = await fetchWithRedirect(apiUrl, 3, 10000);
      const json = JSON.parse(raw);
      if (json && Array.isArray(json.items)) {
        json.items.forEach(v => {
          const live = v.liveStreamingDetails || {};
          const stats = v.statistics || {};
          const snip = v.snippet || {};
          const viewers = live.concurrentViewers ? parseInt(live.concurrentViewers, 10) : null;
          result[v.id] = {
            viewers: viewers,
            views: parseInt(stats.viewCount || 0, 10),
            likes: parseInt(stats.likeCount || 0, 10),
            isLive: snip.liveBroadcastContent === 'live' || viewers !== null,
            title: snip.title || '',
            channelTitle: snip.channelTitle || ''
          };
        });
        return result;
      }
    } catch (e) {
      console.warn(`[YouTube Viewer] ⚠️ Lỗi đọc chỉ số qua YouTube API: ${e.message}`);
    }
  }

  return result;
}

let pollerTimer = null;

/**
 * Khởi động tiến trình định kỳ cập nhật số mắt xem cho các luồng đang Live
 */
function startYouTubePoller({ getStreams, getScriptUrl, getApiKey, intervalMs = 60000, onUpdated }) {
  if (pollerTimer) clearInterval(pollerTimer);

  const poll = async () => {
    try {
      const streams = typeof getStreams === 'function' ? getStreams() : [];
      // Chỉ quét các luồng đang 'live' và có link YouTube
      const activeLiveStreams = streams.filter(s => s && s.status === 'live' && s.youtubeUrl);
      if (activeLiveStreams.length === 0) return;

      const scriptUrl = typeof getScriptUrl === 'function' ? getScriptUrl() : '';
      const apiKey = typeof getApiKey === 'function' ? getApiKey() : '';

      if (!scriptUrl && !apiKey) return;

      const videoMap = new Map(); // videoId -> Array of streams
      activeLiveStreams.forEach(s => {
        const vid = extractYouTubeVideoId(s.youtubeUrl);
        if (vid) {
          if (!videoMap.has(vid)) videoMap.set(vid, []);
          videoMap.get(vid).push(s);
        }
      });

      const videoIds = Array.from(videoMap.keys());
      if (videoIds.length === 0) return;

      const stats = await fetchLiveStats(videoIds, { scriptUrl, apiKey });
      let updatedCount = 0;

      for (const [vid, streamList] of videoMap.entries()) {
        const item = stats[vid];
        if (item) {
          streamList.forEach(s => {
            s.viewers = item.viewers !== undefined ? item.viewers : null;
            s.youtubeViews = item.views !== undefined ? item.views : null;
            s.youtubeLikes = item.likes !== undefined ? item.likes : null;
            s.youtubeLiveStatus = item.isLive ? 'live' : 'ended';
            updatedCount++;
          });
        }
      }

      if (updatedCount > 0 && typeof onUpdated === 'function') {
        onUpdated();
      }
    } catch (err) {
      console.error('[YouTube Viewer] Poller error:', err.message);
    }
  };

  // Chạy lần đầu sau 5 giây khi server khởi động
  setTimeout(poll, 5000);
  // Định kỳ lặp lại
  pollerTimer = setInterval(poll, Math.max(20000, intervalMs));
  console.log(`[YouTube Viewer] 🚀 Đã kích hoạt bộ quét mắt xem tự động (Chu kỳ: ${Math.round(intervalMs / 1000)}s)`);
}

function stopYouTubePoller() {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
}

module.exports = {
  extractYouTubeVideoId,
  fetchLiveStats,
  startYouTubePoller,
  stopYouTubePoller
};
