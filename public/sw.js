// Service worker tối giản cho PWA: KHÔNG cache dữ liệu để giao diện luôn hiển thị trạng thái luồng mới nhất.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  e.respondWith(
    fetch(req).catch(() => new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<body style="margin:0;background:#0b1020;color:#e5e7eb;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">' +
      '<div><h2>Mất kết nối tới máy chủ</h2><p>Kiểm tra mạng rồi tải lại trang.</p><button onclick="location.reload()" style="padding:10px 20px;border-radius:8px;border:0;background:#6366f1;color:#fff;font-size:1rem">Tải lại</button></div>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    ))
  );
});
