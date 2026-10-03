/* index.html'i (musteri menusu) OKUYUP GUVENLI sekilde DUZENLEMEK icin - kullanici
   istegi (16.09.2026): "urun duzenleme, resim yukleme, urunleri SambaPOS'tan cek".

   YAKLASIM: index.html tamamen statik/duz HTML (JSON'dan render edilmiyor) - her
   urun TEK SATIRLIK bir <div class="menu-item" onclick="openModal(...)">...</div>.
   Bu dosyayi bir DOM parser'la yeniden yazmak yerine (kutuphane bagimliligi/riskli
   yeniden bicimlendirme), MEVCUT satir/desenlere gore HEDEFLI metin islemleri
   yapiliyor - boylece sitenin gorunumu/CSS'i/JS'i HICBIR sekilde degismiyor, sadece
   fiyat/isim/resim metni degisiyor ya da ayni kaliptan YENI bir satir ekleniyor. */
const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, 'index.html');

function readIndexHtml() { return fs.readFileSync(INDEX_PATH, 'utf8'); }
function writeIndexHtml(html) {
  // Her yazimdan once bir yedek al - yanlis giden bir seyi elle geri almak
  // MUMKUN olsun (kullanici "cok guzel" dedigi bir sayfayi bozmaktan kacinmak icin).
  try { fs.copyFileSync(INDEX_PATH, INDEX_PATH + '.bak'); } catch { /* yedek alinamadi - yine de devam, kritik degil */ }
  fs.writeFileSync(INDEX_PATH, html, 'utf8');
}

/* Dosyada Turkce harfler bazen numeric/named HTML entity (&#305; = ı, &uuml; = ü)
   bazen duz UTF-8 olarak geciyor (Chrome "Sayfayi Farkli Kaydet" karisik uretmis) -
   OKURKEN karsilastirma icin hepsini DUZ METNE cevirir. YAZARKEN entity uretmeye
   GEREK YOK - dosya zaten UTF-8, tarayici duz Turkce harfi de dogru gosterir. */
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', uuml: 'ü', Uuml: 'Ü', ouml: 'ö', Ouml: 'Ö', ccedil: 'ç', Ccedil: 'Ç', scedil: 'ş' };
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in named ? named[name] : m));
}
/* Yeni icerik eklerken SADECE HTML/JS'i BOZABILECEK karakterleri kacisla - Turkce
   harfler oldugu gibi (duz UTF-8) yazilir. */
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function escJsString(s) { return escHtml(s).replace(/'/g, '&#39;'); } // onclick="...openModal('...')" icindeki JS string'i icin

/* Site'deki her urunu (kategori, isim, fiyat, satir numarasi) cikarir - SADECE OKUMA,
   satiri degistirmez. lineIndex, applyPriceUpdate()'e GERI verilir ki AYNI isimli
   birden fazla urun varsa yanlislikla digerini degistirmeyelim. */
function parseSiteItems(html) {
  const lines = html.split('\n');
  const items = [];
  lines.forEach((line, lineIndex) => {
    if (!line.includes('class="menu-item"')) return;
    const catMatch = line.match(/^<div id="([^"]+)" class="menu-item"/);
    const nameMatch = line.match(/<strong>([^<]*)<\/strong>/);
    const priceMatch = line.match(/class="price-tag"[^>]*>([^<]*)<\/div>/);
    if (!catMatch || !nameMatch || !priceMatch) return;
    const descriptionMatch = line.match(/<small>([^<]*)<\/small>/);
    const badgesMatch = line.match(/data-badges="([^"]*)"/);
    const subcatMatch = line.match(/data-subcat="([^"]*)"/);
    const oldPriceMatch = line.match(/data-oldprice="([^"]*)"/);
    items.push({
      lineIndex, categoryIdRaw: catMatch[1], categoryName: decodeEntities(catMatch[1]), name: decodeEntities(nameMatch[1]),
      description: descriptionMatch ? decodeEntities(descriptionMatch[1]).trim() : '', priceRawText: priceMatch[1],
      badges: badgesMatch ? decodeEntities(badgesMatch[1]).split(',').filter(Boolean) : [],
      subcat: subcatMatch ? decodeEntities(subcatMatch[1]) : '',
      oldPrice: oldPriceMatch ? decodeEntities(oldPriceMatch[1]) : ''
    });
  });
  return items;
}
/* Ürün kartının dış div'inde bir data-* özniteliğini EKLER/GÜNCELLER/(değer boşsa)
   KALDIRIR - öne çıkan/yeni/indirimli/alt kategori etiketleri (kullanıcı isteği)
   BÖYLE saklanır; görsel rozet olarak GÖSTERİMİ index.html'deki ayrı, küçük bir
   script tarafından çalışma zamanında yapılır (bkz. decorateBadges script) - satırın
   kırılgan <strong>/<small>/price-tag regex'lerine HİÇ dokunulmaz, bozulma riski yok. */
