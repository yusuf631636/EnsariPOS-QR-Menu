/* Paket Servis konum kontrolü - iki nokta arası mesafe hesaplama.
   Kullanıcı isteği: "sadece düz mesafe değil, mümkünse yol mesafesi
   kullanılmalı - 3 km kuş uçuşu ile 3 km gerçek yol aynı şey değil".
   Yol mesafesi icin harici bir API anahtari GEREKTIRMEYEN, herkese acik
   OSRM demo sunucusu (router.project-osrm.org) kullanilir - agir/yogun
   kullanim icin uygun degildir ama kucuk bir restoranin siparis hacmi
   icin yeterlidir. Sunucuya erisilemezse (internet yok/limit) SESSIZCE
   kus ucusu (haversine) mesafeye DUSER - siparis akisi hic bir zaman
   sirf bu yuzden KIRILMAZ. */
const https = require('https');

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('Zaman aşımı.')));
    req.on('error', reject);
  });
}

async function roadDistanceKm(lat1, lng1, lat2, lng2) {
  const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=false`;
  const data = await fetchJson(url, 4000);
  const meters = data && data.routes && data.routes[0] && data.routes[0].distance;
  if (typeof meters !== 'number') throw new Error('Rota bulunamadı.');
  return meters / 1000;
}

/* Her zaman bir sonuç döner - yol mesafesi başarısızsa kuş uçuşuna düşer. */
async function distanceKm(lat1, lng1, lat2, lng2) {
  try {
    return { km: await roadDistanceKm(lat1, lng1, lat2, lng2), method: 'road' };
  } catch {
    return { km: haversineKm(lat1, lng1, lat2, lng2), method: 'straight' };
  }
}

module.exports = { distanceKm, haversineKm };
