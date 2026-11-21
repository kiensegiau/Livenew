const http = require('http');

http.get({
  host: '57.129.135.140',
  port: 3131,
  path: '/api/cluster/report',
  headers: { 'User-Agent': 'CyberShieldSecureAgent/1.0' }
}, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    try {
      const rep = JSON.parse(data);
      console.log('Tổng số luồng trên Cụm Mới:', rep.overview.streams.length);
      rep.overview.streams.forEach(s => {
        console.log(`- Luồng: "${s.name}" (${s.serverName}) | Trạng thái: ${s.status} | Speed: ${s.lastLog || ''}`);
      });
    } catch(e) { console.log(data); }
  });
});