function setDataAttr(line, attrName, value) {
  if (value === undefined) return line; // cagiran bu alani hic gondermediyse MEVCUT deger dokunulmadan kalir
  const clean = String(value || '').trim();
  const attrRe = new RegExp(`\\s${attrName}="[^"]*"`);
  if (attrRe.test(line)) {
    return clean ? line.replace(attrRe, ` ${attrName}="${escHtml(clean)}"`) : line.replace(attrRe, '');
  }
  if (!clean) return line;
  return line.replace('class="menu-item"', `class="menu-item" ${attrName}="${escHtml(clean)}"`);
}
/* Kategori bolumlerini (id + goruntulenen ad) bulur - yeni urun eklerken hangi
   bolume ekleneceğini SECMEK icin kullanilir. */
function parseCategories(html) {
  const cats = [];
  const re = /<div id="([^"]+)" class="menu-section">/g;
  let m;
  while ((m = re.exec(html))) cats.push({ idRaw: m[1], name: decodeEntities(m[1]) });
  return cats;
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ============================================================
   KATEGORİ YÖNETİMİ (yeniden adlandır / sırala / aktif-pasif / sil)
   Kullanıcı isteği - önceden hiç yoktu. rawSections dizisindeki SIRA hem
   nav butonlarının hem Ana Sayfa gridinin/drawer'ın sırasını belirler;
   bir kategori "pasif" yapılınca İÇERİĞİ (menu-section) SİLİNMEZ, sadece
   nav butonundan ve rawSections'tan çıkarılır - "aktif et" ile veri
   kaybı olmadan geri getirilebilir.
   ============================================================ */
function getRawSectionsList(html) {
  const m = html.match(/let rawSections = \[([^\]]*)\]/);
  if (!m) throw new Error('rawSections dizisi bulunamadı (sayfa yapısı beklenenden farklı).');
  return m[1].split(',').map(s => decodeEntities(s.trim().replace(/^'|'$/g, ''))).filter(Boolean);
}
function setRawSectionsList(html, list) {
  const arr = '[' + list.map(name => `'${escJsString(name)}'`).join(',') + ']';
  return html.replace(/let rawSections = \[[^\]]*\]/, `let rawSections = ${arr}`);
}
/* Kategori butonunu (category-buttons içindeki) bulur/kaldırır/ekler. */
function categoryButtonRegex(name) {
  return new RegExp(`\\s*<button data-id="${escapeRe(escHtml(name))}" onclick="showCategory\\('${escapeRe(escJsString(name))}'\\)">[^<]*</button>`);
}
function buildCategoryButton(name) {
  return `\n<button data-id="${escHtml(name)}" onclick="showCategory('${escJsString(name)}')">${escHtml(name)}</button>`;
}
/* Bir kategorinin TÜM bölümünü (açılış divi + içindeki tüm ürünler + kapanış)
   iç içe <div> sayarak GÜVENLİ şekilde bulur - naif ilk "</div>" araması
   menu-content/price-tag gibi iç div'lerde durup bölümü YARIM keserdi. */
