/* [YEREL TARAF - bu dosya RESTORAN BILGISAYARINDA calisir, BULUTTA DEGIL.
   Tunelin KARSI/SUNUCU tarafi C:\toplu\qrmenu-tunnel.js'dir - o, buluta (VPS'e)
   kurulu, disaridan gelen baglantilari KABUL eder; bu dosya ise disari dogru
   ONA baglanir.]

   app.ornek-alanadi.com/qrmenu ve menu.ornek-alanadi.com uzerinden UZAKTAN erisim -
   C:\gelismis-kurye-sistemi\tunnel.js ile BIREBIR AYNI genel amacli ters HTTP
   tunel deseni (19.09.2026, kullanici karari: "QR Menü artik bulutta sabit
   adresten, restoranin kendi motoruyla tunel uzerinden calisacak"). Gelen HER
   HTTP istegini (method/path/header/govde) oldugu gibi WebSocket uzerinden
   alir, bu uygulamanin KENDI handleRequest() fonksiyonuna (server.js - gercek
   HTTP sunucusunun port 4500'de kullandigi AYNI fonksiyon) sahte bir req/res
   ile verir, cevabi yakalayip geri gonderir. server.js'in PIN/oturum/lisans
   mantigi bu tunelin FARKINDA bile degildir - kod TEK SATIR degismeden hem
   yerel/LAN hem tunelli istekleri ayni sekilde isler; port 4500 dinlemesi de
   PARALEL olarak calismaya devam eder (tunel EK bir erisim yolu, yerine
   GECMEZ).

   Lisans kontrolunden (license.js) BAGIMSIZDIR: anahtar varsa baglanmayi HER
   ZAMAN dener - lisans kapaliysa bulut tarafi (qrmenu-tunnel.js) baglantiyi
   zaten reddeder. */
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const license = require('./license');

const RECONNECT_MIN_MS = 2000, RECONNECT_MAX_MS = 30000;
let reconnectDelay = RECONNECT_MIN_MS;

/* Bulut, baglanti kurulur kurulmaz bu restoranin KENDI musteri-menu adresini
   (slug'a dayali) bir 'hello' mesajiyla bildirir - masa QR kodlarinin HANGI
   restorana ait oldugu belli olsun diye (20.09.2026, kullanici bulgusu:
   "satacagiz, hangi restoranin oldugu belli olmasi lazim"). server.js bunu
   /api/admin/site-info ucuyla panele verir. */
let siteInfo = null; // { slug, menuBaseUrl } | null (tunel henuz kurulmadiysa)
function getSiteInfo() { return siteInfo; }
/* Musteri kendi baglanti adini (slug) admin panelinden degistirdiginde,
   bulut tarafi zaten guncellendi - burada da HEMEN yansitilir, bir sonraki
   tunel yeniden-baglanmasini (dakikalar surebilir) beklemeye gerek kalmaz. */
function updateSlug(slug) {
  siteInfo = { slug, menuBaseUrl: `https://menu.ornek-alanadi.com/${slug}` };
}

function log(...args) { console.log(new Date().toISOString(), '[tunnel]', ...args); }

/* gelismis-kurye-sistemi/tunnel.js'teki AYNI canli-tespit edilmis kacis
   duzeltmesi: govde, .on('data'/'end') GERCEKTEN cagrildigi anda yayinlanir -
   boylece govdeyi HEMEN okumayan bir handler (orn. once baska bir async is
   yapan) govdeyi kacirmaz. */
function makeFakeReq(method, urlPath, headers, bodyBuffer) {
  const req = new EventEmitter();
  req.method = method;
  req.url = urlPath;
  req.headers = headers || {};
  req.socket = { remoteAddress: '127.0.0.1' };
  /* server.js'in garson (PIN-only) oturumlarini LAN-disi (tunel/internet)
     istekten ayirt edip kisitlayabilmesi icin acik isaret - bkz. server.js
     "isLanRequest". Patron/admin oturumlari bu kisitlamaya tabi degil. */
  req.isTunnel = true;
  let scheduled = false;
  const originalOn = req.on.bind(req);
  req.on = (event, listener) => {
    if ((event === 'data' || event === 'end') && !scheduled) {
      scheduled = true;
      process.nextTick(() => {
        if (bodyBuffer && bodyBuffer.length) req.emit('data', bodyBuffer);
        req.emit('end');
      });
    }
    return originalOn(event, listener);
  };
  return req;
}

