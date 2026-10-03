/* QR Menu - yerel sunucu. Mevcut statik siteyi (index.html, siparis.html, urun
   fotograflari, CSS/) OLDUGU GIBI, kok dizinden servis eder (Netlify'daki ile
   AYNI goreli yollar calissin diye - /CSS/style.css, /logo.png vb.) VE bir
   "/admin" yonetim paneli ekler (SambaPOS'taki GUNCEL menu/fiyat listesini
   gosterir - kullanici istegi: "SambaPOS'a uyarla").

   GUVENLIK: kok dizin AYNI ZAMANDA sunucu kaynak dosyalarini (server.js, sql.js,
   sambapos.js, config.json, .env) da icerdigi icin statik servis SADECE bilinen
   guvenli uzantilara (html/resim/css) izin veren bir ALLOWLIST ile calisir -
   .js/.json/.env gibi dosyalar asla disariya sunulmaz (SQL sifresi/kaynak kod
   sizmasin). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const sharp = require('sharp');
const { config } = require('./sql');
const sambapos = require('./sambapos');
const menuEditor = require('./menu-editor');
const { distanceKm } = require('./distance');
const license = require('./license');
const upsell = require('./upsell');

const PORT = Number(process.env.PORT || config.port || 4500);
const ROOT = __dirname;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 gun - admin sik sik PIN girmesin

const ALLOWED_EXT = new Set(['.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.css', '.webmanifest', '.json']);
// index.html/siparis.html'in KENDI kod ici referans ettigi CSS/ altindaki eski
// "saved page" dosyalari (bkz. .js.indir) - bunlar gercek calisan JS DEGIL (Chrome'un
// "Sayfayi Farkli Kaydet" uretimi), zaten hicbiri ".js" uzantili degil (ALLOWED_EXT
// zaten .js'i icermiyor) - bu yuzden ayri bir izin gerekmiyor, otomatik disari kalir
// (index.html'deki gorunum bundan ETKILENMEZ, o dosyalar zaten kullanilmiyor).
const DENY_BASENAMES = new Set(['config.json', 'orders.json', 'package-lock.json', '.env', '.gitignore', 'upsell-rules.json', 'upsell-stats.json', 'firebase-service-account.json', 'google-services.json',
  /* 30.09.2026: musteri degerlendirmeleri (isim, dusuk puanli sikayetler) ve cagrilar DISARIYA ACIK OLMAMALI */
  'customer-reviews.json', 'calls.json', 'package.json']);
/* .js dosyalari (server.js vb. program kodu) ASLA sunulmaz - SADECE bu listedeki, bilerek
   tarayiciya yazilmis dosyalar istisna (30.09.2026). */
const PUBLIC_JS = new Set(['reviews-strip.js']);
const ORDERS_PATH = path.join(ROOT, 'orders.json');
const CALLS_PATH = path.join(ROOT, 'calls.json');

/* Siparis ucu GERCEK SambaPOS adisyonu olusturdugu icin (16.09.2026) - bir IP'nin
   spam/kotuye kullanimla SambaPOS'u sahte adisyonlarla doldurmasini engellemek icin
   basit bir hiz siniri: 10 dakikada en fazla 5 siparis. */
const orderRateLimit = new Map(); // ip -> [timestamps]
function isOrderRateLimited(ip) {
  const now = Date.now(), windowMs = 10 * 60 * 1000;
  const hits = (orderRateLimit.get(ip) || []).filter(t => now - t < windowMs);
  hits.push(now);
  orderRateLimit.set(ip, hits);
  return hits.length > 5;
}

/* Garson çağrısı - SambaPOS'a hiç yazmaz (sadece admin paneline bildirim),
   bu yüzden ayrı ve daha gevşek bir hız sınırı yeterli: 10 dakikada aynı
   IP'den en fazla 15 çağrı (masa başına "garson/hesap/su/ekstra" gibi
   birden fazla tıklama olabilir). */
const callRateLimit = new Map();
function isCallRateLimited(ip) {
  const now = Date.now(), windowMs = 10 * 60 * 1000;
  const hits = (callRateLimit.get(ip) || []).filter(t => now - t < windowMs);
  hits.push(now);
  callRateLimit.set(ip, hits);
  return hits.length > 15;
}

/* Yeni siparis bildirimi (17.09.2026, kullanici istegi: "pc ye siparis geldiginde
   bildirim olsun") - Server-Sent Events ile /admin paneli acikken canli anlik
   bildirim gonderilir (ek kutuphane/websocket gerekmez, http modulu yeter). */
const sseClients = new Set(); // response objeleri (admin paneli acik sekmeler)
function broadcastNewOrder(order) {
  const payload = `event: new-order\ndata: ${JSON.stringify(order)}\n\n`;
  for (const client of sseClients) { try { client.write(payload); } catch { sseClients.delete(client); } }
}
/* Garson çağrısı bildirimi (18.09.2026, kullanıcı isteği: "garson çağırma
   sistemi olsun") - aynı SSE bağlantısı üzerinden ayrı bir event adıyla
   yayınlanır, admin panelinde ayrı bir dinleyici bunu yakalar. */
function broadcastWaiterCall(call) {
  const payload = `event: waiter-call\ndata: ${JSON.stringify(call)}\n\n`;
  for (const client of sseClients) { try { client.write(payload); } catch { sseClients.delete(client); } }
}

/* Push bildirimi - garson APK'sı "garson_calls" konusuna abone. Restoran
   Firebase servis hesabı JSON'unu koymamışsa getFirebaseApp() null döner,
   sendGarsonPush() sessizce hiçbir şey yapmaz - zorunlu değil. */
const FIREBASE_KEY_PATH = path.join(ROOT, 'firebase-service-account.json');
let firebaseApp = null;
function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;
  if (!fs.existsSync(FIREBASE_KEY_PATH)) return null;
  try {
    const { initializeApp, cert, getApps, getApp } = require('firebase-admin/app');
    firebaseApp = getApps().length ? getApp() : initializeApp({ credential: cert(require(FIREBASE_KEY_PATH)) });
    return firebaseApp;
  } catch (error) {
    console.error('Firebase başlatılamadı:', error.message);
    return null;
  }
}
async function sendGarsonPush(call) {
  const app = getFirebaseApp();
  if (!app) return;
  try {
    const { getMessaging } = require('firebase-admin/messaging');
    await getMessaging(app).send({
      topic: 'garson_calls',
      notification: { title: '🛎️ ' + call.table, body: call.label },
      data: { table: String(call.table || ''), label: String(call.label || ''), type: String(call.type || '') },
      android: { priority: 'high', notification: { sound: 'default', channelId: 'garson_calls' } }
    });
  } catch (error) {
    console.error('Push gönderilemedi:', error.message);
  }
}

/* Mutfak yazıcısı - kategoriye göre farklı yazıcıya bölünebilir. Config'de
   kategori->yazıcı eşlemesi elle girilmişse öncelik ona verilir, yoksa
   SambaPOS'un KENDİ "Siparişleri Mutfağa Yazdır" görevindeki eşleme
   (sambapos.getKitchenPrinterRouting()) kullanılır. */
function readKitchenPrinter() {
  try {
    const p = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).kitchenPrinter;
    return { enabled: p?.enabled === true, name: p?.name || '', autoRoute: p?.autoRoute !== false, categoryMap: p?.categoryMap || {} };
  } catch { return { enabled: false, name: '', autoRoute: true, categoryMap: {} }; }
}
function writeKitchenPrinter(input) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const categoryMap = {};
  if (input.categoryMap && typeof input.categoryMap === 'object') {
    for (const [cat, printer] of Object.entries(input.categoryMap)) {
      const p = String(printer || '').trim().slice(0, 120);
      if (p) categoryMap[String(cat).trim().slice(0, 120)] = p;
    }
  }
  c.kitchenPrinter = { enabled: input.enabled === true, name: String(input.name || '').trim().slice(0, 120), autoRoute: input.autoRoute !== false, categoryMap };
  writeConfigAtomic(c);
  return c.kitchenPrinter;
}
function psArray(lines) { return '@(' + lines.map(l => `'${psEscape(l)}'`).join(',') + ')'; }
function sendPrintJob(printerName, order, ticketNumber, items, stationLabel) {
  const kind = order.type === 'table' ? (order.tableNumber || 'MASA') : order.type === 'pickup' ? 'GEL-AL SERVİS' : 'PAKET SERVİS';
  const now = new Date();
  const titleLines = [kind, ticketNumber ? `Adisyon No: #${ticketNumber}` : '', stationLabel ? `[${stationLabel}]` : ''].filter(Boolean);
  const bodyLines = [
    ...(order.customerName ? [order.customerName] : []),
    ...(order.phone ? [order.phone] : []),
    '------------------------------',
    ...items.flatMap(i => [
      `${i.quantity}x ${i.name}`,
      i.portionName && i.portionName !== 'Adet' && i.portionName !== 'Normal' ? `   (${i.portionName})` : ''
    ].filter(Boolean)),
    '------------------------------',
    ...(order.note ? [`Not: ${order.note}`] : []),
    `${now.toLocaleDateString('tr-TR')} ${now.toLocaleTimeString('tr-TR')}`
  ];
  const script = `Add-Type -AssemblyName System.Drawing
$titleLines = ${psArray(titleLines)}
$bodyLines = ${psArray(bodyLines)}
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = '${psEscape(printerName)}'
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(6,6,6,6)
$titleFont = New-Object System.Drawing.Font('Consolas', 20, [System.Drawing.FontStyle]::Bold)
$bodyFont = New-Object System.Drawing.Font('Consolas', 16, [System.Drawing.FontStyle]::Bold)
$doc.add_PrintPage({
  param($s, $e)
  $y = $e.MarginBounds.Top
  foreach ($l in $titleLines) { $e.Graphics.DrawString($l, $titleFont, [System.Drawing.Brushes]::Black, $e.MarginBounds.Left, $y); $y += $titleFont.GetHeight($e.Graphics) + 4 }
  $y += 6
  foreach ($l in $bodyLines) { $e.Graphics.DrawString($l, $bodyFont, [System.Drawing.Brushes]::Black, $e.MarginBounds.Left, $y); $y += $bodyFont.GetHeight($e.Graphics) + 3 }
})
$doc.Print()`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true }, (err) => {
    if (err) console.error(`Mutfak yazdırma hatası (${printerName}):`, err.message);
  });
}
async function printOrderToKitchen(order, ticketNumber) {
  const printer = readKitchenPrinter();
  if (!printer.enabled || process.platform !== 'win32') return;
  if (!printer.autoRoute) {
    if (printer.name) sendPrintJob(printer.name, order, ticketNumber, order.items, null);
    return;
  }
  let samba = { byCategory: {}, defaultPrinter: null };
  try { samba = await sambapos.getKitchenPrinterRouting(); } catch (e) { console.error('SambaPOS yazıcı eşlemesi okunamadı:', e.message); }
  const groups = new Map();
  for (const item of order.items) {
    const target = (item.categoryName && printer.categoryMap[item.categoryName])
      || (item.categoryName && samba.byCategory[item.categoryName])
      || samba.defaultPrinter || printer.name;
    if (!target) continue;
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(item);
  }
  for (const [printerName, items] of groups) sendPrintJob(printerName, order, ticketNumber, items, printerName);
}

/* Masaüstü bildirimi (kullanıcı isteği: "garson çağrısı direk ekranımda
   görünsün") - SambaPOS'un KENDİ uygulamasına dışarıdan bir popup enjekte
   etmek mümkün değil (ayrı bir .exe, otomasyon/mesajlaşma iç yapısına erişim
   yok), ama bu Node sunucusu AYNI restoran PC'sinde çalıştığı için Windows'un
   kendi bildirim balonunu (NotifyIcon) tetikleyebiliriz - SambaPOS ekranda
   önde olsa da bildirim üstte görünür, ek kurulum/modül GEREKMEZ (.NET'in
   System.Windows.Forms'u Windows'ta zaten hazır gelir). */