function findCategorySectionBounds(html, name) {
  const openTag = `<div id="${escHtml(name)}" class="menu-section">`;
  const start = html.indexOf(openTag);
  if (start === -1) return null;
  let depth = 1, pos = start + openTag.length;
  while (depth > 0) {
    const nextOpen = html.indexOf('<div', pos);
    const nextClose = html.indexOf('</div>', pos);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) { depth++; pos = nextOpen + 4; }
    else { depth--; pos = nextClose + 6; }
  }
  return { start, end: pos };
}
/* Admin panelinde tek listede göstermek için: ad, ürün sayısı, aktif mi. */
function listCategoriesWithMeta(html) {
  const active = new Set(getRawSectionsList(html));
  return parseCategories(html).map(cat => {
    const bounds = findCategorySectionBounds(html, cat.name);
    const itemCount = bounds ? (html.slice(bounds.start, bounds.end).match(/class="menu-item"/g) || []).length : 0;
    return { idRaw: cat.idRaw, name: cat.name, active: active.has(cat.name), itemCount };
  });
}
function renameCategory(oldName, newName) {
  const cleanNew = String(newName || '').trim().slice(0, 80);
  if (!cleanNew) throw new Error('Yeni kategori adı boş olamaz.');
  let html = readIndexHtml();
  const bounds = findCategorySectionBounds(html, oldName);
  if (!bounds) throw new Error('Kategori bulunamadı.');
  const oldEsc = escHtml(oldName);
  let section = html.slice(bounds.start, bounds.end).split(`id="${oldEsc}"`).join(`id="${escHtml(cleanNew)}"`);
  html = html.slice(0, bounds.start) + section + html.slice(bounds.end);
  const btnRe = categoryButtonRegex(oldName);
  if (btnRe.test(html)) html = html.replace(btnRe, buildCategoryButton(cleanNew));
  const list = getRawSectionsList(html).map(n => n === oldName ? cleanNew : n);
  html = setRawSectionsList(html, list);
  writeIndexHtml(html);
}
function deleteCategory(name) {
  let html = readIndexHtml();
  const bounds = findCategorySectionBounds(html, name);
  if (!bounds) throw new Error('Kategori bulunamadı.');
  html = html.slice(0, bounds.start) + html.slice(bounds.end);
  html = html.replace(categoryButtonRegex(name), '');
  html = setRawSectionsList(html, getRawSectionsList(html).filter(n => n !== name));
  writeIndexHtml(html);
}
function setCategoryActive(name, active) {
  let html = readIndexHtml();
  if (!findCategorySectionBounds(html, name)) throw new Error('Kategori bulunamadı.');
  const list = getRawSectionsList(html);
  const has = list.includes(name);
  if (active && !has) {
    list.push(name);
    if (!categoryButtonRegex(name).test(html)) {
      const marker = '<div class="category-buttons" id="category-buttons">';
      const idx = html.indexOf(marker);
      if (idx !== -1) html = html.slice(0, idx + marker.length) + buildCategoryButton(name) + html.slice(idx + marker.length);
    }
  } else if (!active && has) {
    html = html.replace(categoryButtonRegex(name), '');
  }
  html = setRawSectionsList(html, active ? list : list.filter(n => n !== name));
  writeIndexHtml(html);
}
/* direction: -1 (yukarı) veya 1 (aşağı) - hem nav butonlarının hem
   bölümlerin (menu-section) hem rawSections dizisinin sırası birlikte
   değişir ki üçü de HER ZAMAN aynı sırada kalsın. */
function reorderCategory(name, direction) {
  let html = readIndexHtml();
  const list = getRawSectionsList(html);
  const i = list.indexOf(name);
  const j = i + direction;
  if (i === -1 || j < 0 || j >= list.length) throw new Error('Sıra değiştirilemedi (kategori en baştaysa yukarı, en sondaysa aşağı alınamaz).');
  const other = list[j];
  [list[i], list[j]] = [list[j], list[i]];
  html = setRawSectionsList(html, list);
  // Buton sırası
  const btnA = html.match(categoryButtonRegex(name));
  const btnB = html.match(categoryButtonRegex(other));
  if (btnA && btnB) {
    if (btnA.index < btnB.index) html = html.replace(btnA[0], '\u0000').replace(btnB[0], btnA[0]).replace('\u0000', btnB[0]);
    else html = html.replace(btnB[0], '\u0000').replace(btnA[0], btnB[0]).replace('\u0000', btnA[0]);
  }
  // Bölüm (menu-section) sırası
  const boundsA = findCategorySectionBounds(html, name);
  const boundsB = findCategorySectionBounds(html, other);
  if (boundsA && boundsB) {
    const sectA = html.slice(boundsA.start, boundsA.end);
    const sectB = html.slice(boundsB.start, boundsB.end);
    if (boundsA.start < boundsB.start) {
      html = html.slice(0, boundsA.start) + sectB + html.slice(boundsA.end, boundsB.start) + sectA + html.slice(boundsB.end);
    } else {
      html = html.slice(0, boundsB.start) + sectA + html.slice(boundsB.end, boundsA.start) + sectB + html.slice(boundsA.end);
    }
  }
  writeIndexHtml(html);
}

/* ============================================================
   YENİ KATEGORİ OLUŞTUR (boş)
   ============================================================ */
