/* Bulut lisans dogrulamasi - C:\ultra-paketci\license.js'deki KANITLANMIS desenin
   birebir uyarlanmis hali (18.09.2026). config.json'daki "activationKey"
   (musterinin PAYLASILAN/genel aktivasyon anahtari - Kurye/Patron ile AYNI)
   ile C:\toplu (AlfaPOS Bulut) admin panelinde "QR Menü" urunu acik mi diye
   kontrol eder (product=qrmenu, has_qrmenu sutunu - eski bulut tabanli QR Menü
   servisi kaldirildigi icin bu urun kimligi artik BU yerel uygulamaya ait).
   Baslangicta VE her 30 dakikada bir sorar.

   Gecici ag kesintisinde musteri DISARIDA BIRAKILMAZ: bulut sunucusuna hic
   erisilemezse en son BASARILI (ok:true) sonuc bellekte kalir. Ama bulut sunucusu
   ERISILEBILIR ve acikca "lisans yok/suresi gecti" diyorsa bu HER ZAMAN gecerlidir
   (eski basarili sonucu asla ezmez/gormezden gelmez) - admin lisansi kapattiginda
   bir sonraki kontrolde gercekten kapanmali. */
const https = require('https');
const { config } = require('./sql');

const CLOUD_URL = (config.cloudServerUrl || 'https://app.ornek-alanadi.com').replace(/\/+$/, '');
const ACTIVATION_KEY = String(config.activationKey || '').trim();
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

let lastResult = { ok: false, error: 'Lisans henüz doğrulanmadı.' };
let hasEverSucceeded = false;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Lisans sunucusundan geçersiz yanıt.')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Lisans sunucusuna erişilemedi (zaman aşımı).')); });
  });
}

/* Admin panelde "Bağlı/Bağlı değil" gorunsun diye - hafif bir nabiz sinyali.
   Basarisiz olursa sessizce yoksayilir (hata firlatmaz) - bu ozellik OLMASA da
   uygulama calismaya devam eder. */
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
function sendHeartbeatOnce() {
  if (!ACTIVATION_KEY) return;
  try {
    const url = new URL(`${CLOUD_URL}/api/agent/heartbeat`);
    const payload = JSON.stringify({ activationKey: ACTIVATION_KEY, product: 'qrmenu' });
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 10000
    }, res => { res.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(payload);
  } catch { /* URL parse gibi beklenmeyen bir hata - sessizce gec */ }
}

async function checkOnce() {
  if (!ACTIVATION_KEY) {
    lastResult = { ok: false, error: 'Aktivasyon anahtarı yapılandırılmamış.' };
    return lastResult;
  }
  const url = `${CLOUD_URL}/api/agent/license-check?key=${encodeURIComponent(ACTIVATION_KEY)}&product=qrmenu`;
  try {
    const parsed = await fetchJson(url);
    lastResult = parsed.ok ? { ok: true } : { ok: false, error: parsed.error || 'Lisans doğrulanamadı.' };
    if (parsed.ok) hasEverSucceeded = true;
  } catch (error) {
    if (!hasEverSucceeded) lastResult = { ok: false, error: 'Lisans sunucusuna erişilemedi. İnternet bağlantınızı kontrol edin.' };
    // else: onceki basarili sonuc korunur - gecici kesinti musteriyi disarida birakmaz.
  }
  return lastResult;
}

function isLicensed() { return lastResult.ok; }
function licenseError() { return lastResult.error; }
function activationKey() { return ACTIVATION_KEY; }

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Lisans sunucusundan geçersiz yanıt.')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Lisans sunucusuna erişilemedi (zaman aşımı).')); });
    req.end(body);
  });
}

/* Admin girisinin 1. ADIMI (19.09.2026, kullanici karari: "Patron/Kurye gibi
   once panel e-posta+sifre, sonra SambaPOS PIN'i"): musterinin GERCEK bulut
   panel sifresini (customers.password_hash - diger panellerde kullandigi AYNI
   sifre) dogrular - C:\ultra-paketci\license.js / C:\gelismis-kurye-sistemi
   \license.js'teki AYNI desen, product=qrmenu ile. Basarili olursa 2. adimda
   (server.js) SambaPOS PIN'i istenir. */
async function verifyPassword(identifier, password) {
  if (!ACTIVATION_KEY) return { ok: false, error: 'Aktivasyon anahtarı yapılandırılmamış.' };
  try {
    return await postJson(`${CLOUD_URL}/api/agent/verify-password`, { key: ACTIVATION_KEY, product: 'qrmenu', identifier, password });
  } catch (error) {
    return { ok: false, error: 'Lisans sunucusuna erişilemedi. İnternet bağlantınızı kontrol edin.' };
  }
}

/* Restoranin kendi kisa/hatirlanabilir baglanti adini (menu.ornek-alanadi.com/<slug>)
   admin panelinden degistirebilmesi icin (26.09.2026, kullanici bulgusu:
   "otomatik uretilen slug cok uzun/anlamsiz, TV'ye elle yazmasi zor"). */
async function setQrmenuSlug(slug) {
  if (!ACTIVATION_KEY) return { ok: false, error: 'Aktivasyon anahtarı yapılandırılmamış.' };
  try {
    return await postJson(`${CLOUD_URL}/api/agent/qrmenu-set-slug`, { key: ACTIVATION_KEY, slug });
  } catch (error) {
    return { ok: false, error: 'Lisans sunucusuna erişilemedi. İnternet bağlantınızı kontrol edin.' };
  }
}

checkOnce();
setInterval(checkOnce, CHECK_INTERVAL_MS);
sendHeartbeatOnce();
setInterval(sendHeartbeatOnce, HEARTBEAT_INTERVAL_MS);

module.exports = { isLicensed, licenseError, checkOnce, activationKey, verifyPassword, setQrmenuSlug, CLOUD_URL };