function makeFakeRes(onDone) {
  const res = new EventEmitter();
  const chunks = [];
  let statusCode = 200, headers = {}, done = false;
  res.writeHead = (status, h) => { statusCode = status; headers = { ...headers, ...(h || {}) }; };
  res.setHeader = (k, v) => { headers[k] = v; };
  res.getHeader = k => headers[k];
  res.write = chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; };
  res.end = chunk => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    if (done) return;
    done = true;
    onDone({ status: statusCode, headers, body: Buffer.concat(chunks) });
  };
  return res;
}

async function processRequest(handleRequest, msg) {
  const bodyBuffer = Buffer.from(msg.bodyBase64 || '', 'base64');
  const req = makeFakeReq(msg.method, msg.path, msg.headers, bodyBuffer);
  const result = await new Promise(resolve => {
    const res = makeFakeRes(resolve);
    try {
      const maybePromise = handleRequest(req, res);
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(error => {
          log('handleRequest hatasi (yakalanmamis):', error.message);
          try { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message })); } catch { resolve({ status: 500, headers: {}, body: Buffer.alloc(0) }); }
        });
      }
    } catch (error) {
      try { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message })); } catch { resolve({ status: 500, headers: {}, body: Buffer.alloc(0) }); }
    }
  });
  return result;
}

/* Cloudflare/ara katmanlar dusuk seviye WS ping/pong KONTROL cerceve'lerini
   "aktivite" saymayabilir - gelismis-kurye-sistemi/tunnel.js'teki AYNI
   gerekceyle uygulama seviyesinde GERCEK bir mesaj gonderiliyor. */
const PING_INTERVAL_MS = 30000;

function connect(handleRequest, activationKey, wsUrl) {
  const ws = new WebSocket(`${wsUrl}?key=${encodeURIComponent(activationKey)}`);
  let pingTimer = null;

  ws.on('open', () => {
    log('bulut tüneline bağlandı.');
    reconnectDelay = RECONNECT_MIN_MS;
    pingTimer = setInterval(() => { try { ws.send(JSON.stringify({ type: 'ping' })); } catch {} }, PING_INTERVAL_MS);
  });

  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello') { siteInfo = { slug: msg.slug, menuBaseUrl: msg.menuBaseUrl }; log('kimlik alindi, slug:', msg.slug); return; }
    if (msg.type !== 'request') return;
    try {
      const result = await processRequest(handleRequest, msg);
      ws.send(JSON.stringify({
        type: 'response', id: msg.id, status: result.status, headers: result.headers,
        bodyBase64: result.body.toString('base64')
      }));
    } catch (error) {
      log('istek işlenemedi (yoksayıldı):', error.message);
      try { ws.send(JSON.stringify({ type: 'response', id: msg.id, status: 500, headers: {}, bodyBase64: '' })); } catch {}
    }
  });

  ws.on('close', () => {
    if (pingTimer) clearInterval(pingTimer);
    log('tünel bağlantısı kesildi, yeniden denenecek.');
    setTimeout(() => connect(handleRequest, activationKey, wsUrl), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
  });
  ws.on('error', error => { log('tünel hatası:', error.message); ws.close(); });
}

function start(handleRequest) {
  const key = license.activationKey();
  if (!key) { log('activationKey yok - uzaktan erişim tüneli pasif (yerel/LAN erişimi etkilenmez).'); return; }
  const wsUrl = license.CLOUD_URL.replace(/^http/, 'ws') + '/qrmenu-tunnel';
  connect(handleRequest, key, wsUrl);
}

module.exports = { start, getSiteInfo, updateSlug };