function addCategory(name) {
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!cleanName) throw new Error('Kategori adı boş olamaz.');
  let html = readIndexHtml();
  if (getRawSectionsList(html).includes(cleanName)) throw new Error('Bu isimde kategori zaten var.');

  // 1) rawSections dizisine ekle
  const list = getRawSectionsList(html);
  list.push(cleanName);
  html = setRawSectionsList(html, list);

  // 2) Nav butonu ekle (kategori-buttons içine)
  const marker = '<div class="category-buttons" id="category-buttons">';
  const idx = html.indexOf(marker);
  if (idx !== -1) {
    html = html.slice(0, idx + marker.length) + buildCategoryButton(cleanName) + html.slice(idx + marker.length);
  }

  // 3) Boş bölüm (menu-section) ekle - drawer-overlay'den hemen önce
  const drawIdx = html.indexOf('<div class="drawer-overlay"');
  if (drawIdx === -1) throw new Error('Drawer bölgesi bulunamadı.');
  const newSection = `\n<div id="${escHtml(cleanName)}" class="menu-section">\n</div>\n`;
  html = html.slice(0, drawIdx) + newSection + html.slice(drawIdx);

  writeIndexHtml(html);
}

/* ============================================================
   ÜRÜN SIRALAMA - kategori içinde yukarı/aşağı taşır
   ============================================================ */
function reorderItem(categoryName, lineIndex, direction) {
  const html = readIndexHtml();
  const lines = html.split('\n');
  const currentLine = lines[lineIndex];
  if (!currentLine || !currentLine.includes('class="menu-item"')) throw new Error('Ürün satırı bulunamadı.');

  // Aynı kategorideki tüm ürün satırlarını bul
  const catRe = new RegExp(`id="${escapeRe(escHtml(categoryName))}" class="menu-item"`);
  const catLines = lines.map((l, i) => ({ line: l, idx: i })).filter(x => catRe.test(x.line));

  const currentPos = catLines.findIndex(x => x.idx === lineIndex);
  const newPos = currentPos + direction;
  if (currentPos === -1 || newPos < 0 || newPos >= catLines.length) return;

  // Satırları yer değiştir
  const otherIdx = catLines[newPos].idx;
  [lines[lineIndex], lines[otherIdx]] = [lines[otherIdx], lines[lineIndex]];
  writeIndexHtml(lines.join('\n'));
}

/* Tek bir urunun fiyatini gunceller - HEM price-tag'deki HEM openModal(...) icindeki
   fiyat metnini, SADECE o satirda (baska satirlari etkilemez). Eski fiyat metni o
   satirda birden fazla yerde (iki yerde) ayni oldugu icin split/join HER IKISINI de
   dogru sekilde degistirir. */
function applyPriceUpdate(lineIndex, newPriceText) {
  const html = readIndexHtml();
  const lines = html.split('\n');
  if (!lines[lineIndex] || !lines[lineIndex].includes('class="menu-item"')) throw new Error('Satır bulunamadı (dosya bu arada değişmiş olabilir, sayfayı yenileyin).');
  const priceMatch = lines[lineIndex].match(/class="price-tag"[^>]*>([^<]*)<\/div>/);
  if (!priceMatch) throw new Error('Fiyat alanı bulunamadı.');
  const oldPriceRaw = priceMatch[1];
  lines[lineIndex] = lines[lineIndex].split(`'${oldPriceRaw}'`).join(`'${newPriceText}'`).split(`>${oldPriceRaw}<`).join(`>${newPriceText}<`);
  writeIndexHtml(lines.join('\n'));
}

function updateItem({ lineIndex, name, price, description, badges, subcat, oldPrice }) {
  const html = readIndexHtml();
  const lines = html.split('\n');
  const line = lines[lineIndex];
  if (!line || !line.includes('class="menu-item"')) throw new Error('Ürün satırı bulunamadı.');
  if (!parseSiteItems(html).some(i => i.lineIndex === lineIndex)) throw new Error('Ürün satırı okunamadı.');
  const nextName = String(name || '').trim().slice(0, 80);
  const nextPrice = String(price || '').trim().slice(0, 40);
  const nextDescription = String(description || '').trim().slice(0, 200);
  if (!nextName || !nextPrice) throw new Error('Ürün adı ve fiyat zorunlu.');
  const imageMatch = line.match(/<img src="([^"]+)"/);
  const image = imageMatch ? imageMatch[1] : `./${escHtml(nextName)}.jpg`;
  const modal = `onclick="openModal('${escJsString(nextName)}','${escJsString(nextDescription)}','${escJsString(nextPrice)}','${image}')"`;
  let next = line
    .replace(/onclick="openModal\([^\"]+\)"/, modal)
    .replace(/(<strong>)[\s\S]*?(<\/strong>)/, `$1${escHtml(nextName)}$2`)
    .replace(/(<small>)[\s\S]*?(<\/small>)/, `$1${escHtml(nextDescription)}$2`)
    .replace(/(class="price-tag"[^>]*>)[^<]*(<\/div>)/, `$1${escHtml(nextPrice)}$2`);
  next = setDataAttr(next, 'data-badges', Array.isArray(badges) ? badges.filter(Boolean).join(',') : undefined);
  next = setDataAttr(next, 'data-subcat', subcat);
  next = setDataAttr(next, 'data-oldprice', oldPrice);
  lines[lineIndex] = next;
  writeIndexHtml(lines.join('\n'));
}