function psEscape(value) { return String(value).replace(/'/g, "''"); }
function notifyDesktop(title, text) {
  if (process.platform !== 'win32') return;
  const script = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.BalloonTipTitle = '${psEscape(title)}'; $n.BalloonTipText = '${psEscape(text)}'; $n.ShowBalloonTip(8000); Start-Sleep -Seconds 9; $n.Dispose()`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true }, () => { /* bildirim gosterilemedi, sessizce gec - siparis akisini etkilemez */ });
}

function parseCookies(req) {
  const header = req.headers.cookie, out = {};
  if (!header) return out;
  header.split(';').forEach(part => { const i = part.indexOf('='); if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); });
  return out;
}
/* qr_admin_session ARTIK sunucu hafizasindaki bir Map'e DEGIL (25.09.2026'da
   qr_admin_pending icin yapilan AYNI kok-neden duzeltmesi, 26.09.2026'da BU
   asil oturuma da uygulandi) - imzali/durumsuz bir cerezin kendisine dayanir.
   Kullanici bulgusu: garson-web/Config.html'in yeni /api/admin/terminal-config-options
   cagrisi "SambaPOS'a bağlanılamadı" hatasi veriyordu - GERCEK sebep, bu
   oturumun bir Map'te tutulmasi yuzunden HER servis yeniden baslatmasinda
   (bu oturumdaki art arda deploy'larin HER BIRINDE) zaten giris yapmis bir
   tarayicinin oturumunun sessizce gecersiz kalmasiydi. Imza anahtari
   activationKey'den turetildigi icin servis kac kez yeniden baslarsa baslasin
   koprü kopmaz. */
function sessionSecret() { return crypto.createHash('sha256').update('qrmenu-session:' + (license.activationKey() || 'no-key')).digest(); }
function currentSession(req) {
  const raw = parseCookies(req).qr_admin_session || '';
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot), sig = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const record = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!record.exp || record.exp < Date.now()) return null;
    return record;
  } catch { return null; }
}
function isAuthed(req) {
  const session = currentSession(req);
  return !!(session && (session.role === 'admin' || session.role === 'garson'));
}
function isLanRequest(req) { return !req.isTunnel; }
/* SambaPOS'un kendi terminaline (garson-web/samba-lan) erisim kurali
   (26.09.2026 kullanici karari): garson (PIN-only) rolu SADECE LAN'dan
   girebilir - patron/admin (email+sifre+PIN) rolu HER ZAMAN heryerden
   girebilir. Admin panelinden acilan config.remoteGarsonAllowed anahtari
   BUNU manuel olarak gevsetmek icin - "belirli garson telefonlarina da
   izin ver" istegi, tek tek cihaz degil GLOBAL bir anahtar ile cozuldu
   (daha basit, oturumlar durumsuz oldugu icin tek-cihaz beyaz listesi
   pratik degil). */
function canUseSambaposTerminal(req) {
  const session = currentSession(req);
  if (!session) return false;
  if (session.role === 'admin') return true;
  if (session.role === 'garson') return isLanRequest(req) || readRemoteGarsonAllowed();
  return false;
}
function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted; }
/* res.setHeader('Set-Cookie', ...) bir onceki cagriyi TAMAMEN EZER (dizi
   degilse) - login-step2 hem eski qr_admin_pending cerezini temizleyip HEM
   yeni qr_admin_session'i kurdugu icin iki ayri Set-Cookie basligi AYNI ANDA
   gonderilmeli, biri digerini silmemeli. */
function addSetCookie(res, cookieStr) {
  /* tunel.js'in sahte res nesnesi getHeader() ICERMIYOR (bkz. tunnel.js
     makeFakeRes) - orada cagirmak TypeError ile 500'e sebep olurdu, bu yuzden
     varligini kontrol etmeden guvenle varsayilan bos deger kullanilir. */
  const existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  if (!existing) return res.setHeader('Set-Cookie', cookieStr);
  res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookieStr] : [existing, cookieStr]);
}
function newSession(req, res, role) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ role, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const parts = [`qr_admin_session=${payload}.${sig}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (isHttps(req)) parts.push('Secure');
  addSetCookie(res, parts.join('; '));
}
/* 'admin-pending' (1. adim ile 2. adim/PIN arasindaki GECICI koprü) artik
   sunucu hafizasindaki Map'e DEGIL, imzali/durumsuz (stateless) bir cerezin
   kendisine dayanir (25.09.2026, kok neden: kullanicinin defalarca "PIN
   ekraninda takili kaliyoruz" bulgusu - gercek sebep, bu iki adim arasinda
   HERHANGI bir servis yeniden baslatmasinin (koddaki bir duzeltmenin
   dagitilmasi, NSSM'in kendi kendine yeniden baslatmasi vb.) o anki bekleyen
   oturumu sunucu hafizasindan silmesiydi). Imza anahtari activationKey'den
   turetildigi icin config.json degismedigi surece SERVIS KAC KEZ YENIDEN
   BASLARSA BASLASIN bu koprü kopmaz - kullanici PIN'i girene kadar gecen
   sure boyunca sunucu tarafinda hicbir sey saklanmiyor. */
function pendingSecret() { return crypto.createHash('sha256').update('qrmenu-pending:' + (license.activationKey() || 'no-key')).digest(); }
function newPendingCookie(req, res) {
  const exp = Date.now() + 10 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', pendingSecret()).update(payload).digest('base64url');
  const parts = [`qr_admin_pending=${payload}.${sig}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=600'];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearPendingCookie(res) { res.setHeader('Set-Cookie', 'qr_admin_pending=; Path=/; HttpOnly; Max-Age=0'); }
function hasValidPending(req) {
  const raw = parseCookies(req).qr_admin_pending || '';
  /* 29.09.2026: teshis loglari kaldirildi - cerez/imza degerlerini duz metin
     olarak server.log'a yaziyorlardi. Sadece SONUC (cerez/imza OLMADAN) loglanir. */
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = raw.slice(0, dot), sig = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', pendingSecret()).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    console.log('[login] gecici oturum imzasi gecersiz');
    return false;
  }
  try {
    const ok = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp > Date.now();
    if (!ok) console.log('[login] gecici oturum suresi dolmus');
    return ok;
  } catch (e) { return false; }
}

/* Girisim kilitlemesi (19.09.2026, 28.09.2026'da ADIMA GORE AYRILDI) - art arda
   basarisiz denemeden sonra gecici kilit. ESKIDEN step1 (bulut sifresi) ve
   step2 (SambaPOS PIN) AYNI IP sayacini paylasiyordu - bu, meşru bir
   kullanicinin dogru sifreyle step1'i gectikten sonra PIN'i birkac kez
   sasirmasinin (telefonda yazarken kolay olur), step1'e HIC dokunmadan bile
   TUM girisi (kendi dogru sifresiyle bile) 5 dakikaliğina kilitlemesine yol
   aciyordu (kullanici bulgusu: "sifre sorunu yine oldu kabul etmiyor").
   Simdi HER ADIMIN KENDI sayaci var (anahtar: "scope:ip"):
   - 'pw'  (step1, bulut sifresi)      -> sikı: 6 deneme / 5 dk kilit.
   - 'gpin' (garson-login, PIN TEK BASINA, sifre kapisi YOK) -> AYNI sikı kural.
   - 'pin' (step2, PIN - ama BURAYA ulasmak zaten gecerli bir sifre dogrulamasi
     gerektirir, yani PIN'i "taramak" isteyen biri once dogru sifreyi bilmeli) ->
     daha gevsek: 10 deneme / 2 dk kilit - hala 4 haneli PIN'i taramayi
     saatler surecek kadar yavaslatir, ama birkac yazim hatasinda kullaniciyi
     dogru sifresiyle bile disari kilitlemez. */
const loginAttempts = new Map(); // "scope:ip" -> { count, lockUntil }
const LOGIN_LOCK_THRESHOLD = 6, LOGIN_LOCK_MS = 5 * 60 * 1000;
const PIN_LOCK_THRESHOLD = 10, PIN_LOCK_MS = 2 * 60 * 1000;
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function loginLockedForMs(key) { const s = loginAttempts.get(key); return s && s.lockUntil > Date.now() ? s.lockUntil - Date.now() : 0; }
function registerLoginFail(key, threshold = LOGIN_LOCK_THRESHOLD, lockMs = LOGIN_LOCK_MS) {
  const s = loginAttempts.get(key) || { count: 0, lockUntil: 0 };
  s.count += 1;
  if (s.count >= threshold) { s.lockUntil = Date.now() + lockMs; s.count = 0; }
  loginAttempts.set(key, s);
}
function registerLoginSuccess(key) { loginAttempts.delete(key); }

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJsonBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > maxBytes) req.destroy(new Error('İstek çok büyük.')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

/* Urun adindan GUVENLI bir dosya adi turetir (resim yuklerken) - yol gecisi (../),
   gizli dosya (.baslangic) ve kontrol karakterleri ELENIR; Turkce harfler/bosluk/
   parantez KORUNUR (mevcut resimler zaten "İnegöl Köfte.jpg" gibi adlandirilmis,
   ayni kurala uyulur ki index.html'deki <img src="./İsim.jpg"> otomatik eslessin). */
function safeImageBaseName(itemName) {
  return String(itemName || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .trim()
    .slice(0, 120);
}
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
function findProductImage(itemName) {
  const base = safeImageBaseName(itemName);
  if (!base) return null;
  for (const ext of IMAGE_EXTS) {
    const file = path.join(ROOT, base + ext);
    if (file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return './' + base + ext;
  }
  return null;
}
/* data:image/jpeg;base64,... formatindaki bir gorseli diske yazar. Sadece jpeg/png
   kabul edilir (SVG/HTML gibi calisabilir icerik ASLA yuklenemez - XSS/kod calistirma
   riski). sharp ile otomatik dondurme (EXIF) + kucultme/sikistirma yapilir. */
async function saveDataUrlImage(itemName, dataUrl) {
  const match = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!match) throw new Error('Geçersiz görsel (sadece JPEG/PNG).');
  const base = safeImageBaseName(itemName);
  if (!base) throw new Error('Ürün adı geçersiz.');
  const ext = match[1] === 'png' ? '.png' : '.jpg';
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('Görsel çok büyük (8MB üstü).');
  const file = path.join(ROOT, base + ext);
  if (!file.startsWith(ROOT + path.sep)) throw new Error('Geçersiz dosya adı.');
  const resized = await resizeImageBuffer(buffer, ext, 1000);
  fs.writeFileSync(file, resized);
  return base + ext;
}
async function resizeImageBuffer(buffer, ext, maxDim) {
  try {
    const img = sharp(buffer).rotate().resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
    return ext === '.png' ? await img.png({ compressionLevel: 8 }).toBuffer() : await img.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  } catch (error) {
    console.error('Görsel küçültme hatası (orijinal kullanılıyor):', error.message);
    return buffer;
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.js': 'text/javascript; charset=utf-8' /* sadece PUBLIC_JS */ };

/* Logo HER YERDE (header, footer) ayni "./logo.png" yolunu kullaniyor - kullanici
   istegi (16.09.2026): "yönetimde her yeri değişsin". Yuklenen dosya PNG degilse
   (orn. JPEG) dosya adi uzantiya gore yazilir ve index.html/siparis.html'deki TUM
   "./logo.*" referanslari YENİ uzantiya guncellenir - boylece HANGI formatta
   yuklenirse yuklensin site her yerde dogru resmi gosterir. */
async function saveLogo(dataUrl) {
  const match = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!match) throw new Error('Geçersiz görsel (sadece JPEG/PNG).');
  const ext = match[1] === 'png' ? '.png' : '.jpg';
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('Görsel çok büyük (8MB üstü).');
  const resized = await resizeImageBuffer(buffer, ext, 500);
  for (const oldExt of ['.png', '.jpg', '.jpeg']) { try { fs.unlinkSync(path.join(ROOT, 'logo' + oldExt)); } catch { /* yoksa sorun degil */ } }
  fs.writeFileSync(path.join(ROOT, 'logo' + ext), resized);
  /* 27.09.2026: yeni.html/tv.html/garson/kiosk da logoyu gosteriyor - PNG
     yuklenince bunlar eski ./logo.jpg'de kaliyordu (kullanici bulgusu:
     "logo yüklüyorum ama eklenmiyor"). */
  for (const f of ['index.html', 'siparis.html', 'yeni.html', 'tv.html', 'garson.html', 'iletisim.html']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, 'utf8').replace(/\.\/logo\.(png|jpg|jpeg)/g, './logo' + ext);
    fs.writeFileSync(p, html, 'utf8');
  }
  return ext;
}

/* Bolge listesi (16.09.2026, kullanici istegi: "Paket Servis olunca bölge seçimi
   panelden yapılsın") - config.json'a KENDI alani olarak eklenir, SQL baglanti
   bilgilerine DOKUNULMAZ (sadece deliveryZones anahtari okunur/yazilir). */
const CONFIG_PATH = path.join(ROOT, 'config.json');
/* 27.09.2026 (yaşanan olay: "config.json bozulması, servis açılmıyordu -
   dosyanın sonundaki '}' eksikti") - fs.writeFileSync doğrudan hedef dosyaya
   yazarken servis o sırada kapanırsa/çökerse dosya YARIM yazılmış halde
   kalabiliyor. Artık önce aynı klasörde geçici bir dosyaya tam olarak
   yazılıp, ancak TAMAMLANDIKTAN SONRA fs.renameSync ile config.json'ın
   üzerine taşınıyor - rename işletim sistemi düzeyinde bölünemez (atomik)
   olduğu için config.json ya eski tam hali ya da yeni tam haliyle kalır,
   asla yarım kalmaz. */
function writeConfigAtomic(c) {
  const tmp = CONFIG_PATH + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}
function readDeliveryZones() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return Array.isArray(c.deliveryZones) ? c.deliveryZones : [];
  } catch { return []; }
}
function writeDeliveryZones(zones) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.deliveryZones = zones;
  writeConfigAtomic(c);
}
/* Ana sayfadaki kampanya slider'ı (kullanıcı isteği, 26.09.2026: "kampanyaları
   eklemek çıkartmak... 10 Lahmacun + Ayran koymuşsun onun gibi ve
   benzerlerini koymak nasıl olacak") - önceden JS içine SABİT kodlanmıştı,
   artık admin panelden yönetilebilir bir liste. Her kampanya: başlık, eski/
   yeni fiyat metni (serbest metin - "950 ₺" gibi, hesaplama yapılmaz) ve
   siparis.html'e gidince otomatik sepete eklenecek ürün/adet listesi. */
function readCampaigns() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return Array.isArray(c.campaigns) ? c.campaigns : [];
  } catch { return []; }
}
function writeCampaigns(campaigns) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.campaigns = Array.isArray(campaigns) ? campaigns.slice(0, 20).map(camp => ({
    title: String(camp.title || '').slice(0, 80),
    tag: String(camp.tag || 'Bugünün Fırsatı').slice(0, 40),
    oldPrice: String(camp.oldPrice || '').slice(0, 20),
    newPrice: String(camp.newPrice || '').slice(0, 20),
    imageUrl: String(camp.imageUrl || '').slice(0, 200),
    items: Array.isArray(camp.items) ? camp.items.slice(0, 10).map(i => ({ name: String(i.name || '').slice(0, 80), qty: Math.max(1, Math.min(99, Number(i.qty) || 1)) })).filter(i => i.name) : []
  })).filter(camp => camp.title) : [];
  writeConfigAtomic(c);
  return c.campaigns;
}
function readDirectOrderSend() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).directOrderSend === true; } catch { return false; }
}
function writeDirectOrderSend(enabled) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.directOrderSend = enabled === true;
  writeConfigAtomic(c);
}
/* Kiosk siparisleri icin AYRI anahtar (kullanici istegi, 27.09.2026: "kiosta
   paket servis gibi panele önce düşse ... veya kios direk gönder"). Ayar hic
   kaydedilmemisse (undefined) eski davranis korunur = dogrudan gonder. */
function readKioskDirectSend() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).kioskDirectOrderSend !== false; } catch { return true; }
}
function writeKioskDirectSend(enabled) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.kioskDirectOrderSend = enabled === true;
  writeConfigAtomic(c);
}
/* Garson (PIN-only) rolunun SambaPOS terminaline (garson-web/samba-lan)
   LAN disinda da erisebilmesi icin patronun manuel actigi anahtar - kullanici
   istegi (26.09.2026): "garson telefonlarına manuel izinde ver". Varsayilan
   KAPALI (LAN-only guvenli varsayilan), admin panelden actirilir. */
function readRemoteGarsonAllowed() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).remoteGarsonAllowed === true; } catch { return false; }
}
function writeRemoteGarsonAllowed(enabled) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.remoteGarsonAllowed = enabled === true;
  writeConfigAtomic(c);
}
/* Kiosk (self-servis siparis) ve TV Menu - kullanici istegi (26.09.2026):
   "panelden diğerleri gibi aç kapa seçeneği olacak, basınca nasıl açacağımı
   göstersin". Ikisi de AYRI, mevcut siparis akisina hic dokunmayan sistemler
   - kiosk siparis.html'i ?kiosk=1 ile, TV ise tv.html'i acar; kapaliyken
   ikisi de basit bir "kapali" ekrani gosterir (gercek veri donmez). */
function readKioskEnabled() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).kioskEnabled === true; } catch { return false; }
}
/* Kiosk "Kolay Mod" dugmesi panelden acilip kapatilir (29.09.2026) - varsayilan ACIK */
function readKioskA11yEnabled() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).kioskA11yEnabled !== false; } catch { return true; }
}
function writeKioskA11yEnabled(enabled) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.kioskA11yEnabled = enabled === true;
  writeConfigAtomic(c);
}
function writeKioskEnabled(enabled) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.kioskEnabled = enabled === true;
  writeConfigAtomic(c);
}
function readTvMenuEnabled() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).tvMenuEnabled === true; } catch { return false; }
}
function writeTvMenuEnabled(enabled) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.tvMenuEnabled = enabled === true;
  writeConfigAtomic(c);
}
/* TV Menü fon müziği (kullanici istegi, 26.09.2026: "restoran tarzı fon
   müzik olabilir mi" - SONRA "müzik ekleme yerine YouTube linki eklesek,
   saatlerce çalan TV YouTube müzikleri var, o link üzerine sürekli devam
   etse" - dosya yukleme yerine bir YouTube video linki/ID'si saklanir,
   TV sayfasi YouTube IFrame API ile o videoyu loop'layarak calar. */
const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
function extractYoutubeId(input) {
  const value = String(input || '').trim();
  if (YOUTUBE_ID_RE.test(value)) return value;
  const patterns = [/[?&]v=([a-zA-Z0-9_-]{11})/, /youtu\.be\/([a-zA-Z0-9_-]{11})/, /youtube\.com\/(?:embed|live|shorts)\/([a-zA-Z0-9_-]{11})/];
  for (const re of patterns) { const m = re.exec(value); if (m) return m[1]; }
  return null;
}
function readTvMusic() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* varsayilanlar kullanilir */ }
  return { enabled: c.tvMusicEnabled === true && !!c.tvMusicYoutubeId, youtubeId: c.tvMusicYoutubeId || null, volume: Number.isFinite(c.tvMusicVolume) ? c.tvMusicVolume : 50 };
}
function writeTvMusicSettings({ enabled, volume, youtubeUrl }) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (youtubeUrl !== undefined) {
    const id = extractYoutubeId(youtubeUrl);
    if (!id) throw new Error('Geçersiz YouTube linki.');
    c.tvMusicYoutubeId = id;
  }
  if (enabled !== undefined) c.tvMusicEnabled = enabled === true;
  if (volume !== undefined) c.tvMusicVolume = Math.max(0, Math.min(100, Number(volume) || 0));
  writeConfigAtomic(c);
}
/* TV ekstralari (29.09.2026, kullanici secimi): uzaktan kontrol (yenile, tek
   kategori goster, gece modu, otomatik kapanma), geri sayimli kampanya ve
   Google yorum bandi. Hepsi config.json > tvExtras altinda; TV ekrani herkese
   acik /api/tv-extras'i 20 sn'de bir okur (icinde gizli bilgi YOK). Google
   yorumlari API anahtari olmadan otomatik cekilemedigi icin panelden yazilir. */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function clipStr(v, max) { return String(v == null ? '' : v).replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max); }
function readTvExtras() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* varsayilanlar */ }
  const x = c.tvExtras || {}, cp = x.campaign || {}, rv = x.reviews || {};
  return {
    refreshAt: Number(x.refreshAt) || 0,
    pinCategory: clipStr(x.pinCategory, 120),
    night: x.night === true,
    offEnabled: x.offEnabled === true,
    offFrom: HHMM_RE.test(x.offFrom) ? x.offFrom : '23:30',
    offTo: HHMM_RE.test(x.offTo) ? x.offTo : '10:00',
    campaign: {
      enabled: cp.enabled === true,
      title: clipStr(cp.title, 80), text: clipStr(cp.text, 200), price: clipStr(cp.price, 20),
      itemName: clipStr(cp.itemName, 120),
      from: HHMM_RE.test(cp.from) ? cp.from : '00:00',
      until: HHMM_RE.test(cp.until) ? cp.until : '14:00'
    },
    /* Ezan vaktinde TV muzigini durdur (30.09.2026, kullanici istegi: "baska illerde
       musterilerim var, ezan saatinde muzik sussun, bitince devam etsin") */
    ezan: {
      enabled: !!(x.ezan && x.ezan.enabled === true),
      city: (x.ezan && IL_KOORD[x.ezan.city]) ? x.ezan.city : '',
      minutes: Math.max(1, Math.min(20, Math.round(Number(x.ezan && x.ezan.minutes) || 5)))
    },
    /* "Sefin notu" bandi (30.09.2026): panelden yazilan TANITIM notlari (yorum DEGIL - yildiz/
       musteri adi yok). Secilen araliga (saat) gore sirayla 3'er not doner. Ileride yapay zeka
       araci baglanirsa notlari o doldurabilir; gosterim ayni kalir. */
    notes: {
      enabled: !!(x.notes && x.notes.enabled === true),
      intervalHours: [2, 3, 4, 6].includes(Number(x.notes && x.notes.intervalHours)) ? Number(x.notes.intervalHours) : 3,
      items: ((x.notes && Array.isArray(x.notes.items)) ? x.notes.items : []).map(t => clipStr(t, 160)).filter(Boolean).slice(0, 40)
    },
    reviews: {
      enabled: rv.enabled === true,
      rating: Math.max(0, Math.min(5, Number(rv.rating) || 0)),
      count: Math.max(0, Math.floor(Number(rv.count) || 0)),
      items: (Array.isArray(rv.items) ? rv.items : []).slice(0, 15)
        .map(r => ({ name: clipStr(r && r.name, 40), text: clipStr(r && r.text, 220) })).filter(r => r.text)
    }
  };
}
function writeTvExtras(patch) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const cur = readTvExtras();
  const next = Object.assign({}, cur);
  for (const k of ['pinCategory', 'night', 'offEnabled', 'offFrom', 'offTo']) if (k in patch) next[k] = patch[k];
  if (patch.campaign) next.campaign = Object.assign({}, cur.campaign, patch.campaign);
  if (patch.reviews) next.reviews = Object.assign({}, cur.reviews, patch.reviews);
  if (patch.notes) next.notes = Object.assign({}, cur.notes, patch.notes);
  if (patch.ezan) {
    if (patch.ezan.city && !IL_KOORD[patch.ezan.city]) throw new Error('Geçersiz il.');
    next.ezan = Object.assign({}, cur.ezan, patch.ezan);
  }
  if (patch.refresh === true) next.refreshAt = Date.now();
  if (('offFrom' in patch && !HHMM_RE.test(patch.offFrom)) || ('offTo' in patch && !HHMM_RE.test(patch.offTo))) throw new Error('Saat SS:DD biçiminde olmalı (örn. 23:30).');
  if (patch.campaign && ((patch.campaign.from && !HHMM_RE.test(patch.campaign.from)) || (patch.campaign.until && !HHMM_RE.test(patch.campaign.until)))) throw new Error('Kampanya saatleri SS:DD biçiminde olmalı.');
  c.tvExtras = next;
  writeConfigAtomic(c);
  return readTvExtras();
}
/* ===================== Ezan vakitleri (30.09.2026) =====================
   Il merkez koordinatlari - vakitler AlAdhan'dan (ucretsiz, anahtarsiz) Diyanet hesabiyla
   (method=13) KOORDINATLA alinir: il ADIYLA sorgu bazi illeri yanlis yere (ör. Bursa ->
   Istanbul) esliyordu. Ayin tamami bir kerede alinip config'e yazilir; internet kesilse de
   o ay calisir. */
const IL_KOORD = {
  'Adana': [37.00, 35.32], 'Adıyaman': [37.76, 38.28], 'Afyonkarahisar': [38.76, 30.54], 'Ağrı': [39.72, 43.05], 'Aksaray': [38.37, 34.03],
  'Amasya': [40.65, 35.83], 'Ankara': [39.93, 32.86], 'Antalya': [36.89, 30.71], 'Ardahan': [41.11, 42.70], 'Artvin': [41.18, 41.82],
  'Aydın': [37.84, 27.84], 'Balıkesir': [39.65, 27.89], 'Bartın': [41.64, 32.34], 'Batman': [37.88, 41.13], 'Bayburt': [40.26, 40.23],
  'Bilecik': [40.14, 29.98], 'Bingöl': [38.88, 40.50], 'Bitlis': [38.40, 42.11], 'Bolu': [40.74, 31.61], 'Burdur': [37.72, 30.29],
  'Bursa': [40.19, 29.06], 'Çanakkale': [40.15, 26.41], 'Çankırı': [40.60, 33.62], 'Çorum': [40.55, 34.95], 'Denizli': [37.78, 29.09],
  'Diyarbakır': [37.91, 40.24], 'Düzce': [40.84, 31.16], 'Edirne': [41.68, 26.56], 'Elazığ': [38.68, 39.22], 'Erzincan': [39.75, 39.49],
  'Erzurum': [39.90, 41.27], 'Eskişehir': [39.78, 30.52], 'Gaziantep': [37.07, 37.38], 'Giresun': [40.91, 38.39], 'Gümüşhane': [40.46, 39.48],
  'Hakkari': [37.58, 43.74], 'Hatay': [36.20, 36.16], 'Iğdır': [39.92, 44.05], 'Isparta': [37.76, 30.55], 'İstanbul': [41.01, 28.98],
  'İzmir': [38.42, 27.14], 'Kahramanmaraş': [37.58, 36.94], 'Karabük': [41.20, 32.62], 'Karaman': [37.18, 33.22], 'Kars': [40.60, 43.10],
  'Kastamonu': [41.38, 33.78], 'Kayseri': [38.73, 35.49], 'Kilis': [36.72, 37.12], 'Kırıkkale': [39.85, 33.51], 'Kırklareli': [41.73, 27.22],
  'Kırşehir': [39.15, 34.16], 'Kocaeli': [40.77, 29.92], 'Konya': [37.87, 32.48], 'Kütahya': [39.42, 29.98], 'Malatya': [38.36, 38.31],
  'Manisa': [38.61, 27.43], 'Mardin': [37.31, 40.74], 'Mersin': [36.81, 34.64], 'Muğla': [37.22, 28.36], 'Muş': [38.75, 41.51],
  'Nevşehir': [38.62, 34.71], 'Niğde': [37.97, 34.68], 'Ordu': [40.98, 37.88], 'Osmaniye': [37.07, 36.25], 'Rize': [41.02, 40.52],
  'Sakarya': [40.78, 30.40], 'Samsun': [41.29, 36.33], 'Siirt': [37.93, 41.94], 'Sinop': [42.03, 35.15], 'Sivas': [39.75, 37.02],
  'Şanlıurfa': [37.16, 38.80], 'Şırnak': [37.52, 42.46], 'Tekirdağ': [40.98, 27.51], 'Tokat': [40.31, 36.55], 'Trabzon': [41.00, 39.72],
  'Tunceli': [39.11, 39.55], 'Uşak': [38.68, 29.41], 'Van': [38.49, 43.38], 'Yalova': [40.65, 29.27], 'Yozgat': [39.82, 34.81],
  'Zonguldak': [41.45, 31.79]
};
let ezanFetching = null;
function hhmm(s) { const m = /(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? m[1].padStart(2, '0') + ':' + m[2] : null; }
async function ezanTimesToday() {
  const ez = readTvExtras().ezan;
  if (!ez.enabled || !ez.city) return [];
  const d = new Date(), ym = d.getFullYear() + '-' + (d.getMonth() + 1);
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* bos */ }
  let cache = cfg.ezanCache;
  if (!cache || cache.city !== ez.city || cache.ym !== ym) {
    if (!ezanFetching) ezanFetching = (async () => {
      try {
        const [lat, lng] = IL_KOORD[ez.city];
        const r = await fetch(`https://api.aladhan.com/v1/calendar/${d.getFullYear()}/${d.getMonth() + 1}?latitude=${lat}&longitude=${lng}&method=13`, { signal: AbortSignal.timeout(15000) });
        const j = await r.json();
        const days = {};
        (j.data || []).forEach(x => {
          const day = Number(x.date && x.date.gregorian && x.date.gregorian.day);
          const t = x.timings || {};
          if (day) days[day] = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].map(k => hhmm(t[k])).filter(Boolean);
        });
        if (Object.keys(days).length) {
          const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
          c.ezanCache = { city: ez.city, ym, days };
          writeConfigAtomic(c);
          console.log(`[ezan] ${ez.city} ${ym} vakitleri alindi`);
        }
      } catch (e) { console.error('[ezan] vakitler alinamadi:', e.message); }
      finally { ezanFetching = null; }
    })();
    await ezanFetching;
    try { cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).ezanCache; } catch { cache = null; }
  }
  return (cache && cache.city === ez.city && cache.ym === ym && cache.days[d.getDate()]) || [];
}
/* ===================== Sefin notu - yapay zeka onerisi (30.09.2026) =====================
   Kullanici istegi: "sefin tavsiyesi yapay zeka oneri yapsin". Panelin AI Araclari ile ayni
   saglayicilar (Groq / Gemini). Yapay zekaya restoranin GERCEK menusu verilir; fiyat, "en cok
   satan" gibi dogrulanamayan iddia ve musteri yorumu taklidi YASAK (sistem talimatinda).
   Istege bagli: her gun kendiliginden yeni notlar. Anahtar sadece bu bilgisayarda
   (config.json) saklanir, tarayiciya geri GONDERILMEZ. */
