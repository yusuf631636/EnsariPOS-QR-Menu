/* QR Menu'nun kendini otomatik guncellemesi (29.09.2026) - Gelismis Kurye'nin
   kanitlanmis updater.js deseninden uyarlandi (bagimsiz kopya). Amac: her
   duzeltme icin restoranlara gidip exe kurmaya gerek kalmasin.
   TASARIM ILKESI: canli servisi (HTTP sunucusu, tunel, SambaPOS) HICBIR sekilde
   bozamaz:
   - Seyrek, ayri bir zamanlayici (acilistan 5 dk sonra, sonra saatte bir).
   - Her adim try/catch icinde; hata loglanir, surum DEGISMEZ, surec cokmez.
   - Dosyalar once GECICI klasore iner; her dosyanin SHA-256 parmak izi
     manifestodakiyle karsilastirilir, her .js "node --check" ile denetlenir.
     SADECE hepsi gecerse canli dosyalarin uzerine yazilir.
   - Eski dosyalar update-backup/ altina yedeklenir.
   - Basaridan sonra process.exit(0) - NSSM servisi otomatik yeniden baslatir.
   Guncellenmeyenler: config.json, resimler, veriler, node_modules (yeni bir npm
   paketi gerekiyorsa o surum exe ile kurulmalidir).
   Yayinlama: C:\Projeler\4-QR-Menu\publish-update.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DIR = __dirname;
const CHECK_FIRST_DELAY_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/* En fazla bir alt klasor, ".." yok, bilinen uzantilar - manifesto ele gecirilse
   bile kurulum klasoru disina ya da config.json'a yazilamaz. */
const SAFE_PATH = /^(?:[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_.-]+\.(?:js|html|css|json|webmanifest)$/;
/* index.html restoranin VERISIDIR (menu duzenleyici urunleri buraya yazar) - asla ezilmez */
const NEVER = ['config.json', 'upsell-rules.json', 'upsell-stats.json', 'customer-reviews.json', 'index.html'];

function log(...args) { console.log(new Date().toISOString(), '[guncelleme]', ...args); }

function localVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}
function parseVersion(v) { return String(v || '0').split('.').map(n => Number(n) || 0); }
function isNewer(remote, local) {
  const r = parseVersion(remote), l = parseVersion(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0, lv = l[i] || 0;
    if (rv !== lv) return rv > lv;
  }
  return false;
}
async function fetchBuffer(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000), cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} (${url})`);
  return Buffer.from(await r.arrayBuffer());
}
function checkSyntax(filePath) {
  return new Promise(resolve => execFile(process.execPath, ['--check', filePath], { windowsHide: true }, error => resolve(!error)));
}

let running = false;
async function runCheck(cloudUrl) {
  if (running) return;
  running = true;
  const base = `${String(cloudUrl || 'https://app.ornek-alanadi.com').replace(/\/+$/, '')}/qrmenu-update`;
  let stagingDir = null;
  try {
    let manifest;
    try { manifest = JSON.parse((await fetchBuffer(`${base}/version.json`)).toString('utf8')); }
    catch (error) { log('surum bilgisi alinamadi, atlaniyor:', error.message); return; }

    const remote = String(manifest.version || '');
    const files = (Array.isArray(manifest.files) ? manifest.files : [])
      .filter(f => f && SAFE_PATH.test(f.path) && !f.path.includes('..') && !NEVER.includes(f.path) && /^[a-f0-9]{64}$/.test(f.sha256));
    const local = localVersion();
    if (!remote || !files.length) { log('manifesto bos/gecersiz, atlaniyor.'); return; }
    if (!isNewer(remote, local)) return; /* guncel - saatte bir log kirletmesin diye sessiz */

    log(`yeni surum: ${local} -> ${remote}, ${files.length} dosya indiriliyor...`);
    stagingDir = path.join(os.tmpdir(), `qrmenu-update-${crypto.randomBytes(6).toString('hex')}`);
    for (const f of files) {
      /* ham veri olarak (.bin) iner - Cloudflare .html'i yolda degistirebiliyor */
      const buf = await fetchBuffer(`${base}/f/${f.sha256}.bin`);
      const sum = crypto.createHash('sha256').update(buf).digest('hex');
      if (sum !== f.sha256) throw new Error(`${f.path} parmak izi uyusmuyor - indirme bozuk, iptal.`);
      const dest = path.join(stagingDir, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
    for (const f of files) {
      if (f.path.endsWith('.js') && !(await checkSyntax(path.join(stagingDir, f.path)))) throw new Error(`${f.path} sozdizimi hatali - iptal, mevcut surum korunuyor.`);
      if (f.path.endsWith('.json')) JSON.parse(fs.readFileSync(path.join(stagingDir, f.path), 'utf8'));
    }
    const backupDir = path.join(DIR, 'update-backup', local);
    for (const f of files) {
      const live = path.join(DIR, f.path);
      if (fs.existsSync(live)) { fs.mkdirSync(path.dirname(path.join(backupDir, f.path)), { recursive: true }); fs.copyFileSync(live, path.join(backupDir, f.path)); }
    }
    /* Restoran kendi logosunu PNG yuklediyse sayfalardaki ./logo.jpg -> ./logo.png olarak
       degistirilmistir (server.js saveLogo). Yeni sayfalarda bu korunur. */
    const logoExt = ['.png', '.jpg', '.jpeg'].find(e => fs.existsSync(path.join(DIR, 'logo' + e)));
    for (const f of files) {
      const live = path.join(DIR, f.path);
      fs.mkdirSync(path.dirname(live), { recursive: true });
      if (logoExt && f.path.endsWith('.html')) {
        const html = fs.readFileSync(path.join(stagingDir, f.path), 'utf8').replace(/\.\/logo\.(png|jpg|jpeg)/g, './logo' + logoExt);
        fs.writeFileSync(live, html, 'utf8');
      } else fs.copyFileSync(path.join(stagingDir, f.path), live);
    }
    log(`guncelleme basarili: ${local} -> ${remote}. Servis yeniden baslatiliyor...`);
    setTimeout(() => process.exit(0), 500);
  } catch (error) {
    log('guncelleme basarisiz, MEVCUT SURUM DEGISTIRILMEDI:', error.message);
  } finally {
    if (stagingDir) { try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* onemsiz */ } }
    running = false;
  }
}

function start(cloudUrl) {
  const tick = () => runCheck(cloudUrl).catch(error => log('beklenmeyen hata (yoksayildi):', error.message));
  setTimeout(() => { tick(); setInterval(tick, CHECK_INTERVAL_MS); }, CHECK_FIRST_DELAY_MS);
}

module.exports = { start, runCheck, localVersion };