function deleteItem(lineIndex) {
  const html = readIndexHtml();
  const lines = html.split('\n');
  if (!lines[lineIndex] || !lines[lineIndex].includes('class="menu-item"')) throw new Error('Ürün satırı bulunamadı.');
  lines.splice(lineIndex, 1);
  writeIndexHtml(lines.join('\n'));
}

/* Yeni bir urun karti ekler - MEVCUT urunlerle AYNI HTML kalibini kullanir (CSS/JS
   hic degismeden calisir), secilen kategorinin ILK urunu olarak eklenir. imageFile
   verilmezse "./transparent-ish" yerine dogrudan verilen dosya adi kullanilir - resim
   yoksa bile kart bozulmaz, sadece <img> kirik gorunur (kullanici sonradan resim
   yukleyebilir, ayni dosya adiyla otomatik eslesir). */
function addItem({ categoryIdRaw, name, price, description, imageFileName, badges, subcat, oldPrice }) {
  const html = readIndexHtml();
  const marker = `<div id="${categoryIdRaw}" class="menu-section">`;
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('Kategori bulunamadı.');
  const img = imageFileName ? `./${escHtml(imageFileName)}` : './logo.jpg';
  const nameEsc = escJsString(name), descEsc = escJsString(description), nameHtml = escHtml(name), descHtml = escHtml(description);
  const attrs = [
    Array.isArray(badges) && badges.filter(Boolean).length ? `data-badges="${escHtml(badges.filter(Boolean).join(','))}"` : '',
    subcat ? `data-subcat="${escHtml(String(subcat).trim())}"` : '',
    oldPrice ? `data-oldprice="${escHtml(String(oldPrice).trim())}"` : ''
  ].filter(Boolean).join(' ');
  const line = `\n<div id="${categoryIdRaw}" class="menu-item"${attrs ? ' ' + attrs : ''} onclick="openModal('${nameEsc}','${descEsc}','${escJsString(price)}','${img}')"><div class="menu-content"><div><img src="${img}" onerror="this.remove()"><div class="price-tag">${escHtml(price)}</div></div><div><strong>${nameHtml}</strong><small>${descHtml}</small></div></div></div>`;
  const newHtml = html.slice(0, idx + marker.length) + line + html.slice(idx + marker.length);
  writeIndexHtml(newHtml);
}

/* TUM menuyu SambaPOS'taki GUNCEL kategori/urun/fiyat listesinden yeniden olusturur
   (kullanici istegi, 16.09.2026: "menümü de yayınlayalım, oraya geçsin"). Sadece
   3 bolge degistirilir - sayfanin GERISI (header, tema, drawer/modal mekanizmasi,
   CSS, footer) HIC DOKUNULMAZ:
     1) Kategori pill butonlari (<div class="category-buttons">...)
     2) Kategori bolumleri (her biri <div id="X" class="menu-section">...<item'ler>...</div>)
     3) rawSections JS dizisi (drawer/home-grid/swipe bunu kullanir)
   Resim: dosya adi urun ADINDAN turetilir (./{Isim}.jpg) - klasorde AYNI isimde
   (Windows'ta buyuk/kucuk harf FARK ETMEZ) bir foto zaten varsa OTOMATIK eslesir,
   yoksa kirik gorunur ama admin panelinden "Gorsel Yukle" ile sonradan eklenebilir -
   hicbir foto SILINMEZ/degistirilmez, sadece referans isimleri guncellenir. */