function readNotesAi() {
  let c = {}; try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* bos */ }
  const a = c.notesAi || {};
  return { enabled: a.enabled === true, provider: ['evren', 'groq', 'gemini'].includes(a.provider) ? a.provider : 'evren', key: a.key || '', lastRunAt: a.lastRunAt || 0, lastError: a.lastError || '' };
}
function writeNotesAi(patch) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.notesAi = Object.assign({}, c.notesAi || {}, patch);
  writeConfigAtomic(c);
}
async function aiComplete(provider, key, system, prompt, opts) {
  const temperature = opts && Number.isFinite(opts.temperature) ? opts.temperature : 0.9;
  const maxTokens = opts && opts.maxTokens ? Math.min(4000, opts.maxTokens) : 1500;
  /* EVREN (SSB milli yapay zeka platformu, 30.09.2026): OpenAI uyumlu, anahtar "evren_llm_..." ile
     Bearer. model "auto" = platform uygun modeli secer; kabul edilmezse glm-5.3. JSON modu
     garanti olmadigi icin response_format gonderilmez - cevaptaki JSON ayiklanir. */
  if (provider === 'evren') {
    const call = async model => {
      const r = await fetch('https://evren-llmapi.ssyz.org.tr/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages: (system ? [{ role: 'system', content: system }] : []).concat([{ role: 'user', content: prompt }]) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        /* 403 terms_not_accepted: anahtar sahibi EVREN kullanim sartlarini henuz onaylamamis -
           onay KULLANICININ karari, panelde metin gosterilip onun basmasiyla yapilir */
        if (j.error && j.error.code === 'terms_not_accepted') { const t = new Error('EVREN kullanım şartları henüz onaylanmamış. Panelde şartları okuyup onaylayın.'); t.code = 'EVREN_TERMS'; t.status = 403; throw t; }
        const e = new Error((j.error && (j.error.message || j.error)) || ('Evren ' + r.status)); e.status = r.status; throw e;
      }
      return ((j.choices || [])[0] || { message: {} }).message.content || '';
    };
    try { return await call('auto'); }
    catch (e) {
      if (e.code === 'EVREN_TERMS') throw e;
      if (e.status === 401) throw new Error('Evren anahtarı geçersiz (401). Anahtar iptal edilmiş ya da yanlış olabilir; AI Araçları\'ndaki çalışan anahtar kullanılır.');
      return call('glm-5.3');   // "auto" kabul edilmediyse belirli modeli dene (hata olursa EVREN'in kendi mesaji gorunur)
    }
  }
  if (provider === 'gemini') {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45000),
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 1500, responseMimeType: 'application/json' } }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ('Gemini ' + r.status));
    return (((j.candidates || [])[0] || {}).content || { parts: [{}] }).parts[0].text || '';
  }
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(45000),
    body: JSON.stringify({ model: 'openai/gpt-oss-120b', temperature: 0.9, max_tokens: 1500, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Groq ' + r.status));
  return ((j.choices || [])[0] || { message: {} }).message.content || '';
}
let notesAiRunning = false;
/* Anahtar bicimi (30.09.2026): Chrome sifre alanini panel sifresiyle kendiliginden doldurup
   yanlis sey kaydedilmesin diye - saglayiciya gore on ek kontrolu */
function aiKeyLooksValid(provider, key) {
  const k = String(key || '');
  return provider === 'evren' ? k.startsWith('evren_llm_') : provider === 'groq' ? k.startsWith('gsk_') : provider === 'gemini' ? k.startsWith('AIza') : false;
}
/* override: panelin AI Araclari'nda kayitli anahtar (tek anahtar yeterli olsun diye) - basarili
   olursa bu bilgisayara da kaydedilir, "her gun otomatik yenile" onunla calisir */
async function generateChefNotes(override) {
  const saved = readNotesAi();
  const a = (override && override.key && aiKeyLooksValid(override.provider, override.key))
    ? Object.assign({}, saved, { provider: override.provider, key: override.key }) : saved;
  if (!a.key) throw new Error('Yapay zeka anahtarı yok. "✨ AI Araçları" sekmesinde anahtarı kaydedin ya da burada girin.');
  if (notesAiRunning) throw new Error('Zaten yazılıyor, birkaç saniye bekleyin.');
  notesAiRunning = true;
  try {
    const menu = await fetch(`http://127.0.0.1:${PORT}/api/menu?type=table`, { signal: AbortSignal.timeout(20000) }).then(r => r.json());
    const lines = (menu.categories || []).map(c => `${c.name}: ` + (c.items || []).map(i => i.name + (i.description ? ` (${String(i.description).slice(0, 70)})` : '')).join(', ')).join('\n').slice(0, 6000);
    if (!lines) throw new Error('Menü okunamadı (SambaPOS bağlantısını kontrol edin).');
    let company = ''; try { company = readSiteSettings().companyName || ''; } catch { /* bos */ }
    const system = 'Sen bir Türk restoranının şefisin. Restoranın TV ekranındaki kayan bantta "Şefin notu" başlığıyla gösterilecek kısa, samimi, iştah açıcı tavsiyeler yazarsın. ' +
      'KURALLAR: Sadece sana verilen menüdeki ürünlerden bahset, menüde olmayan ürün uydurma. Fiyat yazma. "En çok satan", "ödüllü", "herkes bayılıyor", "müşterilerimiz diyor ki" gibi doğrulanamayan iddialar ve müşteri yorumu taklidi YAZMA. ' +
      'Her not en fazla 110 karakter, en fazla 1 emoji. Türkçe yaz.';
    const prompt = `Restoran: ${company || 'restoranımız'}\nMenü:\n${lines}\n\n12 farklı şef notu yaz: 4'ü sabah-öğle, 4'ü öğleden sonra, 4'ü akşam için uygun olsun; farklı ürünlerden bahset. ` +
      'SADECE şu biçimde JSON döndür: {"notes":["...","..."]}';
    const raw = await aiComplete(a.provider, a.key, system, prompt);
    let notes = [];
    try { const s = String(raw).replace(/```(json)?/g, ''); notes = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)).notes || []; } catch { throw new Error('Yapay zeka cevabı okunamadı, tekrar deneyin.'); }
    notes = notes.map(t => clipStr(t, 160)).filter(t => t.length > 5).slice(0, 20);
    if (notes.length < 3) throw new Error('Yapay zeka yeterli not yazmadı, tekrar deneyin.');
    writeTvExtras({ notes: { items: notes } });
    writeNotesAi({ lastRunAt: Date.now(), lastError: '', provider: a.provider, key: a.key });
    console.log(`[sefin-notu] yapay zeka ${notes.length} not yazdi (${a.provider})`);
    return notes;
  } catch (e) {
    writeNotesAi({ lastError: e.message, lastRunAt: Date.now() });
    throw e;
  } finally { notesAiRunning = false; }
}
/* "Her gun otomatik yenile" aciksa: saatte bir bakar, son yazimdan 24 saat gectiyse yenisini yazar */
setInterval(() => {
  const a = readNotesAi();
  if (a.enabled && a.key && Date.now() - a.lastRunAt > 24 * 3600000) generateChefNotes().catch(e => console.error('[sefin-notu] yazilamadi:', e.message));
}, 60 * 60 * 1000);
/* ===================== Yorumlar (30.09.2026) =====================
   Uc kaynak TEK havuzda: (1) Google - isletmenin GERCEK yorumlari, Places API ile
   4 saatte bir cekilir (4-5 yildiz gosterilir); (2) musteri degerlendirmesi -
   siparis sonrasi, sadece "gosterilebilir" onayi veren 4-5 yildizlilar; (3) panelden
   elle girilen gercek yorumlar. Uydurma/yapay zeka yorumu YOK (kullaniciya soylendi:
   yaniltici reklam). Google kurali geregi Google yorumlari biriktirilmez, her
   cekimde en guncelleri tutulur ve "Google" kaynagi gosterilir.
   Havuzdan her 4 saatte bir farkli bir secki doner (TV bandi + QR menu seridi). */
const FEEDBACK_PATH = path.join(ROOT, 'customer-reviews.json');
const ROTATE_MS = 4 * 60 * 60 * 1000;
function readFeedback() { try { const a = JSON.parse(fs.readFileSync(FEEDBACK_PATH, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function writeFeedback(list) {
  const tmp = FEEDBACK_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list.slice(-500), null, 1), 'utf8');
  fs.renameSync(tmp, FEEDBACK_PATH);
}
function readGoogleCfg() {
  let c = {}; try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* bos */ }
  const g = c.googleReviews || {};
  return { apiKey: g.apiKey || '', placeId: g.placeId || '', placeName: g.placeName || '', lastFetchAt: g.lastFetchAt || 0, lastError: g.lastError || '',
    rating: Number(g.rating) || 0, count: Number(g.count) || 0, items: Array.isArray(g.items) ? g.items : [], menuEnabled: g.menuEnabled !== false };
}
function writeGoogleCfg(patch) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.googleReviews = Object.assign({}, c.googleReviews || {}, patch);
  writeConfigAtomic(c);
}
function writeReviewUrl() {
  const g = readGoogleCfg();
  if (g.placeId) return 'https://search.google.com/local/writereview?placeid=' + encodeURIComponent(g.placeId);
  try { return String(readSiteSettings().googleMaps || ''); } catch { return ''; }
}
async function googleFetch(url, opts, fieldMask) {
  const g = readGoogleCfg();
  if (!g.apiKey) throw new Error('Google API anahtarı girilmemiş.');
  const r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ 'X-Goog-Api-Key': g.apiKey, 'X-Goog-FieldMask': fieldMask, 'Content-Type': 'application/json' }, (opts && opts.headers) || {}), signal: AbortSignal.timeout(15000) }));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Google HTTP ' + r.status));
  return j;
}
async function searchGooglePlace(query) {
  const j = await googleFetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', body: JSON.stringify({ textQuery: String(query).slice(0, 200), languageCode: 'tr' }) },
    'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount');
  return (j.places || []).slice(0, 8).map(p => ({ placeId: p.id, name: (p.displayName && p.displayName.text) || '', address: p.formattedAddress || '', rating: p.rating || 0, count: p.userRatingCount || 0 }));
}
let googleFetching = false;
async function refreshGoogleReviews() {
  const g = readGoogleCfg();
  if (!g.apiKey || !g.placeId || googleFetching) return g;
  googleFetching = true;
  try {
    const j = await googleFetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(g.placeId) + '?languageCode=tr', { method: 'GET' }, 'rating,userRatingCount,reviews');
    const items = (j.reviews || []).map(r => ({
      name: clipStr(r.authorAttribution && r.authorAttribution.displayName, 40),
      text: clipStr((r.text && r.text.text) || (r.originalText && r.originalText.text), 300),
      rating: Number(r.rating) || 0, when: clipStr(r.relativePublishTimeDescription, 40)
    })).filter(r => r.text);
    writeGoogleCfg({ rating: Number(j.rating) || 0, count: Number(j.userRatingCount) || 0, items, lastFetchAt: Date.now(), lastError: '' });
    console.log(`[google-yorum] ${items.length} yorum alindi (puan ${j.rating}, ${j.userRatingCount} yorum)`);
  } catch (e) {
    writeGoogleCfg({ lastError: e.message, lastFetchAt: Date.now() });
    console.error('[google-yorum] alinamadi:', e.message);
  } finally { googleFetching = false; }
  return readGoogleCfg();
}
/* Havuz + 4 saatte bir degisen secki (ayni 4 saat icinde tum ekranlar AYNI seckiyi gosterir) */
function reviewPool() {
  const g = readGoogleCfg();
  const manual = readTvExtras().reviews;
  const pool = []
    .concat(g.items.filter(r => r.rating >= 4).map(r => ({ name: r.name, text: r.text, rating: r.rating, source: 'google' })))
    .concat(readFeedback().filter(f => f.consent && !f.hidden && f.rating >= 4 && f.text).map(f => ({ name: f.name || 'Misafirimiz', text: f.text, rating: f.rating, source: 'musteri' })))
    .concat(manual.items.map(r => ({ name: r.name, text: r.text, rating: manual.rating >= 4 ? Math.round(manual.rating) : 5, source: 'manuel' })));
  const bucket = Math.floor(Date.now() / ROTATE_MS);
  let seed = bucket % 2147483647 || 1;
  const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  for (let i = pool.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); const t = pool[i]; pool[i] = pool[k]; pool[k] = t; }
  const useGoogle = g.rating > 0;
  return { rating: useGoogle ? g.rating : manual.rating, count: useGoogle ? g.count : manual.count, source: useGoogle ? 'google' : 'manuel', items: pool.slice(0, 10) };
}
/* WhatsApp ile sipariş - admin panelinden aç/kapat (kullanıcı isteği:
   "panelden de whatsapp sipariş al kapat olsun"). Varsayılan AÇIK - numara
   girilmemişse zaten müşteri tarafında buton hiç görünmüyor. */
/* wa.me SADECE uluslararasi bicimi kabul eder (90532...). Panelde "0532 ..." ya da
   "532 ..." yazilirsa link gecersiz oluyordu (29.09.2026) - Turkiye numarasina cevrilir. */
function waNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = '90' + d.slice(1);
  else if (d.length === 10 && d.startsWith('5')) d = '90' + d;
  return d;
}
function readWhatsappOrderEnabled() {
  try { const v = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).whatsappOrderEnabled; return v !== false; } catch { return true; }
}
function writeWhatsappOrderEnabled(enabled) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.whatsappOrderEnabled = enabled === true;
  writeConfigAtomic(c);
}
/* "Hangi menüden ürünler çekilsin?" (kullanıcı isteği) - SambaPOS'ta birden
   fazla Ekran Menüsü olabilir (örn. "Menu" masada kullanılan, "QRMenu" bu
   sitenin kendisi için ayrılmış özel liste). Seçilmezse (null) TÜM ekran
   menüleri birleşik okunur - eski/varsayılan davranış, geriye dönük uyumlu. */
function readSambaposMenuId() {
  try { const v = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).sambaposMenuId; return v ? Number(v) : null; } catch { return null; }
}
function writeSambaposMenuId(id) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.sambaposMenuId = id ? Number(id) : null;
  writeConfigAtomic(c);
}
/* 27.09.2026 (kullanici istegi: "acılı/soğansız gibi seçenekler,
   SambaPOS'un kendi sistemiyle") - admin, restoranın SambaPOS'ta zaten
   tanımlı olan Sipariş Etiketi gruplarından BİRİNİ seçer; bu grubun
   etiketleri (Acılı, Soğansız vb.) QR Menü'de her üründe seçilebilir
   olarak gösterilir. Seçilmemişse (null) özellik tamamen kapalıdır. */
function readOrderTagGroupId() {
  try { const v = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).orderTagGroupId; return v ? Number(v) : null; } catch { return null; }
}
function writeOrderTagGroupId(id) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.orderTagGroupId = id ? Number(id) : null;
  writeConfigAtomic(c);
}
/* Admin panel girişinde PIN'e EK olarak zorunlu e-posta listesi (kullanıcı
   isteği: "girişlere mail ekle"). Boşsa (yapılandırılmamış) eski davranış
   (sadece PIN) geçerli kalır - geriye dönük uyumlu. */
function readAdminEmails() {
  try {
    const list = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).adminEmails;
    return Array.isArray(list) ? list.map(e => String(e).trim().toLocaleLowerCase('tr-TR')).filter(Boolean) : [];
  } catch { return []; }
}

/* Paket Servis konum kontrolü ayarları (kullanıcı isteği): işletme konumu +
   mesafe kademeleri (0-2km ücretsiz, 2-5km 30TL vb.) + "konum zorunlu mu?".
   Hiç yapılandırılmamışsa (businessLocation yok) özellik tamamen KAPALI
   kalır - eski bölge-dropdown davranışı hiç bozulmaz. */
function readDeliverySettings() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const ds = c.deliveryDistance || {};
    return {
      businessLocation: (ds.businessLocation && ds.businessLocation.lat && ds.businessLocation.lng) ? ds.businessLocation : null,
      tiers: Array.isArray(ds.tiers) ? ds.tiers : [],
      locationRequired: ds.locationRequired === true,
      feeMenuItemName: ds.feeMenuItemName || ''
    };
  } catch { return { businessLocation: null, tiers: [], locationRequired: false, feeMenuItemName: '' }; }
}
function writeDeliverySettings(input) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const lat = Number(input.businessLocation && input.businessLocation.lat);
  const lng = Number(input.businessLocation && input.businessLocation.lng);
  const tiers = Array.isArray(input.tiers) ? input.tiers.map(t => ({
    maxKm: Math.max(0, Number(t.maxKm) || 0),
    fee: Math.max(0, Number(t.fee) || 0),
    label: String(t.label || '').trim().slice(0, 60)
  })).filter(t => t.maxKm > 0).sort((a, b) => a.maxKm - b.maxKm).slice(0, 20) : [];
  c.deliveryDistance = {
    businessLocation: (Number.isFinite(lat) && Number.isFinite(lng) && lat && lng) ? { lat, lng } : null,
    tiers,
    locationRequired: input.locationRequired === true,
    feeMenuItemName: String(input.feeMenuItemName || '').trim().slice(0, 120)
  };
  writeConfigAtomic(c);
  return c.deliveryDistance;
}
/* Verilen mesafeye (km) göre uygun kademeyi bulur - kademeler maxKm'e göre
   küçükten büyüğe sıralıdır, mesafe İLK uyan kademenin sınırına eşit veya
   altındaysa o kademe geçerlidir. Hiçbiri uymuyorsa (mesafe hepsinden
   büyük) bölge dışı demektir. */
function matchDeliveryTier(distanceKmValue, tiers) {
  for (const tier of tiers) if (distanceKmValue <= tier.maxKm) return tier;
  return null;
}
function readOrderAcceptance() {
  try {
    const a = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).orderAcceptance;
    return { delivery: a?.delivery !== false, table: a?.table !== false, pickup: a?.pickup !== false };
  } catch { return { delivery: true, table: true, pickup: true }; }
}
function writeOrderAcceptance(input) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.orderAcceptance = { delivery: input.delivery !== false, table: input.table !== false, pickup: input.pickup !== false };
  writeConfigAtomic(c);
  return c.orderAcceptance;
}
const THEME_PRESETS = {
  mavi: { label: 'Mavi (varsayılan)', light: '#3498db', dark: '#007acc' },
  kirmizi: { label: 'Kırmızı', light: '#e74c3c', dark: '#c0392b' },
  yesil: { label: 'Yeşil', light: '#27ae60', dark: '#1e8e3e' },
  turuncu: { label: 'Turuncu', light: '#e67e22', dark: '#d35400' },
  mor: { label: 'Mor', light: '#9b59b6', dark: '#8e44ad' },
  lacivert: { label: 'Lacivert', light: '#2c3e50', dark: '#1a252f' },
  bordo: { label: 'Bordo (Premium)', light: '#7c1d1d', dark: '#4a1010' }
};
const DB_DETECT_SOURCES = [
  { label: 'AlfaPOS', file: 'C:\\ProgramData\\AlfaPOS\\AlfaPOS5\\AlfaSettings.txt' },
  { label: 'SambaPOS', file: 'C:\\ProgramData\\SAMBAPOS\\SambaPOS5\\SambaSettings.txt' }
];
function parseConnectionString(raw) {
  const out = {};
  for (const part of String(raw || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key === 'data source' || key === 'server') out.server = value;
    else if (key === 'initial catalog' || key === 'database') out.database = value;
    else if (key === 'user id' || key === 'uid') out.user = value;
    else if (key === 'password' || key === 'pwd') out.password = value;
  }
  return out;
}
function detectSambaposDb() {
  return DB_DETECT_SOURCES.map(src => {
    try {
      if (!fs.existsSync(src.file)) return { ...src, found: false };
      const xml = fs.readFileSync(src.file, 'utf8');
      const m = /<ConnectionString>([\s\S]*?)<\/ConnectionString>/.exec(xml);
      if (!m) return { ...src, found: false };
      const parsed = parseConnectionString(m[1]);
      if (!parsed.server && !parsed.database) return { ...src, found: false };
      return { ...src, found: true, server: parsed.server || '', database: parsed.database || '', user: parsed.user || '', password: parsed.password || '' };
    } catch (error) {
      return { ...src, found: false, error: error.message };
    }
  });
}
const SITE_SETTING_KEYS = ['companyName', 'slogan', 'phone', 'address', 'website', 'facebook', 'instagram', 'whatsapp', 'tiktok', 'youtube', 'twitter', 'googleMaps', 'domain', 'appDomain', 'theme', 'workingHours'];
function readSiteSettings() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).siteSettings || {}; } catch { return {}; }
}
function cleanSetting(value, max = 300) { return String(value || '').trim().slice(0, max); }
function writeSiteSettings(input) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  c.siteSettings = Object.fromEntries(SITE_SETTING_KEYS.map(key => [key, cleanSetting(input[key])]));
  writeConfigAtomic(c);
  return c.siteSettings;
}
function readDatabaseSettings() {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return { server: c.server || '', database: c.database || '', user: c.user || '', hasPassword: Boolean(c.password), sqlcmdPath: c.sqlcmdPath || '' };
}
function writeDatabaseSettings(input) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  /* 26.09.2026 KOK NEDEN DUZELTMESI: server/database/user ARTIK sadece
     GERCEKTEN gonderilmisse (bos/eksik degilse) guncellenir - password ile
     AYNI kural. Onceki halde bu alanlar KOSULSUZ yaziliyordu; caller bunlari
     hic göndermeden (orn. {} veya sadece baska alanlarla) cagirinca
     cleanSetting(undefined) -> '' donup GECERLI SQL baglanti bilgilerini
     SESSIZCE BOSALTIYORDU. Kullanici bulgusu: "ben değişmedim, sen güncelleme
     yapınca oldu" - alakasiz bir ekrandan gelen bir kayit SQL baglantisini
     tamamen kirmisti. sqlcmdPath ISTISNA - o zaten normalde bos birakilan,
     opsiyonel bir alan, kosulsuz yazilmaya devam eder. */
  if (input.server) c.server = cleanSetting(input.server, 150);
  if (input.database) c.database = cleanSetting(input.database, 150);
  if (input.user) c.user = cleanSetting(input.user, 150);
  c.sqlcmdPath = cleanSetting(input.sqlcmdPath, 300);
  if (input.password) c.password = String(input.password).slice(0, 300);
  writeConfigAtomic(c);
  return readDatabaseSettings();
}
function htmlEscape(value) { return String(value || '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
function renderSiteHtml(file, html) {
  const s = readSiteSettings();
  if (!s || !Object.keys(s).length) return html;
  const companyName = htmlEscape(s.companyName || 'Öz Urfa Yusuf Usta');
  const slogan = htmlEscape(s.slogan || "Bursa'nın Lezzet Durağı");
  let rendered = html.replace(/Öz Urfa Yusuf Usta|&Ouml;z Urfa Yusuf Usta/g, companyName)
    .replace(/Bursa'nın Lezzet Durağı|Bursa'n&#305;n Lezzet Dura&#287;&#305;/g, slogan);
  if (s.facebook) rendered = rendered.replace(/https:\/\/www\.facebook\.com\/[^"']*/g, htmlEscape(s.facebook));
  if (s.instagram) rendered = rendered.replace(/https:\/\/www\.instagram\.com\/[^"']*/g, htmlEscape(s.instagram));
  if (s.whatsapp) rendered = rendered.replace(/https:\/\/wa\.me\/[0-9]+/g, 'https://wa.me/' + waNumber(s.whatsapp));
  if (s.website) {
    rendered = rendered.replace(/https:\/\/ozurfayusufusta\.com/g, htmlEscape(s.website).replace(/&amp;/g, '&'));
    // Yukarıdaki href değişiminden SONRA kalan "ozurfayusufusta.com" artık SADECE
    // linkin görünür metni (kullanıcı isteği: "website değişince linkin yazısı da
    // değişsin" - önceden sadece href güncelleniyordu, görünen yazı eskide kalıyordu).
    const displayDomain = htmlEscape(String(s.website).trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''));
    if (displayDomain) rendered = rendered.replace(/ozurfayusufusta\.com/g, displayDomain);
  }
  /* TikTok/YouTube/X/Google Haritalar - kullanıcı isteği: "sosyal medya
     ikonlarını hepsi koy". Sadece admin ayarlarında link girilmişse ikon
     eklenir (bilmediğimiz/olmayan bir hesaba ASLA link vermeyiz). */
  const socialIcon = (bg, svgPath) => `<a href="${htmlEscape(url)}" target="_blank" style="width:46px;height:46px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.25);"><svg width="22" height="22" viewBox="0 0 24 24" fill="white">${svgPath}</svg></a>`;
  let url;
  if (s.tiktok) { url = s.tiktok; rendered = rendered.replace('<!--SOCIAL_EXTRA_TIKTOK-->', socialIcon('#000', '<path d="M16.6 5.82c-.9-.6-1.5-1.6-1.6-2.72h-3.1v13.3c0 1.6-1.3 2.9-2.9 2.9s-2.9-1.3-2.9-2.9 1.3-2.9 2.9-2.9c.3 0 .6.05.85.13v-3.15c-.28-.04-.56-.06-.85-.06-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6V9.4c1.2.85 2.66 1.35 4.2 1.35V7.65c-.9 0-1.75-.28-2.5-.75-.4-.25-.75-.55-1.1-.9-.3-.3-.55-.65-.75-1.1z"/>')); }
  if (s.youtube) { url = s.youtube; rendered = rendered.replace('<!--SOCIAL_EXTRA_YOUTUBE-->', socialIcon('#ff0000', '<path d="M22 12s0-3.2-.4-4.7c-.24-.9-.94-1.6-1.84-1.84C18.05 5 12 5 12 5s-6.05 0-7.76.46c-.9.24-1.6.94-1.84 1.84C2 8.8 2 12 2 12s0 3.2.4 4.7c.24.9.94 1.6 1.84 1.84C5.95 19 12 19 12 19s6.05 0 7.76-.46c.9-.24 1.6-.94 1.84-1.84.4-1.5.4-4.7.4-4.7ZM10 15.2V8.8l5.5 3.2Z"/>')); }
  if (s.twitter) { url = s.twitter; rendered = rendered.replace('<!--SOCIAL_EXTRA_TWITTER-->', socialIcon('#000', '<path d="M18.9 3H21.7l-6.1 7 6.9 10.9h-5.4l-4.2-6.6-4.8 6.6H2.3l6.5-8.9L2.2 3h5.5l3.9 6.1L18.9 3Zm-1.9 16.2h1.7L7.1 4.7H5.3l11.7 14.5Z"/>')); }
  if (s.googleMaps) { url = s.googleMaps; rendered = rendered.replace('<!--SOCIAL_EXTRA_MAPS-->', socialIcon('#4285f4', '<path d="M12 2C7.6 2 4 5.6 4 10c0 5.4 6.8 11.2 7.4 11.7.35.3.85.3 1.2 0C13.2 21.2 20 15.4 20 10c0-4.4-3.6-8-8-8Zm0 10.8a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6Z"/>')); }
  /* Boş kalan marker'ları temizle */
  rendered = rendered.replace(/<!--SOCIAL_EXTRA_[A-Z]+-->/g, '');
  const theme = THEME_PRESETS[s.theme] || THEME_PRESETS.mavi;
  rendered = rendered.replace(/--brand:#3498db;/g, `--brand:${theme.light};`).replace(/--brand:#007acc;/g, `--brand:${theme.dark};`);
  /* Ana sayfadaki "Ara" hızlı işlem butonu ve "Yol Tarifi" butonu - kullanıcı
     isteği (25.09.2026, mockup referansı): ana ekranda hızlı arama/yol tarifi
     erişimi. Aynı varsayılan telefon numarasını (WhatsApp'la paylaşılan) ve
     varsayılan Google Haritalar arama linkini gerçek ayarlarla değiştirir. */
  if (s.phone) rendered = rendered.replace(/tel:\+?[0-9]+/g, 'tel:' + encodeURIComponent(s.phone.replace(/\D/g, ''))).replace(/(Telefon:<\/strong>\s*<a[^>]*>)[^<]*/i, `$1${htmlEscape(s.phone)}`);
  if (s.googleMaps) rendered = rendered.replace(/https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=[^"']*/g, htmlEscape(s.googleMaps));
  if (file === 'iletisim.html' && s.address) rendered = rendered.replace(/Arabayatağı Mah\. 1\.Aras Sokak No:18, Yıldırım\/Bursa/g, htmlEscape(s.address));
  return rendered;
}
/* manifest.webmanifest'teki PWA adı (kullanıcı isteği: "her yeri değişsin") -
   renderSiteHtml() SADECE HTML dosyalarını işliyor; bu JSON olduğu için HTML
   kaçışı (htmlEscape) YANLIŞ olur, ayrı ve JSON-güvenli bir kaçış kullanılır. */
function renderManifestJson(text) {
  const s = readSiteSettings();
  const name = s && s.companyName ? String(s.companyName).trim() : '';
  if (!name) return text;
  const esc = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return text.replace(/"Öz Urfa Yusuf Usta"/g, `"${esc}"`).replace(/"Yusuf Usta"/g, `"${esc}"`);
}
function readOrders() {
  try { const orders = JSON.parse(fs.readFileSync(ORDERS_PATH, 'utf8')); return Array.isArray(orders) ? orders : []; } catch { return []; }
}
function writeOrders(orders) { fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders.slice(-500), null, 2), 'utf8'); }

const WAITER_CALL_TYPES = { garson: 'Garson çağırıyor', hesap: 'Hesap istiyor', su: 'Su istiyor', ekstra: 'Ekstra servis istiyor' };
function readCalls() {
  try { const calls = JSON.parse(fs.readFileSync(CALLS_PATH, 'utf8')); return Array.isArray(calls) ? calls : []; } catch { return []; }
}
function writeCalls(calls) { fs.writeFileSync(CALLS_PATH, JSON.stringify(calls.slice(-300), null, 2), 'utf8'); }
/* Ayrı bir native Android "garson" uygulaması, çerez tabanlı admin oturumu
   yerine bu paylaşılan anahtarla kimlik doğrular (config.json.waiterAppKey). */
function readWaiterAppKey() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).waiterAppKey || ''; } catch { return ''; }
}

/* Tam sayfa duzenleyici (17.09.2026, kullanici istegi: "her yere admin panelden
   müdahale olması gerekiyor, her yeri değişebilir olsun") - sitedeki her HTML
   sayfasinin HAM kaynagini panelden gorup duzenleyip kaydedebilmek icin. SADECE
   bilinen/izinli sayfa dosyalari (asagidaki liste) duzenlenebilir - kok dizindeki
   sunucu kaynak dosyalarina (server.js, sql.js, sambapos.js, config.json, .env)
   ASLA erisilemez. Her kaydetmeden once otomatik .bak yedegi alinir.
   MenuEditor (regenerate-menu/apply-price) ile YARIS DURUMUNU onlemek icin ayni
   dosyaya yazma islemleri de bu ALLOWLIST'i kullanir. */
const EDITABLE_PAGES = new Set(['index.html', 'siparis.html', 'garson.html', 'iletisim.html', 'gizlilik-politikasi.html', 'admin/index.html', 'tv.html']);
/* "kiosk" panelin Sayfalar listesinde GORUNMESI icin (kullanici istegi,
   26.09.2026, 3 kez tekrarlandi: "panelde sayfa düzeninde kios görünsün") -
   ayri bir dosya DEGIL, gercekte siparis.html'in kendisi (kiosk zaten ?kiosk=1
   ile onun bir modu) - boylece iki ayri kopya birbirinden SAPMAZ, kiosk gorunumu
   duzenlemek = siparis.html'i duzenlemek. */
function resolvePageAlias(name) { return name === 'kiosk' ? 'siparis.html' : name; }
function readEditablePage(name) {
  const real = resolvePageAlias(name);
  if (!EDITABLE_PAGES.has(real)) throw new Error('Bu dosya düzenlenemez.');
  return fs.readFileSync(path.join(ROOT, real), 'utf8');
}
function writeEditablePage(name, content) {
  const real = resolvePageAlias(name);
  if (!EDITABLE_PAGES.has(real)) throw new Error('Bu dosya düzenlenemez.');
  if (typeof content !== 'string' || !content.trim()) throw new Error('İçerik boş olamaz.');
  const file = path.join(ROOT, real);
  try { fs.copyFileSync(file, file + '.bak'); } catch { /* ilk kayit, yedeklenecek dosya yok */ }
  fs.writeFileSync(file, content, 'utf8');
}

/* SambaPOS'un KENDI resmi HTML5 garson terminali (masa duzeni + gercek adisyon
   ekrani, ticket.html/index.html) - kullanici istegi (26.09.2026): "qr menude
   olmayan bu, bu konumdaki garsonu istiyorum" - kendi basit onay/masa panelimizin
   YANINA, SambaPOS'un kendi SignalR/GraphQL tabanli tam siparis terminali eklenir.
   Bu klasor kendi css/js/resimlerini RELATIF yollarla cektigi icin ayri, ozel bir
   statik sunucu (ana ALLOWED_EXT'te .js YOK - kaynak kod sizmasin diye - ama bu
   SABIT, bilinen klasor icin .js/.css'e izin vermek guvenli). */
const GARSON_WEB_ROOT = path.join(ROOT, 'garson-web');
const GARSON_WEB_EXT = new Set(['.html', '.htm', '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.map']);
function serveGarsonWeb(req, res, subPath) {
  let rel = decodeURIComponent(subPath || '');
  if (!rel || rel === '/') rel = '/index.html';
  const file = path.join(GARSON_WEB_ROOT, rel);
  const ext = path.extname(file).toLowerCase();
  if (!file.startsWith(GARSON_WEB_ROOT + path.sep) || !GARSON_WEB_EXT.has(ext) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bulunamadı');
  }
  const type = ext === '.js' ? 'text/javascript; charset=utf-8' : (TYPES[ext] || 'application/octet-stream');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

/* /samba-lan: tarayicidan (garson-web icindeki Queries.js/SignalR.js) SambaPOS'un
   KENDI Mesaj Sunucusuna (Terminal/GraphQL+SignalR, sabit port 9000) duz bir HTTP
   koprusu. Bu sunucu ZATEN restoranin kendi bilgisayarinda calistigi icin hedef
   HER ZAMAN 127.0.0.1 - LAN IP/router cihaz izolasyonu sorunlarindan tamamen
   bagimsiz olur (onceki kullanici bulgusu: "router izolasyonu yuzunden telefon
   192.168.1.x:9000'e ulasamiyordu"). SambaPOS'un GraphQL/ticket sorgulari adisyon
   OLUSTURUP DEGISTIREBILDIGI icin (fiili tam POS erisimi) sadece giris yapmis
   admin/garson oturumuna acik - oturumsuz istekler 401 doner. */
function proxySambaposLan(req, res, u) {
  if (!isAuthed(req)) return json(res, 401, { error: 'Giriş gerekli.' });
  const subPath = u.pathname.slice('/samba-lan'.length) || '/';
  const options = {
    hostname: '127.0.0.1',
    port: 9000,
    path: subPath + (u.search || ''),
    method: req.method,
    headers: Object.assign({}, req.headers, { host: '127.0.0.1:9000' }),
  };
  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    if (!res.headersSent) json(res, 502, { error: 'SambaPOS mesaj sunucusuna erişilemedi.' });
    else res.end();
  });
  /* req.pipe() KULLANILMAZ - tunnel.js'in sahte istek nesnesi (bkz. makeFakeReq)
     duz bir EventEmitter, gercek Readable stream olmadigi icin .pipe() metodu
     YOK. data/end olaylarini elle yonlendirmek HER IKI durumda (gercek LAN
     istegi + tunel) da calisir - ikisi de aynen bu iki olayi yayinlar. */
  req.on('data', chunk => proxyReq.write(chunk));
  req.on('end', () => proxyReq.end());
}

function serveStatic(req, res, pathname) {
  /* 27.09.2026: ana adres yeni arayuzu (yeni.html) acar; eski sayfa /eski'de durur */
  const map = { '/': '/yeni.html', '/eski': '/index.html', '/siparis': '/siparis.html', '/garson': '/garson.html', '/iletisim': '/iletisim.html', '/index': '/yeni.html', '/gizlilik-politikasi': '/gizlilik-politikasi.html', '/tv': '/tv.html', '/yeni': '/yeni.html' };
  let rel = decodeURIComponent(map[pathname] || pathname);
  /* logo.jpg / logo.png hangisi yuklendiyse o verilir (eski linkler kirilmasin) */
  if (/^\/logo\.(png|jpe?g)$/i.test(rel) && !fs.existsSync(path.join(ROOT, rel))) {
    const alt = ['/logo.png', '/logo.jpg', '/logo.jpeg'].find(n => fs.existsSync(path.join(ROOT, n)));
    if (alt) rel = alt;
  }
  const file = path.join(ROOT, rel);
  const base = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  if (!file.startsWith(ROOT + path.sep) || DENY_BASENAMES.has(base) || base.startsWith('.') || !(ALLOWED_EXT.has(ext) || PUBLIC_JS.has(base))
    || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bulunamadı');
  }
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600' });
  if (ext === '.html' && ['index.html', 'siparis.html', 'iletisim.html', 'tv.html', 'yeni.html'].includes(base)) {
    let out = renderSiteHtml(base, fs.readFileSync(file, 'utf8'));
    /* 30.09.2026: yorum seridi - index.html restoranin verisi oldugu icin (menu duzenleyici
       yazar) dosyaya DOKUNULMAZ, betik burada sayfaya eklenir. */
    if ((base === 'index.html' || base === 'yeni.html') && !out.includes('reviews-strip.js')) out = out.replace(/<\/body>/i, '<script src="./reviews-strip.js" defer></script></body>');
    return res.end(out);
  }
  if (ext === '.webmanifest' && base === 'manifest.webmanifest') return res.end(renderManifestJson(fs.readFileSync(file, 'utf8')));
  fs.createReadStream(file).pipe(res);
}

async function handleRequest(req, res) {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    /* Lisans kapisi - TUM rotalardan ONCE kontrol edilir (kurulum sihirbazi
       aktivasyon anahtarini config.json'a ZATEN yazdigi icin uygulama ici
       ayri bir "anahtar gir" ekranina gerek yok; lisanssiz/suresi gecmisse
       hicbir sayfa/uc gercek veri DONDURMEZ - bkz. license.js). */
    if (!license.isLicensed()) {
      if (u.pathname.startsWith('/api/')) return json(res, 402, { error: license.licenseError() || 'Lisansınız aktif değil.' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html lang="tr"><meta charset="utf-8"><title>Lisans Gerekli</title>
        <body style="font-family:system-ui;max-width:520px;margin:60px auto;padding:0 20px;text-align:center;color:#333">
        <h2>🔒 Lisansınız Aktif Değil</h2>
        <p>${htmlEscape(license.licenseError() || 'Lisans doğrulanamadı.')}</p>
        <p>Devam etmek için AlfaPOS ile iletişime geçin.</p></body></html>`);
    }

    if (u.pathname === '/garson.apk') {
      const file = path.join(ROOT, 'garson-app.apk');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'Bulunamadı' });
      res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="AlfaPOS-Garson.apk"', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }

    /* Herkese acik: ana sayfadaki kampanya listesi. */
    if (u.pathname === '/api/campaigns' && req.method === 'GET') {
      return json(res, 200, { campaigns: readCampaigns() });
    }
    if (u.pathname === '/api/admin/campaigns' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { campaigns: readCampaigns() });
    }
    if (u.pathname === '/api/admin/campaigns' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        /* Kullanici bulgusu (26.09.2026): "benim oluşturduğum kampanyalar
           sepete eklenmiyor" - kok neden, "Ürünler" alanina GERCEK urun adi
           yerine pazarlama cumlesi ("üstelik yanına 3 ayran hediye") yazilmasi
           - musteri tikladiginda isim menude hic bulunamiyor, sessizce hicbir
           sey eklenmiyordu. Admin panelindeki urun dropdown'u bu sorunu artik
           kokten cozuyor (sadece gercek isimler secilebiliyor), ama BURADA
           HALA eslesmeyen isimleri SESSIZCE FILTRELIYORUZ - defans amacli.
           ONEMLI DUZELTME (ayni gun, kok neden bulundu): bu kontrol ONCEDEN
           TUM istegi (kaydedilmek istenen TUM kampanyalari, sadece yeni/
           degisen olani DEGIL) 400 ile REDDEDIYORDU - yani listede ESKIDEN
           kalma TEK bir bozuk kampanya (orn. "Künefe") varsa, kullanici
           YENI ve GECERLI bir kampanya bile KAYDEDEMIYORDU. Artik sadece o
           kampanyanin GECERSIZ satirlari sessizce cikarilir, kaydetme ASLA
           engellenmez - admin'e sadece bilgi amacli uyari donulur. */
        const categories = await sambapos.liveMenu({ screenMenuId: readSambaposMenuId() }).catch(() => []);
        const realNames = new Set(categories.flatMap(c => c.items.map(i => i.name.trim().toLocaleLowerCase('tr-TR'))));
        const warnings = [];
        const cleaned = (body.campaigns || []).map(camp => {
          const items = (camp.items || []).filter(item => {
            const ok = item.name && realNames.has(String(item.name).trim().toLocaleLowerCase('tr-TR'));
            if (!ok && item.name) warnings.push(`"${item.name}" (${camp.title}) menüde bulunamadı, çıkarıldı`);
            return ok;
          });
          return { ...camp, items };
        });
        return json(res, 200, { ok: true, campaigns: writeCampaigns(cleaned), warnings });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/campaign-image' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req, 12 * 1024 * 1024);
        if (!body.dataUrl) return json(res, 400, { error: 'Görsel eksik.' });
        const savedAs = await saveDataUrlImage('kampanya-' + Date.now(), body.dataUrl);
        return json(res, 200, { ok: true, imageUrl: './' + savedAs });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    /* Herkese acik: teslimat bolgesi listesi (siparis.html'in checkout formu icin). */
    if (u.pathname === '/api/delivery-zones' && req.method === 'GET') {
      const ds = readDeliverySettings();
      const site = readSiteSettings();
      return json(res, 200, { zones: readDeliveryZones(), locationEnabled: !!ds.businessLocation, locationRequired: ds.locationRequired, whatsapp: readWhatsappOrderEnabled() ? waNumber(site.whatsapp) : '', workingHours: String(site.workingHours || '') });
    }
    /* Kiosk modu siparis.html'in KENDI JS'inde (?kiosk=1) aktiflesir - o karari
       verebilmesi icin genel/herkese acik, kucuk bir bayrak ucu (kimlik
       dogrulama GEREKMEZ, sadece true/false doner, hassas veri yok). */
    if (u.pathname === '/api/tv-extras' && req.method === 'GET') {
      /* TV bandi artik birlesik havuzu (Google + musteri + elle) gosterir */
      const x = readTvExtras();
      const p = reviewPool();
      x.reviews = Object.assign({}, x.reviews, { rating: p.rating, count: p.count, source: p.source, items: p.items });
      /* Sefin notu: bu zaman dilimine (intervalHours) dusen 3 not - dilim degisince siradaki 3 */
      if (x.notes.enabled && x.notes.items.length) {
        const n = x.notes.items, per = Math.min(3, n.length);
        const slot = Math.floor(Date.now() / (x.notes.intervalHours * 3600000));
        const start = (slot * per) % n.length;
        x.notes = { enabled: true, current: Array.from({ length: per }, (_, i) => n[(start + i) % n.length]) };
      } else x.notes = { enabled: false, current: [] };
      /* Ezan: bugunun 5 vakti (TV muzigi bu vakitlerde x.ezan.minutes dk durur) */
      x.ezan = { enabled: x.ezan.enabled && !!x.ezan.city, city: x.ezan.city, minutes: x.ezan.minutes, times: x.ezan.enabled ? await ezanTimesToday() : [] };
      return json(res, 200, x);
    }
    /* QR menu yorum seridi (30.09.2026) - kiosk'ta gosterilmez (kullanici karari) */
    if (u.pathname === '/api/reviews' && req.method === 'GET') {
      const x = readTvExtras(), p = reviewPool(), g = readGoogleCfg();
      return json(res, 200, { enabled: x.reviews.enabled && g.menuEnabled && p.items.length > 0, rating: p.rating, count: p.count, source: p.source, items: p.items, writeReviewUrl: writeReviewUrl() });
    }
    /* Musteri degerlendirmesi (siparis sonrasi). 4-5 yildiz + onay -> havuza girer;
       1-3 yildiz sadece panelde isletmeye gorunur. IP basina saatte 3. */
    if (u.pathname === '/api/feedback' && req.method === 'POST') {
      const fbKey = 'fb:' + clientIp(req);
      if (loginLockedForMs(fbKey) > 0) return json(res, 429, { error: 'Çok sık değerlendirme gönderildi, biraz sonra tekrar deneyin.' });
      const body = await readJsonBody(req, 5000);
      const rating = Math.round(Number(body.rating));
      if (!(rating >= 1 && rating <= 5)) return json(res, 400, { error: 'Lütfen 1-5 arası yıldız seçin.' });
      const list = readFeedback();
      list.push({ id: crypto.randomBytes(6).toString('hex'), at: Date.now(), rating, text: clipStr(body.text, 300), name: clipStr(body.name, 40),
        consent: body.consent === true, table: clipStr(body.table, 30), hidden: false });
      writeFeedback(list);
      registerLoginFail(fbKey, 3, 60 * 60 * 1000);
      return json(res, 200, { ok: true, writeReviewUrl: rating >= 4 ? writeReviewUrl() : '' });
    }
    if (u.pathname === '/api/site-flags' && req.method === 'GET') {
      const music = readTvMusic();
      return json(res, 200, { kioskEnabled: readKioskEnabled(), kioskA11yEnabled: readKioskA11yEnabled(), tvMenuEnabled: readTvMenuEnabled(), tvMusicEnabled: music.enabled, tvMusicYoutubeId: music.youtubeId, tvMusicVolume: music.volume });
    }
    /* TV menunun kosesindeki QR kodu icin (27.09.2026) - SADECE herkese acik
       musteri menu adresi (menu.ornek-alanadi.com/<slug>) doner; baska hicbir bilgi yok.
       Tunel henuz kurulmadiysa null doner, TV bu durumda QR gostermez. */
    /* Herkese acik firma bilgisi (27.09.2026) - yeni.html / tv.html bunu okur.
       HTML'deki sabit ornek degerlere (Oz Urfa telefonu/sosyal medyasi)
       guvenilmez: ayar bossa o bilgi sayfada HIC gosterilmez. Sadece zaten
       sitede herkese gorunen alanlar doner (SQL/anahtar bilgisi YOK). */
    if (u.pathname === '/api/site-info' && req.method === 'GET') {
      const s = readSiteSettings() || {};
      const pick = k => String(s[k] || '').trim();
      return json(res, 200, {
        companyName: pick('companyName'), slogan: pick('slogan'), phone: pick('phone'), address: pick('address'),
        whatsapp: pick('whatsapp').replace(/\D/g, ''), facebook: pick('facebook'), instagram: pick('instagram'),
        tiktok: pick('tiktok'), youtube: pick('youtube'), twitter: pick('twitter'), googleMaps: pick('googleMaps'),
        website: pick('website'), workingHours: pick('workingHours'), theme: pick('theme') || 'mavi'
      });
    }
    if (u.pathname === '/api/menu-link' && req.method === 'GET') {
      const info = tunnelModule && tunnelModule.getSiteInfo ? tunnelModule.getSiteInfo() : null;
      return json(res, 200, { menuBaseUrl: info ? info.menuBaseUrl : null });
    }
    if (u.pathname === '/api/admin/whatsapp-order' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { enabled: readWhatsappOrderEnabled() });
    }
    if (u.pathname === '/api/admin/whatsapp-order' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        writeWhatsappOrderEnabled(body.enabled === true);
        return json(res, 200, { ok: true, enabled: readWhatsappOrderEnabled() });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    /* Hangi sipariş türleri şu an kabul ediliyor - herkese açık (siparis.html
       sayfa açılışında kontrol edip kapalıysa "sipariş kapalı" ekranı gösterir). */
    if (u.pathname === '/api/order-acceptance' && req.method === 'GET') {
      return json(res, 200, readOrderAcceptance());
    }
    /* Müşteri QR'ı tekrar okuttuğunda masasının güncel siparişini görmesi için. */
    if (u.pathname === '/api/table-status' && req.method === 'GET') {
      try {
        const table = String(u.searchParams.get('table') || '').trim().slice(0, 20);
        if (!table) return json(res, 400, { error: 'Masa numarası eksik.' });
        const summary = await sambapos.getTableOrderSummary(table);
        return json(res, 200, summary || { items: [], total: 0 });
      } catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/order-acceptance' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, readOrderAcceptance());
    }
    if (u.pathname === '/api/admin/order-acceptance' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        return json(res, 200, { ok: true, ...writeOrderAcceptance(body) });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/kitchen-printer' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      let printers = [];
      try {
        const out = await new Promise((resolve, reject) => {
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'], { windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout));
        });
        printers = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      } catch { }
      let categories = [];
      let sambaSuggested = {};
      try {
        const cats = await sambapos.liveMenu({ screenMenuId: readSambaposMenuId() });
        categories = cats.map(c => c.name);
        sambaSuggested = (await sambapos.getKitchenPrinterRouting()).byCategory;
      } catch (e) { console.error('Kategori listesi alınamadı:', e.message); }
      return json(res, 200, { ...readKitchenPrinter(), availablePrinters: printers, categories, sambaSuggested });
    }
    if (u.pathname === '/api/admin/kitchen-printer' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        return json(res, 200, { ok: true, ...writeKitchenPrinter(body) });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/kitchen-printer/test' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      printOrderToKitchen({ type: 'table', tableNumber: 'TEST', customerName: 'Test Yazdırma', items: [{ name: 'TEST ÜRÜNÜ', quantity: 1 }], total: 0, note: 'Bu bir test çıktısıdır.' }, 0);
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/admin/db-detect' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { sources: detectSambaposDb() });
    }
    /* Herkese açık: müşterinin paylaştığı konuma göre mesafe/servis ücreti/
       bölge dışı kontrolü (kullanıcı isteği: "konum doğrulanır, mesafe
       hesaplanır, bölgeye göre servis ücreti belirlenir, bölge dışıysa
       sipariş engellenebilir"). */
    if (u.pathname === '/api/delivery-check' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const lat = Number(body.lat), lng = Number(body.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json(res, 400, { error: 'Konum eksik.' });
        const ds = readDeliverySettings();
        if (!ds.businessLocation) return json(res, 400, { error: 'Konum kontrolü yapılandırılmamış.' });
        const { km, method } = await distanceKm(ds.businessLocation.lat, ds.businessLocation.lng, lat, lng);
        const tier = matchDeliveryTier(km, ds.tiers);
        if (!tier) return json(res, 200, { allowed: false, distanceKm: +km.toFixed(2), method, message: 'Bu adres servis bölgemiz dışında. Lütfen bizi arayın.' });
        return json(res, 200, { allowed: true, distanceKm: +km.toFixed(2), method, fee: tier.fee, label: tier.label });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }
    if (u.pathname === '/api/admin/delivery-distance' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, readDeliverySettings());
    }
    if (u.pathname === '/api/admin/delivery-distance' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        return json(res, 200, { ok: true, ...writeDeliverySettings(body) });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/delivery-zones' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { zones: readDeliveryZones() });
    }
    if (u.pathname === '/api/admin/delivery-zones' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        const zones = Array.isArray(body.zones) ? body.zones.map(z => String(z).trim()).filter(Boolean).slice(0, 50) : [];
        writeDeliveryZones(zones);
        return json(res, 200, { ok: true, zones });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (u.pathname === '/api/admin/pages' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      /* "kiosk" siparis.html'den SONRA eklenir - dropdown'da yaninda gorunsun,
         ikisinin AYNI dosya oldugu (yukarida resolvePageAlias) acik olsun diye. */
      const pages = Array.from(EDITABLE_PAGES).flatMap(p => p === 'siparis.html' ? [p, 'kiosk'] : [p]);
      return json(res, 200, { pages });
    }
    if (u.pathname === '/api/admin/page' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const name = u.searchParams.get('file') || '';
        return json(res, 200, { file: name, content: readEditablePage(name) });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (u.pathname === '/api/admin/page' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req, 3 * 1024 * 1024);
        writeEditablePage(String(body.file || ''), body.content);
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (u.pathname === '/api/admin/upload-logo' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req, 12 * 1024 * 1024);
        const ext = await saveLogo(body.dataUrl);
        return json(res, 200, { ok: true, ext });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    /* Herkese acik menu okuma - /siparis sayfasinin sepete urun eklemesi icin GIRIS
       GEREKTIRMEZ (fiyat/urun bilgisi zaten sitede/menude herkese acik).
       ?type=table ise masa (normal/dine-in) fiyatı, aksi halde (delivery/pickup)
       SambaPOS'taki "PAKET" fiyat etiketi VARSA o kullanılır (kullanıcı tespiti:
       "paket siparişte paket fiyatı kullanılmalı, yoksa zarar ediyoruz"). Her
       ürünün TÜM porsiyonları da (varsa) döner. */
    if (u.pathname === '/api/menu' && req.method === 'GET') {
      try {
        const orderType = u.searchParams.get('type') === 'table' ? 'table' : (u.searchParams.get('type') === 'pickup' ? 'pickup' : 'delivery');
        const priceTag = orderType === 'table' ? null : 'PAKET';
        const categories = await sambapos.liveMenu({ screenMenuId: readSambaposMenuId(), priceTag });
        /* Musteri "Sipariş Ver" ekraninda da ana sayfadaki (index.html) urun
           aciklamalarini/rozetlerini/gorsellerini gormeli - kullanici bulgusu
           (25.09.2026): "iki farkli menu mu goruniyor, tek menu olmasi lazim".
           Kok neden: bu uc SADECE SambaPOS'un HAM verisini donduruyordu, site
           metadatasi (aciklama/rozet/gorsel - SambaPOS'ta hic saklanmaz) HIC
           eklenmiyordu - /api/admin/menu'deki AYNI isim-eslestirme deseni. */
        try {
          const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
          const siteItems = menuEditor.parseSiteItems(html);
          const norm = value => String(value || '').trim().toLocaleLowerCase('tr-TR');
          for (const category of categories) for (const item of category.items) {
            const siteItem = siteItems.find(candidate => norm(candidate.name) === norm(item.name));
            if (siteItem) Object.assign(item, { description: siteItem.description, badges: siteItem.badges, subcat: siteItem.subcat, oldPrice: siteItem.oldPrice });
            item.imageUrl = findProductImage(item.name);
          }
        } catch { /* site metadata okunamazsa siparis yine de SambaPOS verisiyle calisir */ }
        return json(res, 200, { categories, orderType });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }
    if (u.pathname === '/api/upsell-rules' && req.method === 'GET') {
      return json(res, 200, { rules: upsell.activeRulesForCustomer() });
    }
    if (u.pathname === '/api/upsell-event' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        upsell.logEvent(String(body.ruleId || ''), String(body.event || ''));
        return json(res, 200, { ok: true });
      } catch { return json(res, 200, { ok: true }); }
    }
    /* Musteri siparisi - GERCEK bir SambaPOS adisyonu olusturur (kullanici istegi,
       16.09.2026: "kendimiz yazalim"). GUVENLIK: musterinin gonderdigi fiyat/isim
       ASLA dogrudan kullanilmaz - her satir icin SambaPOS'taki GUNCEL menu (liveMenu())
       ile eslestirilip GERCEK, o anki fiyat/isim alinir; musteri istese bile fiyati
       degistiremez. */
    if (u.pathname === '/api/order' && req.method === 'POST') {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
      if (isOrderRateLimited(String(ip).split(',')[0].trim())) return json(res, 429, { error: 'Çok fazla sipariş denemesi. Birkaç dakika sonra tekrar deneyin.' });
      try {
        const body = await readJsonBody(req);
        const cart = Array.isArray(body.items) ? body.items : [];
        if (!cart.length) return json(res, 400, { error: 'Sepetiniz boş.' });
        if (cart.length > 40) return json(res, 400, { error: 'Sepette çok fazla ürün var.' });
        /* Masa QR siparişi: tableNumber varsa ad/telefon/bölge/adres ZORUNLU
           DEĞİL - müşteri masada oturuyor, sadece ürünleri ve masa numarasını
           gönderir (kullanıcı isteği: "sadece masa numarası + ürünler"). */
        const orderType = body.type === 'table' ? 'table' : body.type === 'pickup' ? 'pickup' : 'delivery';
        const tableNumber = orderType === 'table' ? String(body.tableNumber || '').trim().slice(0, 20) : '';
        if (orderType === 'table' && !tableNumber) return json(res, 400, { error: 'Masa numarası eksik.' });
        /* Kiosk siparişi: müşteri restoranda fiziksel olarak duran cihazda -
           masa QR'ı gibi ad/telefon/bölge/adres/konum ZORUNLU DEĞİL (kullanıcı
           kararı, 26.09.2026: "kios paket servise yazsın... isim opsiyonel
           olsun"). Sadece kiosk anahtarı panelden ACIKKEN gecerlidir - kapaliyken
           biri bu bayrağı sahte gönderse bile normal kurallar uygulanır. */
        const isKioskOrder = body.fromKiosk === true && readKioskEnabled();

        const customerName = String(body.customerName || '').trim().slice(0, 80);
        const phone = String(body.phone || '').trim().slice(0, 30);
        const address = String(body.address || '').trim().slice(0, 300);
        const note = String(body.note || '').trim().slice(0, 200);
        const zone = String(body.zone || '').trim().slice(0, 60);
        let phoneDigits = '';
        let deliveryInfo = null; // { distanceKm, method, fee, label }
        if (orderType !== 'table' && !isKioskOrder) {
          if (!customerName || !phone || !zone) return json(res, 400, { error: 'Ad soyad, telefon ve bölge zorunlu.' });
          phoneDigits = phone.replace(/\D/g, '');
          if (phoneDigits.length < 10 || phoneDigits.length > 15) return json(res, 400, { error: 'Geçerli bir telefon numarası girin.' });
          const configuredZones = readDeliveryZones();
          if (configuredZones.length && !configuredZones.includes(zone)) return json(res, 400, { error: 'Geçersiz teslimat bölgesi.' });

          /* Konum kontrolü (kullanıcı isteği): müşteri konumu paylaştıysa
             mesafe/ücret/bölge dışı SUNUCUDA yeniden hesaplanır - müşteriden
             gelen bir "ücret" değeri ASLA doğrudan güvenilmez. */
          if (orderType === 'delivery') {
            const ds = readDeliverySettings();
            const lat = Number(body.lat), lng = Number(body.lng);
            const hasLocation = ds.businessLocation && Number.isFinite(lat) && Number.isFinite(lng);
            if (ds.businessLocation && ds.locationRequired && !hasLocation) {
              return json(res, 400, { error: 'Sipariş için konum paylaşımı zorunlu.' });
            }
            if (hasLocation) {
              const { km, method } = await distanceKm(ds.businessLocation.lat, ds.businessLocation.lng, lat, lng);
              const tier = matchDeliveryTier(km, ds.tiers);
              if (!tier) return json(res, 400, { error: 'Bu adres servis bölgemiz dışında. Lütfen bizi arayın.' });
              deliveryInfo = { distanceKm: +km.toFixed(2), method, fee: tier.fee, label: tier.label };
            }
          }
        }

        /* Fiyat/porsiyon SEÇİMİ müşteriden gelir ama GERÇEK değer HER ZAMAN
           SambaPOS'taki o anki (sipariş tipine göre normal/PAKET) menüden
           alınır - müşteri istese bile fiyatı/porsiyon adını değiştiremez. */
        const priceTag = orderType === 'table' ? null : 'PAKET';
        const categories = await sambapos.liveMenu({ screenMenuId: readSambaposMenuId(), priceTag });
        const byId = new Map(categories.flatMap(c => c.items.map(i => [String(i.id), { ...i, categoryName: c.name }])));
        /* 27.09.2026 (kullanici istegi: "acılı/soğansız gibi seçenekler,
           SambaPOS'un kendi sistemiyle") - müşterinin gönderdiği etiket
           ID'lerine ASLA güvenilmez; isim/fiyat HER ZAMAN SambaPOS'taki
           güncel tanımdan tekrar okunur (fiyat/porsiyonda zaten aynı ilke
           uygulanıyor - müşteri isteseydi bile değiştiremezdi). */
        const configuredTagGroupId = readOrderTagGroupId();
        const tagGroup = configuredTagGroupId ? (await sambapos.getOrderTagGroups()).find(g => g.id === configuredTagGroupId) : null;
        const tagsById = new Map((tagGroup ? tagGroup.tags : []).map(t => [String(t.id), t]));
        const items = [];
        for (const line of cart) {
          const real = byId.get(String(line.menuItemId));
          if (!real) return json(res, 400, { error: 'Ürün bulunamadı (menü güncellenmiş olabilir, sayfayı yenileyin).' });
          const portion = real.portions.find(p => String(p.id) === String(line.portionId)) || real.portions[0];
          const qty = Math.max(1, Math.min(20, Math.round(Number(line.quantity) || 1)));
          const resolvedTags = Array.isArray(line.tagIds)
            ? line.tagIds.map(id => tagsById.get(String(id))).filter(Boolean).map(t => ({ groupId: configuredTagGroupId, name: t.name, price: t.price }))
            : [];
          items.push({ menuItemId: real.id, portionId: portion.id, portionName: portion.name, name: real.name, price: portion.price, quantity: qty, categoryName: real.categoryName, tags: resolvedTags });
        }
        /* Servis ücreti GERÇEK bir SambaPOS ürünü olarak eklenir (raporlarda
           görünsün) - fiyatı SUNUCUNUN hesapladığı mesafe ücretidir, ürünün
           SambaPOS'taki listelenmiş fiyatı DEĞİL (sadece "kap" olarak kullanılır). */
        if (deliveryInfo && deliveryInfo.fee > 0) {
          const ds = readDeliverySettings();
          const feeName = ds.feeMenuItemName && ds.feeMenuItemName.trim().toLocaleLowerCase('tr-TR');
          const feeItem = feeName ? categories.flatMap(c => c.items).find(i => i.name.trim().toLocaleLowerCase('tr-TR') === feeName) : null;
          if (feeItem) {
            const portion = feeItem.portions[0];
            items.push({ menuItemId: feeItem.id, portionId: portion.id, portionName: portion.name, name: feeItem.name, price: deliveryInfo.fee, quantity: 1 });
          }
        }
        const order = { id: crypto.randomUUID(), status: 'pending', type: orderType, tableNumber, customerName, phone, address, note, zone, deliveryInfo, items, total: items.reduce((sum, item) => sum + item.price * item.quantity, 0), time: new Date().toISOString() };
        const orderKind = orderType === 'table' ? `${tableNumber} siparişi` : orderType === 'pickup' ? 'Gel-Al siparişi' : 'Paket servis siparişi';
        /* Garson (veya admin) oturumu ACIK olan bir tarayicidan gelen siparis
           dogrudan SambaPOS'a gider - onay kuyruguna DUSMEZ (kullanici istegi,
           26.09.2026: "garson sipariş alabilmesi lazım"). Garson "Masaya Git"
           ile AYNI tarayicida /siparis'i actigi icin admin oturum cerezi zaten
           orada - musteri siparisleri icin GLOBAL "directOrderSend" ayari
           degismeden, SADECE giris yapmis personel icin onay adimi atlanir. */
        /* Kiosk siparisleri de dogrudan gonderilir/yazdirilir - kullanici
           istegi (26.09.2026): "kiosta sipariş yazdırma otomatik olması
           lazım". Kiosk zaten fiziksel olarak restoranda duran, personelin
           kontrolundeki bir cihaz - onay kuyruguna dusmesinin bir anlami yok.
           readKioskEnabled() ile de dogrulanir (kiosk kapaliyken bu bayrak
           TEK BASINA onay atlatmasin diye). */
        /* 27.09.2026: kiosk artik panelden secilebilir - "Kiosk siparislerini
           dogrudan gonder" kapaliysa kiosk siparisi de onay kuyruguna duser. */
        if (readDirectOrderSend() || isAuthed(req) || (isKioskOrder && readKioskDirectSend())) {
          const result = await sambapos.createOrder(order);
          broadcastNewOrder({ ...order, status: 'approved', ticketNumber: result.ticketNumber, total: result.total });
          notifyDesktop('🛎️ Yeni Sipariş', `${orderKind} geldi (#${result.ticketNumber}).`);
          printOrderToKitchen(order, result.ticketNumber);
          return json(res, 200, { ok: true, ticketNumber: result.ticketNumber, total: result.total });
        }
        const orders = readOrders(); orders.push(order); writeOrders(orders);
        broadcastNewOrder(order);
        notifyDesktop('🛎️ Yeni Sipariş', `${orderKind} geldi, onay bekliyor.`);
        return json(res, 200, { ok: true, pending: true, orderId: order.id, total: order.total });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }
    /* Garson çağrısı (18.09.2026, kullanıcı isteği: "garson çağırma sistemi
       olsun") - SambaPOS'a HİÇ yazmaz, sadece admin paneline bildirim düşer.
       Herkese açık (masadaki müşteri giriş yapmadan çağırabilmeli). */
    if (u.pathname === '/api/waiter-call' && req.method === 'POST') {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
      if (isCallRateLimited(String(ip).split(',')[0].trim())) return json(res, 429, { error: 'Çok fazla çağrı denemesi. Birkaç dakika sonra tekrar deneyin.' });
      try {
        const body = await readJsonBody(req);
        const table = String(body.table || '').trim().slice(0, 20);
        const type = String(body.type || '').trim();
        const note = String(body.note || '').trim().slice(0, 200);
        if (!table) return json(res, 400, { error: 'Masa numarası eksik.' });
        let label;
        if (type === 'custom') {
          if (!note) return json(res, 400, { error: 'Lütfen bir mesaj yazın.' });
          label = note;
        } else {
          if (!WAITER_CALL_TYPES[type]) return json(res, 400, { error: 'Geçersiz çağrı türü.' });
          label = note ? `${WAITER_CALL_TYPES[type]} — ${note}` : WAITER_CALL_TYPES[type];
        }
        const call = { id: crypto.randomUUID(), table, type, note, label, status: 'pending', time: new Date().toISOString() };
        const calls = readCalls(); calls.push(call); writeCalls(calls);
        broadcastWaiterCall(call);
        notifyDesktop('🔔 Garson Çağrısı', `${table} - ${label}`);
        sendGarsonPush(call);
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (u.pathname === '/api/admin/waiter-calls' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { calls: readCalls().filter(c => c.status === 'pending').reverse() });
    }
    /* Ayrı bir native Android "garson" uygulaması için - çerez tabanlı admin
       oturumu yerine paylaşılan anahtarla (config.json.waiterAppKey) doğrular. */
    if (u.pathname === '/api/app/waiter-calls' && req.method === 'GET') {
      if (u.searchParams.get('key') !== readWaiterAppKey()) return json(res, 403, { error: 'Geçersiz anahtar.' });
      return json(res, 200, { calls: readCalls().filter(c => c.status === 'pending').reverse() });
    }
    if (u.pathname === '/api/app/waiter-calls/ack' && req.method === 'POST') {
      if (u.searchParams.get('key') !== readWaiterAppKey()) return json(res, 403, { error: 'Geçersiz anahtar.' });
      try {
        const body = await readJsonBody(req);
        const calls = readCalls();
        const call = calls.find(c => c.id === String(body.id) && c.status === 'pending');
        if (!call) return json(res, 404, { error: 'Çağrı bulunamadı.' });
        call.status = 'seen'; call.seenAt = new Date().toISOString();
        writeCalls(calls);
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (u.pathname === '/api/admin/waiter-calls/ack' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        const calls = readCalls();
        const call = calls.find(c => c.id === String(body.id) && c.status === 'pending');
        if (!call) return json(res, 404, { error: 'Çağrı bulunamadı.' });
        call.status = 'seen'; call.seenAt = new Date().toISOString();
        writeCalls(calls);
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    /* 2 adimli giris YENIDEN AKTIF (20.09.2026) - gercek kok neden bulundu ve
       duzeltildi (admin/index.html'deki TUM istekler "/api/..." kok-mutlak
       yol kullaniyordu, bulut tuneli "/qrmenu" onekiyle sundugunda bu onegi
       atlayip yanlis yere gidiyordu - bkz. admin/index.html'deki API_BASE).
       Sorun sifre dogrulamasinda DEGILDI, bu yuzden 1. adim (e-posta/sifre)
       guvenle geri getirildi. 1. adim BULUTTAKI gercek panel sifresini
       dogrular, basarili olursa GECICI 'admin-pending' oturumu acar; bu
       oturum SADECE 2. adima (PIN) gecebilir, baska hicbir ucra erisemez. */
    if (u.pathname === '/api/admin/login-step1' && req.method === 'POST') {
      const ip = clientIp(req);
      const pwKey = `pw:${ip}`;
      const wait = loginLockedForMs(pwKey);
      if (wait > 0) return json(res, 429, { error: `Çok fazla hatalı deneme. ${Math.ceil(wait / 1000)} saniye sonra tekrar deneyin.` });
      const body = await readJsonBody(req);
      const identifier = String(body.identifier || '').trim();
      const password = String(body.password || '');
      if (!identifier || !password) return json(res, 400, { error: 'E-posta/telefon ve şifrenizi girin.' });
      const verified = await license.verifyPassword(identifier, password);
      if (!verified.ok) { registerLoginFail(pwKey); return json(res, 401, { error: verified.error || 'E-posta/telefon veya şifre hatalı.' }); }
      registerLoginSuccess(pwKey);
      newPendingCookie(req, res);
      console.log('[login] 1. adim basarili');
      return json(res, 200, { ok: true });
    }
    /* 2. adim - SADECE 1. adimi tamamlamis (gecerli imzali qr_admin_pending
       cerezi olan) bir istemci buraya erisebilir. PIN HALA SambaPOS'un kendi
       Users/PinCode tablosundan dogrulanir (biz PIN'i hic saklamayiz). */
    if (u.pathname === '/api/admin/login-step2' && req.method === 'POST') {
      const ip = clientIp(req);
      const pinKey = `pin:${ip}`;
      const wait = loginLockedForMs(pinKey);
      if (wait > 0) return json(res, 429, { error: `Çok fazla hatalı deneme. ${Math.ceil(wait / 1000)} saniye sonra tekrar deneyin.` });
      if (!hasValidPending(req)) return json(res, 401, { error: 'Önce e-posta/telefon ve şifrenizle giriş yapın.' });
      const body = await readJsonBody(req);
      /* 29.09.2026: adminEmails listesi BURADA ARTIK KONTROL EDILMEZ - PIN ekrani
         e-posta gondermiyor, liste doluysa dogru PIN her zaman "hatali" oluyordu.
         Kimlik zaten 1. adimda (e-posta/telefon + sifre) dogrulandi. Liste
         garson girisinde (e-posta alani olan ekran) gecerli kalir. */
      let pinResult;
      try { pinResult = await sambapos.checkPin(body.pin); }
      catch (e) { console.error('[login-step2] SambaPOS PIN sorgusu basarisiz:', e.message); return json(res, 503, { error: 'SambaPOS veritabanına bağlanılamadı. Restoran bilgisayarında SQL Server açık mı, ayarlardaki veritabanı doğru mu kontrol edin.' }); }
      if (!pinResult.isAdmin) {
        registerLoginFail(pinKey, PIN_LOCK_THRESHOLD, PIN_LOCK_MS);
        console.log('[login-step2] PIN reddedildi:', pinResult.found ? `yonetici olmayan rol "${pinResult.role}"` : 'SambaPOS kullanicilarinda yok');
        return json(res, 401, { error: pinResult.found
          ? `Bu PIN "${pinResult.role || 'rolsüz'}" rolündeki bir kullanıcıya ait. Yönetim paneline SambaPOS'ta Admin/Yönetici rolündeki kullanıcının PIN'i ile girilir.`
          : 'Bu PIN SambaPOS kullanıcıları arasında bulunamadı. SambaPOS\'a girerken kullandığınız PIN\'i yazın.' });
      }
      console.log('[login-step2] giris basarili:', pinResult.userName);
      registerLoginSuccess(pinKey);
      clearPendingCookie(res);
      newSession(req, res, 'admin');
      return json(res, 200, { ok: true });
    }
    /* Garson girisi (20.09.2026 - kullanici bulgusu: "garson şifresi ne
       oluyor, giriş yapmıyor") - garson.html eskiden var olan tek-adimli
       "/api/admin/login" ucuna (2 adimli gecisde YANLISLIKLA silinmis)
       istek atiyordu. Garson personeli restoran sahibinin BULUT sifresini
       bilmemeli - SADECE SambaPOS PIN (+ yapilandirilmissa e-posta
       izin listesi) yeterli, login-step2 ile AYNI kural. */
    if (u.pathname === '/api/admin/garson-login' && req.method === 'POST') {
      /* 26.09.2026 kullanici karari: "garson=LAN, patron/admin=heryerden" -
         garson oturumu ARTIK ayri bir role ('garson') tasir, boylece asagida
         SambaPOS terminaline (garson-web/samba-lan) erisim SADECE garson
         rolu icin LAN'a kisitlanabilir, patron/admin (login-step2) rolu her
         zaman heryerden erisebilir. isAuthed() ikisini de kabul eder -
         siparis onay atlama gibi mevcut davranislar DEGISMEZ. */
      const ip = clientIp(req);
      const gpinKey = `gpin:${ip}`;
      const wait = loginLockedForMs(gpinKey);
      if (wait > 0) return json(res, 429, { error: `Çok fazla hatalı deneme. ${Math.ceil(wait / 1000)} saniye sonra tekrar deneyin.` });
      const body = await readJsonBody(req);
      const adminEmails = readAdminEmails();
      if (adminEmails.length) {
        const email = String(body.email || '').trim().toLocaleLowerCase('tr-TR');
        if (!email || !adminEmails.includes(email)) { registerLoginFail(gpinKey); return json(res, 401, { error: 'E-posta veya PIN hatalı.' }); }
      }
      /* 29.09.2026: garson KENDI SambaPOS PIN'i ile girer (eskiden sadece admin
         rolu PIN'i kabul ediliyordu - "garson admin pin kabul etmiyor"). */
      let pinResult;
      try { pinResult = await sambapos.checkPin(body.pin); }
      catch (e) { console.error('[garson-login] SambaPOS PIN sorgusu basarisiz:', e.message); return json(res, 503, { error: 'SambaPOS veritabanına bağlanılamadı.' }); }
      if (!pinResult.found) { registerLoginFail(gpinKey); return json(res, 401, { error: 'PIN hatalı - SambaPOS kullanıcıları arasında bulunamadı.' }); }
      registerLoginSuccess(gpinKey);
      newSession(req, res, 'garson');
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/admin/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'qr_admin_session=; Path=/; HttpOnly; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/admin/me') return json(res, 200, { authed: isAuthed(req) });
    /* Restoranin KENDI musteri-menu adresi (20.09.2026, kullanici bulgusu:
       "satacagiz, hangi restoranin oldugu belli olmasi lazim") - tunnel.js
       bulut baglantisi kurulunca bunu ogrenir; henuz baglanamadiysa (internet
       yok, ilk acilis vb.) null doner, panel bu durumda eski (genel) linke
       duser. */
    if (u.pathname === '/api/admin/site-info' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const info = tunnelModule && tunnelModule.getSiteInfo ? tunnelModule.getSiteInfo() : null;
      return json(res, 200, { slug: info ? info.slug : null, menuBaseUrl: info ? info.menuBaseUrl : null });
    }
    /* Kullanici istegi (26.09.2026): "otomatik uretilen slug cok uzun/anlamsiz,
       TV'ye elle yazmasi zor" - restoran kendi kisa/hatirlanabilir baglanti
       adini burdan degistirebilir. */
    if (u.pathname === '/api/admin/qrmenu-slug' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        const result = await license.setQrmenuSlug(String(body.slug || ''));
        if (!result.ok) return json(res, 400, { error: result.error || 'Bağlantı adı değiştirilemedi.' });
        if (tunnelModule && tunnelModule.updateSlug) tunnelModule.updateSlug(result.slug);
        return json(res, 200, { ok: true, slug: result.slug, menuBaseUrl: `https://menu.ornek-alanadi.com/${result.slug}` });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/order-mode' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { directOrderSend: readDirectOrderSend(), kioskDirectOrderSend: readKioskDirectSend() });
    }
    if (u.pathname === '/api/admin/order-mode' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        /* Iki anahtar ayri ayri gelir - biri degistirilirken digeri EZILMEZ */
        if ('directOrderSend' in body) writeDirectOrderSend(body.directOrderSend === true);
        if ('kioskDirectOrderSend' in body) writeKioskDirectSend(body.kioskDirectOrderSend === true);
        return json(res, 200, { ok: true, directOrderSend: readDirectOrderSend(), kioskDirectOrderSend: readKioskDirectSend() });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    /* 27.09.2026 (kullanici istegi: "acılı/soğansız gibi seçenekler,
       SambaPOS'un kendi sistemiyle") - admin bu uctan SambaPOS'ta TANIMLI
       TÜM Sipariş Etiketi gruplarını görür ve birini QR Menü için seçer. */
    if (u.pathname === '/api/admin/order-tag-groups' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const groups = await sambapos.getOrderTagGroups();
        return json(res, 200, { groups, selectedGroupId: readOrderTagGroupId() });
      } catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/order-tag-groups' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        writeOrderTagGroupId(body.groupId || null);
        return json(res, 200, { ok: true, selectedGroupId: readOrderTagGroupId() });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    /* Herkese açık - müşteri sayfası ürün penceresinde hangi etiketlerin
       (Acılı/Soğansız gibi) gösterileceğini buradan öğrenir. Admin bir grup
       seçmemişse boş dizi döner (özellik sessizce kapalı kalır). */
    if (u.pathname === '/api/order-tags' && req.method === 'GET') {
      try {
        const groupId = readOrderTagGroupId();
        if (!groupId) return json(res, 200, { groupId: null, minSelected: 0, maxSelected: 0, tags: [] });
        const groups = await sambapos.getOrderTagGroups();
        const g = groups.find(x => x.id === groupId);
        if (!g) return json(res, 200, { groupId: null, minSelected: 0, maxSelected: 0, tags: [] });
        return json(res, 200, { groupId: g.id, minSelected: g.minSelected, maxSelected: g.maxSelected, tags: g.tags });
      } catch (error) { return json(res, 200, { groupId: null, minSelected: 0, maxSelected: 0, tags: [] }); }
    }
    if (u.pathname === '/api/admin/remote-garson' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { remoteGarsonAllowed: readRemoteGarsonAllowed() });
    }
    if (u.pathname === '/api/admin/remote-garson' && req.method === 'POST') {
      /* SADECE patron/admin acabilir - garson kendi kendine bu izni acamaz. */
      const session = currentSession(req);
      if (!session || session.role !== 'admin') return json(res, 403, { error: 'Sadece patron/admin bu ayarı değiştirebilir.' });
      try {
        const body = await readJsonBody(req);
        writeRemoteGarsonAllowed(body.remoteGarsonAllowed === true);
        return json(res, 200, { ok: true, remoteGarsonAllowed: readRemoteGarsonAllowed() });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/kiosk-tv' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { kioskEnabled: readKioskEnabled(), kioskA11yEnabled: readKioskA11yEnabled(), tvMenuEnabled: readTvMenuEnabled() });
    }
    if (u.pathname === '/api/admin/kiosk-tv' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        if ('kioskEnabled' in body) writeKioskEnabled(body.kioskEnabled === true);
        if ('tvMenuEnabled' in body) writeTvMenuEnabled(body.tvMenuEnabled === true);
        if ('kioskA11yEnabled' in body) writeKioskA11yEnabled(body.kioskA11yEnabled === true);
        return json(res, 200, { ok: true, kioskEnabled: readKioskEnabled(), kioskA11yEnabled: readKioskA11yEnabled(), tvMenuEnabled: readTvMenuEnabled() });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    /* --- Sefin notu yapay zeka (30.09.2026) - anahtar tarayiciya GONDERILMEZ --- */
    if (u.pathname === '/api/admin/notes-ai' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const a = readNotesAi();
      /* Bicime uymayan kayitli "anahtar" buyuk ihtimalle tarayicinin doldurdugu panel SIFRESI -
         duz metin olarak dosyada durmasin, silinir */
      if (a.key && !aiKeyLooksValid(a.provider, a.key)) { writeNotesAi({ key: '' }); a.key = ''; }
      return json(res, 200, { enabled: a.enabled, provider: a.provider, hasKey: !!a.key, keyValid: aiKeyLooksValid(a.provider, a.key), lastRunAt: a.lastRunAt, lastError: a.lastError });
    }
    if (u.pathname === '/api/admin/notes-ai' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const body = await readJsonBody(req);
      const patch = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (['evren', 'groq', 'gemini'].includes(body.provider)) patch.provider = body.provider;
      if (typeof body.key === 'string' && body.key.trim()) {
        const prov = patch.provider || readNotesAi().provider;
        if (!aiKeyLooksValid(prov, body.key.trim())) return json(res, 400, { error: prov === 'evren' ? 'Bu bir EVREN anahtarı değil (evren_llm_ ile başlamalı). Tarayıcı kutuya şifrenizi doldurmuş olabilir.' : 'Anahtar seçilen sağlayıcıya ait görünmüyor.' });
        patch.key = body.key.trim().slice(0, 200);
      }
      writeNotesAi(patch);
      return json(res, 200, { ok: true });
    }
    /* AI Araclari sekmesi icin EVREN koprusu (30.09.2026): EVREN tarayicidan gelen istege CORS
       izni vermiyor, istek bu bilgisayar uzerinden gider. Anahtar: panelden gelen ya da
       Sefin Notu'na kaydedilmis EVREN anahtari. JSON istenirse cevaptaki JSON ayiklanir. */
    if (u.pathname === '/api/admin/ai-complete' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const body = await readJsonBody(req, 200000);
      const saved = readNotesAi();
      const key = (typeof body.key === 'string' && body.key.trim()) || (saved.provider === 'evren' ? saved.key : '');
      if (!key) return json(res, 400, { error: 'EVREN anahtarı girilmemiş (AI Araçları ya da Şefin Notu bölümünden kaydedin).' });
      try {
        let text = await aiComplete('evren', key, String(body.system || '').slice(0, 4000), String(body.prompt || '').slice(0, 60000),
          { temperature: Number(body.temperature), maxTokens: Number(body.maxTokens) || 1500 });
        if (body.json) { const s = String(text).replace(/```(json)?/g, ''); const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) text = s.slice(a, b + 1); }
        return json(res, 200, { text });
      } catch (e) { return json(res, 400, { error: e.message, code: e.code || '' }); }
    }
    /* EVREN kullanim sartlari (30.09.2026): action "text" = metni getir (okuma), "accept" = SADECE
       kullanici panelde "Okudum, kabul ediyorum"a bastiginda cagrilir. */
    if (u.pathname === '/api/admin/evren-terms' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const body = await readJsonBody(req);
      const saved = readNotesAi();
      const key = (typeof body.key === 'string' && body.key.trim().startsWith('evren_llm_')) ? body.key.trim() : (saved.provider === 'evren' ? saved.key : '');
      if (!key) return json(res, 400, { error: 'EVREN anahtarı yok.' });
      const H = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
      try {
        if (body.action === 'accept') {
          const version = Math.max(1, Math.floor(Number(body.version) || 1));
          const r = await fetch('https://evren-llmapi.ssyz.org.tr/v1/terms/accept', { method: 'POST', headers: H, body: JSON.stringify({ version }), signal: AbortSignal.timeout(20000) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) return json(res, 400, { error: (j.error && j.error.message) || ('EVREN ' + r.status) });
          console.log('[evren] kullanim sartlari v' + version + ' panelden kullanici tarafindan onaylandi');
          return json(res, 200, { ok: true });
        }
        const r = await fetch('https://evren-llmapi.ssyz.org.tr/v1/terms/text', { headers: H, signal: AbortSignal.timeout(20000) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return json(res, 400, { error: (j.error && j.error.message) || ('EVREN ' + r.status) });
        return json(res, 200, { version: j.version || 1, content: String(j.content || '').slice(0, 30000) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (u.pathname === '/api/admin/notes-ai/run' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const body = await readJsonBody(req);
      try { return json(res, 200, { ok: true, notes: await generateChefNotes({ provider: body.provider, key: typeof body.key === 'string' ? body.key.trim() : '' }) }); }
      catch (e) { return json(res, 400, { error: e.message, code: e.code || '' }); }
    }
    /* --- Yorumlar: Google baglantisi + musteri degerlendirmeleri (30.09.2026) --- */
    if (u.pathname === '/api/admin/google-reviews' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const g = readGoogleCfg();
      /* API anahtari tarayiciya ASLA gonderilmez - sadece girilip girilmedigi */
      return json(res, 200, { hasKey: !!g.apiKey, placeId: g.placeId, placeName: g.placeName, lastFetchAt: g.lastFetchAt, lastError: g.lastError,
        rating: g.rating, count: g.count, fetched: g.items.length, positive: g.items.filter(r => r.rating >= 4).length, menuEnabled: g.menuEnabled });
    }
    if (u.pathname === '/api/admin/google-reviews' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const body = await readJsonBody(req);
      const patch = {};
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) patch.apiKey = body.apiKey.trim().slice(0, 200);
      if (body.removeKey === true) { patch.apiKey = ''; patch.items = []; patch.rating = 0; patch.count = 0; }
      if (typeof body.placeId === 'string') { patch.placeId = body.placeId.trim().slice(0, 200); patch.placeName = clipStr(body.placeName, 120); }
      if (typeof body.menuEnabled === 'boolean') patch.menuEnabled = body.menuEnabled;
      writeGoogleCfg(patch);
      if (patch.placeId || patch.apiKey) await refreshGoogleReviews();
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/admin/google-reviews/search' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try { const body = await readJsonBody(req); return json(res, 200, { places: await searchGooglePlace(body.query || '') }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (u.pathname === '/api/admin/google-reviews/fetch' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const g = await refreshGoogleReviews();
      return g.lastError ? json(res, 400, { error: g.lastError }) : json(res, 200, { ok: true, fetched: g.items.length, rating: g.rating, count: g.count });
    }
    if (u.pathname === '/api/admin/feedback' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { items: readFeedback().slice(-100).reverse() });
    }
    if (u.pathname === '/api/admin/feedback/hide' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const body = await readJsonBody(req);
      const list = readFeedback();
      const f = list.find(x => x.id === body.id);
      if (!f) return json(res, 404, { error: 'Bulunamadı.' });
      f.hidden = body.hidden === true;
      writeFeedback(list);
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/admin/tv-extras' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, readTvExtras());
    }
    if (u.pathname === '/api/admin/tv-extras' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try { return json(res, 200, writeTvExtras(await readJsonBody(req))); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/tv-music' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, readTvMusic());
    }
    if (u.pathname === '/api/admin/tv-music' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        writeTvMusicSettings({ enabled: body.enabled, volume: body.volume, youtubeUrl: body.youtubeUrl });
        return json(res, 200, readTvMusic());
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/tv-music/remove' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      delete c.tvMusicYoutubeId;
      c.tvMusicEnabled = false;
      writeConfigAtomic(c);
      return json(res, 200, readTvMusic());
    }
    if (u.pathname === '/api/admin/site-settings' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const themes = Object.fromEntries(Object.entries(THEME_PRESETS).map(([id, t]) => [id, { label: t.label, light: t.light }]));
      return json(res, 200, { siteSettings: readSiteSettings(), database: readDatabaseSettings(), themes });
    }
    if (u.pathname === '/api/admin/site-settings' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        const siteSettings = writeSiteSettings(body.siteSettings || {});
        const database = writeDatabaseSettings(body.database || {});
        return json(res, 200, { ok: true, siteSettings, database, restartRequired: true });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/orders' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { orders: readOrders().filter(order => order.status === 'pending').reverse() });
    }
    /* Garson paneli "Masalar" görünümü (kullanıcı isteği, 25.09.2026: "garson
       masaların olduğu... masayı görecek, içine girebilecek, gördüm
       diyebilecek" - daha önce paylaştığı referans uygulamadaki gibi). Tüm
       SambaPOS masalarını, hangisinde bekleyen sipariş/çağrı olduğu bilgisiyle
       birlikte döner - garson tek ekrandan hangi masaya bakması gerektiğini
       görür. */
    if (u.pathname === '/api/admin/tables' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const sections = await sambapos.liveTables();
        const pendingOrders = readOrders().filter(o => o.status === 'pending' && o.type === 'table');
        const pendingCalls = readCalls().filter(c => c.status === 'pending');
        for (const section of sections) for (const table of section.tables) {
          table.hasOrder = pendingOrders.some(o => o.tableNumber === table.name);
          table.hasCall = pendingCalls.some(c => c.table === table.name);
        }
        return json(res, 200, { sections });
      } catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/orders/approve' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        const orders = readOrders();
        const order = orders.find(item => item.id === String(body.id) && item.status === 'pending');
        if (!order) return json(res, 404, { error: 'Bekleyen sipariş bulunamadı.' });
        const result = await sambapos.createOrder(order);
        order.status = 'approved'; order.ticketNumber = result.ticketNumber; order.sentAt = new Date().toISOString();
        writeOrders(orders);
        broadcastNewOrder({ ...order, status: 'approved' });
        printOrderToKitchen(order, result.ticketNumber);
        return json(res, 200, { ok: true, ticketNumber: result.ticketNumber, total: result.total });
      } catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/orders/reject' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        const orders = readOrders();
        const order = orders.find(item => item.id === String(body.id) && item.status === 'pending');
        if (!order) return json(res, 404, { error: 'Bekleyen sipariş bulunamadı.' });
        order.status = 'rejected'; order.rejectedAt = new Date().toISOString();
        writeOrders(orders);
        return json(res, 200, { ok: true });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    /* Geçmiş Siparişler (kullanıcı isteği) - onaylanan/reddedilen/silinen TÜM
       siparişler (sadece bekleyenler değil). */
    if (u.pathname === '/api/admin/orders/history' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { orders: readOrders().reverse() });
    }
    /* SambaPOS'ta "iptal" sadece ürünleri boşaltıp adisyon başlığını
       bırakıyor, tamamen SİLMİYOR (canlı bulgu, tekrar tekrar yaşanan
       sorun) - admin panelden GÖNDERİLMİŞ bir siparişi tek tıkla SambaPOS'tan
       kalıcı olarak silebilmek için. */
    if (u.pathname === '/api/admin/orders/delete-ticket' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        const orders = readOrders();
        const order = orders.find(item => item.id === String(body.id));
        if (!order || !order.ticketNumber) return json(res, 404, { error: 'Gönderilmiş sipariş bulunamadı.' });
        await sambapos.deleteTicketByNumber(order.ticketNumber);
        order.status = 'deleted'; order.deletedAt = new Date().toISOString();
        writeOrders(orders);
        return json(res, 200, { ok: true });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    /* Masalar (kullanıcı isteği: "masaları sambapos'tan otomatik çekmesi") -
       SambaPOS'taki güncel masa listesi, QR kod üretimi admin panelde
       (api.qrserver.com ile tarayıcı tarafında, sunucu tarafında ek bağımlılık
       gerekmez) bu liste üzerinden yapılır. */
    if (u.pathname === '/api/admin/tables' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const sections = await sambapos.liveTables();
        return json(res, 200, { sections });
      } catch (error) { return json(res, 500, { error: error.message }); }
    }
    /* Canli siparis bildirimi (SSE) - admin panelindeki sekme acik oldugu surece
       baglantiyi acik tutar, yeni siparis geldiginde broadcastNewOrder() ile anlik
       veri gonderir. Baglanti kopunca (sekme kapanir/uyku) Set'ten otomatik silinir. */
    if (u.pathname === '/api/admin/events' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': bağlandı\n\n');
      sseClients.add(res);
      const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* baglanti kopmus, asagida temizlenir */ } }, 25000);
      req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
      return;
    }
    if (u.pathname === '/api/admin/menu') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const categories = await sambapos.liveMenu({ screenMenuId: readSambaposMenuId() });
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const siteItems = menuEditor.parseSiteItems(html);
        const norm = value => String(value || '').trim().toLocaleLowerCase('tr-TR');
        for (const category of categories) for (const item of category.items) {
          const siteItem = siteItems.find(candidate => norm(candidate.name) === norm(item.name));
          if (siteItem) Object.assign(item, { lineIndex: siteItem.lineIndex, description: siteItem.description, badges: siteItem.badges, subcat: siteItem.subcat, oldPrice: siteItem.oldPrice, categoryIdRaw: siteItem.categoryIdRaw });
          item.imageUrl = findProductImage(item.name);
        }
        return json(res, 200, { categories });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }
    /* "Ürünleri SambaPOS'tan çek" (kullanıcı isteği, 16.09.2026): siteyle SambaPOS'u
       isim bazında KARŞILAŞTIRIR, otomatik/sessizce YAZMAZ - yanlış/eski formatlı bir
       fiyatı canlı siteye kör kör basmak müşteriye yanlış fiyat göstermek demek olur.
       Admin farkı GÖRÜR, istediği satırı tek tıkla uygular (aşağıdaki apply-price). */
    if (u.pathname === '/api/admin/menu-diff' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const [dbCategories, html] = await Promise.all([sambapos.liveMenu({ screenMenuId: readSambaposMenuId() }), Promise.resolve(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'))]);
        const siteItems = menuEditor.parseSiteItems(html);
        // Ayni urun SambaPOS'ta BIRDEN FAZLA ekran menusu kategorisinde gorunebilir
        // (orn. "Cok Satanlar" gibi ozel bir kategoride TEKRAR listelenmis olabilir) -
        // karsilastirma icin isim bazinda TEKILLESTIRILIR, yoksa ayni urun icin
        // birden fazla "uygula" satiri cikardi (canli veride tespit edildi).
        const seenNames = new Set();
        const dbFlat = [];
        for (const c of dbCategories) for (const i of c.items) {
          const key = i.name.trim().toLocaleLowerCase('tr-TR');
          if (seenNames.has(key)) continue;
          seenNames.add(key);
          dbFlat.push({ ...i, categoryName: c.name });
        }
        const norm = s => String(s || '').trim().toLocaleLowerCase('tr-TR');
        const siteByName = new Map(siteItems.map(i => [norm(i.name), i]));
        const dbByName = new Map(dbFlat.map(i => [norm(i.name), i]));
        const matched = [], onlyInSambapos = [];
        for (const dbItem of dbFlat) {
          const site = siteByName.get(norm(dbItem.name));
          const suggested = dbItem.price.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
          if (site) matched.push({ name: dbItem.name, lineIndex: site.lineIndex, sitePrice: site.priceRawText, dbPrice: suggested, differs: site.priceRawText.trim() !== suggested });
          else onlyInSambapos.push({ name: dbItem.name, categoryName: dbItem.categoryName, dbPrice: suggested });
        }
        const onlyOnSite = siteItems.filter(i => !dbByName.has(norm(i.name))).map(i => ({ name: i.name, priceRawText: i.priceRawText }));
        return json(res, 200, { matched: matched.filter(m => m.differs), onlyInSambapos, onlyOnSite });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }
    if (u.pathname === '/api/admin/apply-price' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        if (!Number.isInteger(body.lineIndex) || !body.newPriceText) return json(res, 400, { error: 'Eksik bilgi.' });
        menuEditor.applyPriceUpdate(body.lineIndex, String(body.newPriceText).slice(0, 40));
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (u.pathname === '/api/admin/edit-item' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        if (!Number.isInteger(body.lineIndex)) return json(res, 400, { error: 'Ürün satırı belirtilmedi.' });
        const badges = Array.isArray(body.badges) ? body.badges.filter(b => ['featured', 'new', 'discount'].includes(b)) : undefined;
        menuEditor.updateItem({
          lineIndex: body.lineIndex, name: body.name, price: body.price, description: body.description,
          badges, subcat: body.subcat, oldPrice: body.oldPrice
        });
        if (body.imageDataUrl) await saveDataUrlImage(body.name, body.imageDataUrl);
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (u.pathname === '/api/admin/delete-item' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        if (!Number.isInteger(body.lineIndex)) return json(res, 400, { error: 'Ürün satırı belirtilmedi.' });
        menuEditor.deleteItem(body.lineIndex);
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    /* "Menümü yayınla" (kullanıcı isteği, 16.09.2026): TÜM menüyü SambaPOS'taki güncel
       kategori/ürün/fiyat listesinden YENİDEN OLUŞTURUR - demo/eski içerik tamamen
       değişir. Geri dönüş için otomatik .bak yedeği alınır (bkz. menu-editor.js). */
    if (u.pathname === '/api/admin/regenerate-menu' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req).catch(() => ({}));
        const categories = await sambapos.liveMenu({ screenMenuId: readSambaposMenuId() });
        if (!body.force) {
          const currentHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
          const currentCats = menuEditor.listCategoriesWithMeta(currentHtml).filter(c => c.itemCount > 0).map(c => c.name);
          const newCatNames = new Set(categories.map(c => c.name.trim()));
          const wouldBeLost = currentCats.filter(name => !newCatNames.has(name.trim()));
          if (wouldBeLost.length) {
            return json(res, 409, {
              error: `DİKKAT: Bu işlem şu kategorileri SİLECEK (SambaPOS'tan artık gelmiyorlar): ${wouldBeLost.join(', ')}. Devam etmek için onaylayın.`,
              wouldBeLost,
            });
          }
        }
        const result = menuEditor.regenerateFullMenu(categories);
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }
    /* "Hangi menüden ürünler çekilsin?" - SambaPOS'taki Ekran Menüsü listesi
       (örn. Menu/QRMenu) + o an seçili olan. */
    if (u.pathname === '/api/admin/samba-menus' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const menus = await sambapos.liveScreenMenus();
        return json(res, 200, { menus, selectedId: readSambaposMenuId() });
      } catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/samba-menus' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        writeSambaposMenuId(body.menuId || null);
        return json(res, 200, { ok: true, selectedId: readSambaposMenuId() });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/categories' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      return json(res, 200, { categories: menuEditor.parseCategories(html) });
    }
    if (u.pathname === '/api/admin/upsell-rules' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { rules: upsell.readRules() });
    }
    if (u.pathname === '/api/admin/upsell-rules' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        const rule = upsell.upsertRule(body);
        return json(res, 200, { ok: true, rule });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/upsell-rules/delete' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        upsell.deleteRule(String(body.id || ''));
        return json(res, 200, { ok: true });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/upsell-stats' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      return json(res, 200, { stats: upsell.statsSummary() });
    }
    /* Kategori Yönetimi (kullanıcı isteği: "kategori düzenleme falan olsun") */
    if (u.pathname === '/api/admin/categories-full' && req.method === 'GET') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        return json(res, 200, { categories: menuEditor.listCategoriesWithMeta(html) });
      } catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/category-rename' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        menuEditor.renameCategory(String(body.name || ''), String(body.newName || ''));
        return json(res, 200, { ok: true });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/category-delete' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        menuEditor.deleteCategory(String(body.name || ''));
        return json(res, 200, { ok: true });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/category-active' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        menuEditor.setCategoryActive(String(body.name || ''), body.active === true);
        return json(res, 200, { ok: true });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/category-reorder' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        menuEditor.reorderCategory(String(body.name || ''), Number(body.direction) < 0 ? -1 : 1);
        return json(res, 200, { ok: true });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/category-create' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        menuEditor.addCategory(String(body.name || ''));
        return json(res, 200, { ok: true });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/item-reorder' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        menuEditor.reorderItem(String(body.categoryName || ''), Number(body.lineIndex), Number(body.direction) < 0 ? -1 : 1);
        return json(res, 200, { ok: true });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    /* "Tümünü Ekle" (kullanıcı isteği, 25.09.2026): SambaPOS'ta olup sitede
       OLMAYAN (isim eslesmeyen) TUM urunleri tek istekte ekler - kategorisi
       sitede yoksa once ONU olusturur. Tek-tek "Siteye Ekle" butonuna basmak
       zorunda kalmamak icin. */
    if (u.pathname === '/api/admin/add-missing-items' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const categories = await sambapos.liveMenu({ screenMenuId: readSambaposMenuId() });
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const siteItems = menuEditor.parseSiteItems(html);
        const norm = value => String(value || '').trim().toLocaleLowerCase('tr-TR');
        const existingCatNames = new Set(menuEditor.listCategoriesWithMeta(html).map(c => norm(c.name)));
        const money = n => (Number(n) || 0).toFixed(2).replace('.', ',') + ' TL';
        let added = 0;
        const failed = [];
        for (const category of categories) {
          const missing = category.items.filter(item => !siteItems.some(s => norm(s.name) === norm(item.name)));
          if (!missing.length) continue;
          if (!existingCatNames.has(norm(category.name))) {
            try { menuEditor.addCategory(category.name); existingCatNames.add(norm(category.name)); }
            catch (error) { failed.push({ name: category.name, error: 'Kategori oluşturulamadı: ' + error.message }); continue; }
          }
          for (const item of missing) {
            try {
              menuEditor.addItem({ categoryIdRaw: category.name, name: String(item.name).slice(0, 80), price: money(item.price), description: '' });
              added++;
            } catch (error) { failed.push({ name: item.name, error: error.message }); }
          }
        }
        return json(res, 200, { added, failed });
      } catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (u.pathname === '/api/admin/add-item' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req);
        const { categoryIdRaw, name, price, description } = body;
        if (!categoryIdRaw || !name || !price) return json(res, 400, { error: 'Kategori, ürün adı ve fiyat zorunlu.' });
        let imageFileName = null;
        if (body.imageDataUrl) imageFileName = await saveDataUrlImage(name, body.imageDataUrl);
        const badges = Array.isArray(body.badges) ? body.badges.filter(b => ['featured', 'new', 'discount'].includes(b)) : [];
        menuEditor.addItem({
          categoryIdRaw, name: String(name).slice(0, 80), price: String(price).slice(0, 40), description: String(description || '').slice(0, 200), imageFileName,
          badges, subcat: String(body.subcat || '').slice(0, 60), oldPrice: String(body.oldPrice || '').slice(0, 40)
        });
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (u.pathname === '/api/admin/upload-image' && req.method === 'POST') {
      if (!isAuthed(req)) return json(res, 403, { error: 'Giriş gerekli.' });
      try {
        const body = await readJsonBody(req, 12 * 1024 * 1024);
        if (!body.itemName || !body.dataUrl) return json(res, 400, { error: 'Eksik bilgi.' });
        const savedAs = await saveDataUrlImage(body.itemName, body.dataUrl);
        return json(res, 200, { ok: true, savedAs });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    /* PWA service worker (kullanıcı isteği: "apk yap" - gerçek APK bu ortamda
       derlenemiyor (Android SDK/Gradle yok), ama telefona "ana ekrana ekle"
       ile gerçek uygulama gibi kurulabilen bir PWA için gerekli. Kök dizindeki
       .js dosyaları güvenlik nedeniyle GENEL olarak sunulmuyor (server.js/sql.js
       sızmasın diye) - bu yüzden AYRI, sabit bir rota: içerik diskten değil
       doğrudan koddan yazılır, kaynak dosyalara erişim AÇILMAZ. Kökten
       sunulduğu için varsayılan kapsamı (scope) TÜM siteyi kapsar. */
    /* Yonetim paneli uygulama simgeleri (30.09.2026) - admin-icons.js'e gomulu PNG */
    if (u.pathname === '/admin/icon-192.png' || u.pathname === '/admin/icon-512.png') {
      try {
        const icons = require('./admin-icons');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        return res.end(icons[u.pathname.includes('512') ? 512 : 192]);
      } catch { res.writeHead(404); return res.end(); }
    }
    if (u.pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' });
      return res.end(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => { event.respondWith(fetch(event.request).catch(() => caches.match(event.request))); });`);
    }
    /* 26.09.2026 kullanici karari (guncellendi): "garson=LAN, patron/admin=
       heryerden" - canUseSambaposTerminal() rol bazli karar verir: admin
       (patron) her zaman gecer, garson SADECE LAN'dan VEYA admin panelden
       remoteGarsonAllowed acilmissa gecer. */
    if (u.pathname.startsWith('/samba-lan')) {
      if (!canUseSambaposTerminal(req)) return json(res, 404, { error: 'Bulunamadı' });
      return proxySambaposLan(req, res, u);
    }
    if (u.pathname.startsWith('/garson-web')) {
      if (!canUseSambaposTerminal(req)) return json(res, 404, { error: 'Bulunamadı' });
      return serveGarsonWeb(req, res, u.pathname.slice('/garson-web'.length));
    }
    if (u.pathname === '/api/admin/terminal-config-options' && req.method === 'GET') {
      if (!canUseSambaposTerminal(req)) return json(res, 401, { error: 'Giriş gerekli.' });
      try { return json(res, 200, await sambapos.terminalConfigOptions()); }
      catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (u.pathname.startsWith('/admin')) {
      const rel = u.pathname === '/admin' || u.pathname === '/admin/' ? '/admin/index.html' : u.pathname;
      const file = path.join(ROOT, rel);
      if (!file.startsWith(path.join(ROOT, 'admin') + path.sep) && file !== path.join(ROOT, 'admin', 'index.html')) return json(res, 404, { error: 'Bulunamadı' });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Bulunamadı' });
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': TYPES[ext] || (ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream'), 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }

    if ((u.pathname === '/tv' || u.pathname === '/tv.html') && !readTvMenuEnabled()) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html lang="tr"><meta charset="utf-8"><title>TV Menü</title>
        <body style="font-family:system-ui;background:#141414;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center">
        <div><h2>📺 TV Menü şu an kapalı</h2><p style="color:#999">Panelden Ayarlar → Kiosk &amp; TV Menü bölümünden açabilirsiniz.</p></div></body></html>`);
    }
    serveStatic(req, res, u.pathname);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

http.createServer(handleRequest).listen(PORT, function () {
  console.log(`QR Menu: http://127.0.0.1:${PORT}  (yönetim paneli: /admin)`);
});
// Bulut tuneli (19.09.2026) - app.ornek-alanadi.com/qrmenu ve menu.ornek-alanadi.com
// uzerinden UZAKTAN erisim icin, port PORT dinlemesine EK olarak (yerine
// GECMEZ). Aktivasyon anahtari yoksa/lisans kapaliysa sessizce pasif kalir.
let tunnelModule = null;
try { tunnelModule = require('./tunnel'); tunnelModule.start(handleRequest); } catch (error) { console.error('Tünel başlatılamadı (yoksayıldı, yerel erişim etkilenmez):', error.message); }
/* Google yorumlari: acilistan 1 dk sonra, sonra 4 saatte bir (anahtar/isletme yoksa hicbir sey yapmaz) */
setTimeout(() => { refreshGoogleReviews().catch(() => {}); setInterval(() => refreshGoogleReviews().catch(() => {}), ROTATE_MS); }, 60 * 1000);
/* Otomatik guncelleme (29.09.2026) - bkz. updater.js. Hata olursa sessizce pasif kalir. */
try { const updater = require('./updater'); console.log('QR Menu surum:', updater.localVersion()); updater.start(license.CLOUD_URL); } catch (error) { console.error('Güncelleyici başlatılamadı (yoksayıldı):', error.message); }
process.on('uncaughtException', error => console.error('Yakalanmamış hata:', error));
process.on('unhandledRejection', error => console.error('Yakalanmamış Promise reddi:', error));

/* Kullanici bulgusu (26.09.2026): "adisyon ödeme aldı ama gitmedi" - bkz.
   sambapos.js:syncClosedPaketDurumu() ustundeki aciklama. SambaPOS'un kendi
   odeme akisi bizim "Paket Durumu" state'imizi hic guncellemedigi icin
   BURADAN periyodik olarak kendimiz senkronize ediyoruz. */
setInterval(() => { sambapos.syncClosedPaketDurumu().catch(error => console.error('Paket Durumu senkron hatası:', error.message)); }, 20000);
