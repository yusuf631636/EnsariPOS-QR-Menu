/* QR Menu otomatik guncelleme YAYINLAMA betigi (29.09.2026).
   Kullanim:
     1) package.json'daki "version"u artirin (orn. 1.6.1 -> 1.6.2)
     2) node publish-update.js
   Uygulama dosyalarini parmak izleriyle (SHA-256) birlikte
   C:\Projeler\1-Bulut\public\qrmenu-update\ altina koyar - bulut bunu
   https://app.ornek-alanadi.com/qrmenu-update/ adresinden dagitir. Restoranlardaki
   kurulumlar saatte bir bakar, yeni surumu kendileri alir (bkz. updater.js).
   config.json / resimler / veriler / node_modules GONDERILMEZ. Yeni bir npm
   paketi eklendiyse o surum ayrica exe olarak da kurulmalidir. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SRC = __dirname;
const OUT = 'C:\\Projeler\\1-Bulut\\public\\qrmenu-update';
const SAFE_PATH = /^(?:[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_.-]+\.(?:js|html|css|json|webmanifest)$/;
/* index.html GONDERILMEZ (30.09.2026): restoranin VERISIDIR - panelin menu duzenleyicisi urunleri,
   fiyatlari, aciklamalari dogrudan bu dosyaya yazar. Guncellenseydi her restoranin menusu
   ezilirdi. index.html'e gereken yeni ozellikler ayri .js dosyasi olarak eklenir ve
   server.js sayfayi gonderirken ekler (ör. reviews-strip.js). */
const TOP = ['server.js', 'sql.js', 'sambapos.js', 'menu-editor.js', 'distance.js', 'license.js', 'tunnel.js', 'upsell.js', 'updater.js', 'package.json',
  'reviews-strip.js', 'admin-icons.js', 'yeni.html', 'siparis.html', 'tv.html', 'iletisim.html', 'gizlilik-politikasi.html', 'garson.html',
  'garson-manifest.webmanifest', 'manifest.webmanifest'];
const DIRS = ['admin', 'garson-web']; /* sadece bu klasorlerin ILK seviyesindeki uygun dosyalar */

const version = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).version;
const list = TOP.filter(f => fs.existsSync(path.join(SRC, f)));
for (const d of DIRS) {
  if (!fs.existsSync(path.join(SRC, d))) continue;
  for (const f of fs.readdirSync(path.join(SRC, d))) {
    const rel = d + '/' + f;
    if (fs.statSync(path.join(SRC, d, f)).isFile() && SAFE_PATH.test(rel)) list.push(rel);
  }
}
for (const f of list.filter(f => f.endsWith('.js'))) execFileSync(process.execPath, ['--check', path.join(SRC, f)]); /* bozuk dosya yayinlanmaz */

/* Dosyalar parmak izi adiyla ".bin" olarak konur: Cloudflare .html sayfalarini
   yolda degistirebiliyor (e-posta gizleme vb.) ve parmak izi tutmuyordu;
   ham veri (application/octet-stream) oldugu gibi iletilir. */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'f'), { recursive: true });
const files = list.map(rel => {
  const buf = fs.readFileSync(path.join(SRC, rel));
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(path.join(OUT, 'f', sha256 + '.bin'), buf);
  return { path: rel, sha256 };
});
fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify({ version, publishedAt: new Date().toISOString(), files }, null, 2));
console.log(`Yayinlandi: surum ${version}, ${files.length} dosya -> ${OUT}`);