function regenerateFullMenu(rawCategories) {
  let html = readIndexHtml();
  if (!rawCategories.length) throw new Error('SambaPOS\'ta gösterilecek kategori/ürün bulunamadı.');

  /* SambaPOS'ta AYNI ISIMLI kategori birden fazla "Ekran Menüsü" (ScreenMenu) sayfasında
     FARKLI ID ile tekrar tanimlanmis olabilir (canli veride tespit edildi - orn. "Kebap
     Çeşitleri" 2 kez geliyor). HTML id'si TEKIL olmak ZORUNDA (getElementById sadece
     ilkini bulur, digeri tiklanamaz/kaybolur hale gelirdi) - bu yuzden ayni (temizlenmis)
     isimli kategoriler BURADA birlestirilir. Isimdeki kontrol karakterleri (\r/\n/tab -
     SambaPOS'un kendi verisinde bulunan bir veri kalitesi sorunu) de temizlenir. */
  const cleanName = s => String(s || '')
    .replace(/\\[rnt]/g, ' ')   // SambaPOS'ta bazen GERCEK kontrol karakteri degil, duz metin "\r" (ters egik + r) olarak kayitli
    .replace(/[\r\n\t]+/g, ' ') // gercek kontrol karakterleri (varsa)
    .replace(/\s+/g, ' ').trim();
  const byName = new Map();
  const categories = [];
  for (const cat of rawCategories) {
    const name = cleanName(cat.name);
    if (!name) continue;
    let merged = byName.get(name);
    if (!merged) { merged = { name, items: [] }; byName.set(name, merged); categories.push(merged); }
    merged.items.push(...cat.items);
  }

  // --- 1) Kategori pill butonlari ---
  const btnStart = html.indexOf('<div class="category-buttons" id="category-buttons">');
  if (btnStart === -1) throw new Error('Kategori buton bölgesi bulunamadı (sayfa yapısı beklenenden farklı).');
  const btnClose = html.indexOf('</div>', btnStart) + '</div>'.length;
  const btnHtml = '<div class="category-buttons" id="category-buttons">\n' +
    '<button class="active" data-id="anasayfa" onclick="showCategory(\'anasayfa\')">Ana Sayfa</button>\n' +
    categories.map(c => `<button data-id="${escHtml(c.name)}" onclick="showCategory('${escJsString(c.name)}')">${escHtml(c.name)}</button>`).join('\n') +
    '\n</div>';
  html = html.slice(0, btnStart) + btnHtml + html.slice(btnClose);

  // --- 2) Kategori bolumleri (anasayfa hariç, ilk kategoriden drawer'a kadar) ---
  const firstSecStart = html.indexOf('<div class="drawer-overlay"');
  // Ilk gercek kategori acilisi: anasayfa'nin kendi kapanisindan SONRAKI ilk "menu-section"
  const anasayfaOpen = html.indexOf('<div id="anasayfa" class="menu-section active">');
  const firstCatStart = html.indexOf('class="menu-section">', anasayfaOpen);
  const firstCatDivStart = html.lastIndexOf('<div id="', firstCatStart);
  if (anasayfaOpen === -1 || firstCatDivStart === -1 || firstSecStart === -1) throw new Error('Menü bölümleri bulunamadı (sayfa yapısı beklenenden farklı).');

  const sectionsHtml = categories.map(cat => {
    const items = cat.items.map(item => {
      const priceText = item.price.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
      const img = `./${escHtml(item.name)}.jpg`;
      return `<div id="${escHtml(cat.name)}" class="menu-item" onclick="openModal('${escJsString(item.name)}','','${priceText}','${img}')"><div class="menu-content"><div><img src="${img}" onerror="this.remove()"><div class="price-tag">${priceText}</div></div><div><strong>${escHtml(item.name)}</strong><small></small></div></div></div>`;
    }).join('\n');
    return `<div id="${escHtml(cat.name)}" class="menu-section">\n${items}\n</div>`;
  }).join('');

  html = html.slice(0, firstCatDivStart) + sectionsHtml + '\n<!-- Drawer -->\n' + html.slice(firstSecStart);

  // --- 3) rawSections JS dizisi ---
  const newArray = "['anasayfa'," + categories.map(c => `'${escJsString(c.name)}'`).join(',') + ']';
  html = html.replace(/let rawSections = \[[^\]]*\]/, `let rawSections = ${newArray}`);

  writeIndexHtml(html);
  return { categoryCount: categories.length, itemCount: categories.reduce((s, c) => s + c.items.length, 0) };
}

module.exports = {
  parseSiteItems, parseCategories, applyPriceUpdate, updateItem, deleteItem, addItem, regenerateFullMenu, decodeEntities,
  listCategoriesWithMeta, renameCategory, deleteCategory, setCategoryActive, reorderCategory, addCategory, reorderItem
};
