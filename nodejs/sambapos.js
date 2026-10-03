/* QR Menu yonetim paneli - SambaPOS SQL islemleri. */
const { sql, rows } = require('./sql');
const crypto = require('crypto');

function sqlWide(query) { return sql(query, { wide: true }); }

/* 27.09.2026 (kullanici istegi: "acılı/soğansız gibi seçenekler eklensin,
   SambaPOS'un kendi sistemiyle") - SambaPOS'un kendi "Sipariş Etiketleri"
   (OrderTagGroups/OrderTags) tablolarından restoranın KENDİ SambaPOS'ta
   tanımladığı grupları okur. Admin panelinden bunlardan biri QR Menü için
   seçilir; JSON şekli SambaPOS'un kendi kaynağındaki OrderTagValue.cs
   sınıfıyla BİREBİR aynı (kısaltılmış anahtarlar: TN, TV, UI, OI, OK) -
   böylece SambaPOS terminalinde ve mutfak fişinde gerçek/native bir etiket
   gibi görünür, ayrı bir "not" olarak değil. */
async function getOrderTagGroups() {
  const found = rows(await sqlWide(`SET NOCOUNT ON;
    SELECT Id, Name, ISNULL(MinSelectedItems,0), ISNULL(MaxSelectedItems,0)
    FROM OrderTagGroups WHERE ISNULL(Hidden,0) = 0 ORDER BY SortOrder, Id;`), ['id', 'name', 'minSelected', 'maxSelected']);
  const groups = [];
  for (const g of found) {
    const tags = rows(await sqlWide(`SET NOCOUNT ON;
      SELECT Id, Name, ISNULL(Price,0) FROM OrderTags WHERE OrderTagGroupId = ${Number(g.id)} ORDER BY SortOrder, Id;`), ['id', 'name', 'price']);
    groups.push({
      id: Number(g.id), name: g.name,
      minSelected: Number(g.minSelected) || 0, maxSelected: Number(g.maxSelected) || 0,
      tags: tags.map(t => ({ id: Number(t.id), name: t.name, price: Number(t.price) || 0 }))
    });
  }
  return groups;
}

/* ============================================================
   MENÜ ÇEK
   - screenMenuId verilirse SADECE o SambaPOS ekran menüsündeki (örn. sadece
     "QRMenu") kategoriler çekilir; verilmezse (eski davranış, statik site
     yayınlama/karşılaştırma için) TÜM ekran menüleri birleşik gelir.
   - priceTag='PAKET' istenirse ürünün "PAKET" (paket servis) fiyat etiketi
     varsa O kullanılır, yoksa normal (etiketsiz) fiyata düşer - kullanıcı
     talebi/tespiti: "paket siparişlerde bazı ürünlerin paket fiyatı var,
     bunu kullanmalıyız, yoksa restoran zarar ediyor".
   - Her ürünün TÜM porsiyonları (Adana Kebap → Porsiyon/1,5 Porsiyon/Dürüm
     gibi) "portions" dizisinde döner; item.price ilk (en düşük id'li)
     porsiyonun fiyatıdır (tek porsiyonlu ürünlerin çoğu için zaten tek
     porsiyon var, eski davranışla uyumlu).
   ============================================================ */
async function liveMenu({ screenMenuId, priceTag } = {}) {
  const menuFilter = screenMenuId ? `AND sc.ScreenMenuId = ${Number(screenMenuId)}` : '';
  const tagLiteral = priceTag ? `N'${sqlEsc(priceTag)}'` : null;
  const priceExpr = tagLiteral
    ? `COALESCE(
        (SELECT TOP 1 Price FROM MenuItemPrices WHERE MenuItemPortionId = mpo.Id AND PriceTag = ${tagLiteral}),
        (SELECT TOP 1 Price FROM MenuItemPrices WHERE MenuItemPortionId = mpo.Id AND PriceTag IS NULL),
        (SELECT TOP 1 Price FROM MenuItemPrices WHERE MenuItemPortionId = mpo.Id), 0)`
    : `COALESCE(
        (SELECT TOP 1 Price FROM MenuItemPrices WHERE MenuItemPortionId = mpo.Id AND PriceTag IS NULL),
        (SELECT TOP 1 Price FROM MenuItemPrices WHERE MenuItemPortionId = mpo.Id), 0)`;
  const query = `SET NOCOUNT ON;
    SELECT sc.Id, sc.Name, sc.SortOrder,
      si.Id, COALESCE(NULLIF(si.Name,''), mi.Name), si.SortOrder,
      mpo.Id, mpo.Name, ${priceExpr}
    FROM ScreenMenuItems si
    JOIN ScreenMenuCategories sc ON sc.Id = si.ScreenMenuCategoryId
    JOIN MenuItems mi ON mi.Id = si.MenuItemId
    JOIN MenuItemPortions mpo ON mpo.MenuItemId = mi.Id
    WHERE 1=1 ${menuFilter}
    ORDER BY sc.SortOrder, sc.Id, si.SortOrder, si.Id, mpo.Id;`;
  const flat = rows(await sqlWide(query), ['categoryId', 'categoryName', 'categorySort', 'itemId', 'itemName', 'itemSort', 'portionId', 'portionName', 'price']);
  const categories = [];
  const catById = new Map();
  const itemByKey = new Map();
  for (const row of flat) {
    let cat = catById.get(row.categoryId);
    if (!cat) { cat = { id: row.categoryId, name: row.categoryName, items: [] }; catById.set(row.categoryId, cat); categories.push(cat); }
    const itemKey = row.categoryId + ':' + row.itemId;
    let item = itemByKey.get(itemKey);
    if (!item) {
      item = { id: row.itemId, name: row.itemName, price: +row.price, portions: [] };
      itemByKey.set(itemKey, item);
      cat.items.push(item);
    }
    item.portions.push({ id: row.portionId, name: row.portionName, price: +row.price });
  }
  return categories;
}

/* Admin panelinde "Hangi menüden ürünler çekilsin?" seçimi için. */
async function liveScreenMenus() {
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT Id, Name FROM ScreenMenus ORDER BY Id;`), ['id', 'name']);
  return found.map(r => ({ id: +r.id, name: r.name }));
}

/* garson-web/Config.html'in Terminal/Departman/Adisyon Tipi/Menu/Masa Ekrani
   alanlarini ELLE YAZDIRMAK yerine (kullanici istegi, 26.09.2026: "degerleri
   otomatik cekmez mi") SambaPOS veritabanindaki GERCEK isimleri dogrudan
   sorgular - yanlis/hatali yazilan bir isim yuzunden terminalin sessizce
   calismamasi (SignalR/GraphQL sorgularinin bos donmesi) onlenir. */
async function terminalConfigOptions() {
  const [terminals, departments, ticketTypes, menus, entityScreens, automationCommands] = await Promise.all([
    rows(await sqlWide(`SET NOCOUNT ON; SELECT Id, Name FROM Terminals ORDER BY Id;`), ['id', 'name']),
    rows(await sqlWide(`SET NOCOUNT ON; SELECT Id, Name FROM Departments ORDER BY Id;`), ['id', 'name']),
    rows(await sqlWide(`SET NOCOUNT ON; SELECT Id, Name FROM TicketTypes ORDER BY Id;`), ['id', 'name']),
    rows(await sqlWide(`SET NOCOUNT ON; SELECT Id, Name FROM ScreenMenus ORDER BY Id;`), ['id', 'name']),
    rows(await sqlWide(`SET NOCOUNT ON; SELECT es.Id, es.Name, et.Name AS EntityTypeName FROM EntityScreens es LEFT JOIN EntityTypes et ON et.Id = es.EntityTypeId ORDER BY es.Id;`), ['id', 'name', 'entityTypeName']),
    rows(await sqlWide(`SET NOCOUNT ON; SELECT Id, Name FROM AutomationCommands ORDER BY Id;`), ['id', 'name']),
  ]);
  return {
    terminals: terminals.map(r => r.name),
    departments: departments.map(r => r.name),
    ticketTypes: ticketTypes.map(r => r.name),
    menus: menus.map(r => r.name),
    entityScreens: entityScreens.map(r => ({ name: r.name, entityType: r.entityTypeName })),
    automationCommands: automationCommands.map(r => r.name),
  };
}

/* ============================================================
   MASA LİSTESİ (SambaPOS'tan)
   ============================================================ */
async function liveTables() {
  try {
    const masaTypeRow = rows(await sqlWide(`SET NOCOUNT ON; 
      SELECT TOP 1 Id FROM EntityTypes WHERE Name = N'Masalar';`), ['id'])[0];
    const masaTypeId = masaTypeRow ? +masaTypeRow.id : 2;

    const query = `SET NOCOUNT ON;
      SELECT Id, Name FROM Entities WHERE EntityTypeId = ${masaTypeId} ORDER BY Name;`;
    const flat = rows(await sqlWide(query), ['id', 'name']);
    if (!flat.length) return [];

    const bySection = new Map();
    for (const t of flat) {
      const firstChar = (t.name || '?').charAt(0).toUpperCase();
      const section = /[A-Z]/.test(firstChar) ? firstChar + ' Blok' : 'Masalar';
      if (!bySection.has(section)) bySection.set(section, { name: section, tables: [] });
      bySection.get(section).tables.push({ id: +t.id, name: t.name });
    }
    return Array.from(bySection.values());
  } catch (error) {
    console.error('Masa listesi hatası:', error.message);
    return [];
  }
}

/* Belirli bir masa SambaPOS'ta var mı? */
/* CANLI BULGU (18.09.2026): SambaPOS'taki gerçek masa adları duzensiz
   formatta ("MASA -5", "ÜST KAT- 3" gibi - bosluk/tire yerlesimi masadan
   masaya FARKLI). Once TAM eşleşme denenir (Masalar admin sekmesinde
   uretilen QR linkleri zaten TAM adi tasir); bulunamazsa bosluklari
   silip kucuk harfe cevirerek (case/whitespace-toleranslı) YENIDEN denenir -
   "5" gibi TEK BASINA bir numara asla eslesmez (bilerek), cunku "MASA -5"
   ile "ÜST KAT- 5" AYNI numaraya sahip olabilir ve numaraya gore eslesme
   YANLIS masaya siparis yazma riski tasirdi. */
async function findTableByName(name) {
  if (!name) return null;
  try {
    const masaTypeRow = rows(await sqlWide(`SET NOCOUNT ON;
      SELECT TOP 1 Id FROM EntityTypes WHERE Name = N'Masalar';`), ['id'])[0];
    const masaTypeId = masaTypeRow ? +masaTypeRow.id : 2;

    const target = String(name).trim();
    const all = rows(await sqlWide(`SET NOCOUNT ON; SELECT Id, Name FROM Entities WHERE EntityTypeId = ${masaTypeId};`), ['id', 'name']);
    let found = all.find(t => t.name.trim() === target);
    if (!found) {
      const norm = s => s.replace(/\s+/g, '').toLocaleLowerCase('tr-TR');
      const targetNorm = norm(target);
      found = all.find(t => norm(t.name) === targetNorm);
    }
    return found ? { id: +found.id, name: found.name } : null;
  } catch (e) {
    console.error('Masa arama hatası:', e.message);
    return null;
  }
}

/* Masada AÇIK (kapanmamış) adisyon var mı? Varsa siparişin bu adisyona
   EKLENMESİ gerekir - yeni bağımsız adisyon açılmaz (kullanıcı talebi:
   "masa zaten açıksa aynı adisyona ürünleri ekle"). */
async function findOpenTableTicket(tableEntityId) {
  const found = rows(await sqlWide(`SET NOCOUNT ON;
    SELECT TOP 1 t.Id, t.TicketNumber FROM Tickets t
    JOIN TicketEntities te ON te.Ticket_Id = t.Id
    WHERE te.EntityId = ${Number(tableEntityId)} AND te.EntityTypeId = 2 AND t.TicketTypeId = 1 AND t.IsClosed = 0
    ORDER BY t.Id DESC;`), ['id', 'ticketNumber'])[0];
  return found ? { id: +found.id, ticketNumber: +found.ticketNumber } : null;
}

/* Kategoriye göre mutfak yazıcısı yönlendirmesi - SambaPOS'ta ZATEN tanımlı olan
   "Siparişleri Mutfağa Yazdır" görevindeki kategori→yazıcı eşlemesini OKUR
   (örn. Pide/Lahmacun → FIRIN, Kebap/Köfte/Dürüm → KEBAP), koda hiçbir eşleme
   SABİT yazılmaz - SambaPOS'ta değişirse otomatik yansır. */
async function getKitchenPrinterRouting() {
  try {
    const found = rows(await sqlWide(`SET NOCOUNT ON;
      SELECT pm.MenuItemGroupCode, p.ShareName
      FROM PrinterMaps pm
      JOIN Printers p ON p.Id = pm.PrinterId
      WHERE pm.PrintJobId = (SELECT TOP 1 Id FROM PrintJobs WHERE Name = N'Siparişleri Mutfağa Yazdır')
      ORDER BY pm.Id;`), ['groupCode', 'shareName']);
    const byCategory = {};
    let defaultPrinter = null;
    for (const r of found) {
      if (!r.groupCode || r.groupCode === 'NULL') { if (!defaultPrinter) defaultPrinter = r.shareName; continue; }
      if (!byCategory[r.groupCode]) byCategory[r.groupCode] = r.shareName;
    }
    return { byCategory, defaultPrinter };
  } catch (e) {
    console.error('Yazıcı yönlendirme okunamadı:', e.message);
    return { byCategory: {}, defaultPrinter: null };
  }
}

/* Müşteri QR'ı tekrar okuttuğunda masasının güncel siparişini görebilmesi
   için - açık adisyon yoksa null döner (masada henüz sipariş yok demektir).
   İptal edilen (CalculatePrice=0) satırlar hariç tutulur. */
async function getTableOrderSummary(tableName) {
  const table = await findTableByName(tableName);
  if (!table) return null;
  const ticket = await findOpenTableTicket(table.id);
  if (!ticket) return null;
  const items = rows(await sqlWide(`SET NOCOUNT ON;
    SELECT MenuItemName, PortionName, Price, Quantity FROM Orders
    WHERE TicketId = ${ticket.id} AND CalculatePrice = 1 ORDER BY Id;`), ['name', 'portion', 'price', 'qty']);
  const list = items.map(i => ({ name: i.name, portion: i.portion, price: +i.price, quantity: +i.qty }));
  return { ticketNumber: ticket.ticketNumber, items: list, total: list.reduce((s, i) => s + i.price * i.quantity, 0) };
}

/* Varsayılan paketçi (ilk aktif) */
async function findDefaultPaketci() {
  try {
    const paketciTypeRow = rows(await sqlWide(`SET NOCOUNT ON; 
      SELECT TOP 1 Id FROM EntityTypes WHERE Name = N'Paketçiler';`), ['id'])[0];
    const paketciTypeId = paketciTypeRow ? +paketciTypeRow.id : 3;

    const found = rows(await sqlWide(`SET NOCOUNT ON; 
      SELECT TOP 1 Id, Name FROM Entities WHERE EntityTypeId = ${paketciTypeId} ORDER BY Id;`), ['id', 'name'])[0];
    return found ? { id: +found.id, name: found.name, typeId: paketciTypeId } : null;
  } catch (e) {
    console.error('Paketçi arama hatası:', e.message);
    return null;
  }
}

/* ============================================================
   ADMIN PIN DOĞRULAMA
   ============================================================ */
function sqlEsc(value) { return String(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, 200).replace(/'/g, "''"); }
async function adminValidByPin(pin) {
  return (await checkPin(pin)).isAdmin;
}

/* 29.09.2026 kullanici bulgusu: "sambapos pin hatali diyor aslinda dogru".
   Eski kontrol SADECE adinda "admin" gecen ILK rolu kabul ediyordu (SQL LOWER()
   ile - Turkce collation'da LOWER('ADMIN') = 'admın' oldugu icin o bile
   kaciyordu). Restoranda rol "Yönetici"/"Patron"/"Müdür" adliysa ya da birden
   fazla yonetici rolu varsa DOGRU PIN "hatali" sayiliyordu. Artik:
   - PIN'in sahibi kullanici ve rolu bulunur (bosluklar yok sayilir),
   - rol adi JS tarafinda Turkce harfler sadelestirilerek yonetici kaliplarina
     bakilir; veritabaninda hic boyle rol yoksa eski davranis (rol Id 1),
   - sonuc ayrintili doner ki kullaniciya NEDEN reddedildigi soylenebilsin. */
const ADMIN_ROLE_RE = /admin|yonetici|patron|mudur|sahib|owner|manager|supervisor/;
function normRoleName(s) {
  return String(s || '').toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g');
}
function normalizePin(pin) { return String(pin || '').replace(/\s+/g, ''); }
async function checkPin(pin) {
  try { return await checkPinOnce(pin); }
  catch (e) { // ara sira gorulen "Login timeout expired" - bir kez daha dene
    await new Promise(r => setTimeout(r, 1500));
    return checkPinOnce(pin);
  }
}
async function checkPinOnce(pin) {
  pin = normalizePin(pin);
  if (!/^\d+$/.test(pin)) return { found: false, isAdmin: false };
  const roles = rows(await sqlWide(`SET NOCOUNT ON; SELECT Id, Name FROM UserRoles;`), ['id', 'name']);
  const anyAdminNamed = roles.some(r => ADMIN_ROLE_RE.test(normRoleName(r.name)));
  const users = rows(await sqlWide(`SET NOCOUNT ON;
    SELECT TOP 10 u.Name, ISNULL(u.UserRole_Id, 0), ISNULL(r.Name, '')
    FROM Users u LEFT JOIN UserRoles r ON r.Id = u.UserRole_Id
    WHERE LTRIM(RTRIM(u.PinCode)) = N'${sqlEsc(pin)}';`), ['name', 'roleId', 'role']);
  if (!users.length) return { found: false, isAdmin: false };
  const isAdminUser = u => anyAdminNamed ? ADMIN_ROLE_RE.test(normRoleName(u.role)) : +u.roleId === 1;
  const admin = users.find(isAdminUser);
  const u = admin || users[0];
  return { found: true, isAdmin: !!admin, userName: u.name, role: u.role };
}

/* ============================================================
   SİPARİŞ OLUŞTURMA
   ============================================================ */
function netDateNow() { return `/Date(${Date.now()}+0300)/`; }

async function nextNumeratorValue(name) {
  const q = `SET NOCOUNT ON; UPDATE Numerators SET Number = Number + 1 OUTPUT INSERTED.Number WHERE Name = N'${sqlEsc(name)}';`;
  const result = rows(await sqlWide(q), ['n'])[0];
  if (!result) throw new Error(`Numaratör bulunamadı: ${name}`);
  return +result.n;
}

let cachedQrUserId = null;
async function qrMenuUserId() {
  if (cachedQrUserId) return cachedQrUserId;
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT TOP 1 Id FROM Users WHERE Name = N'QR Menü';`), ['id'])[0];
  if (found) { cachedQrUserId = +found.id; return cachedQrUserId; }
  const roleFound = rows(await sqlWide(`SET NOCOUNT ON; SELECT TOP 1 Id FROM UserRoles WHERE LOWER(Name) LIKE N'%entegrasyon%' ORDER BY Id;`), ['id'])[0];
  const roleId = roleFound ? +roleFound.id : 1;
  const insertResult = rows(await sqlWide(`SET NOCOUNT ON;
    INSERT INTO Users (Name, UserRole_Id, SevenShiftsEmployeeId) VALUES (N'QR Menü', ${roleId}, 0);
    SELECT SCOPE_IDENTITY() AS id;`), ['id'])[0];
  cachedQrUserId = +insertResult.id;
  return cachedQrUserId;
}

/* Kullanici istegi (26.09.2026): "ben varlık tipi ekledim QR Menü olarak,
   otomatik oluştursun" - QR Menü siparişlerinin müşterileri artık genel
   "Müşteriler" havuzuna degil, SambaPOS'ta ayirt edilebilmesi icin KENDI
   "QR Menü" varlık tipine baglaniyor. Yoksa (yeni kurulum) OTOMATIK olusturulur
   - "Müşteriler" varlik tipinin (varsa) AYNI alan yapisindan (AccountTypeId/
   WarehouseTypeId/AccountNameTemplate/PrimaryFieldName) kopyalanir, boylece
   musteri hesabi/bakiye takibi ayni sekilde calismaya devam eder. */
let cachedCustomerEntityTypeId = null;
async function customerEntityTypeId() {
  if (cachedCustomerEntityTypeId) return cachedCustomerEntityTypeId;
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT TOP 1 Id FROM EntityTypes WHERE Name = N'QR Menü' ORDER BY Id;`), ['id'])[0];
  if (found) { cachedCustomerEntityTypeId = +found.id; return cachedCustomerEntityTypeId; }

  const template = rows(await sqlWide(`SET NOCOUNT ON; SELECT TOP 1 AccountTypeId, WarehouseTypeId, AccountNameTemplate, PrimaryFieldName FROM EntityTypes WHERE Name = N'Müşteriler' ORDER BY Id;`),
    ['accountTypeId', 'warehouseTypeId', 'accountNameTemplate', 'primaryFieldName'])[0];
  const accountTypeId = template ? +template.accountTypeId : 0;
  const warehouseTypeId = template ? +template.warehouseTypeId : 0;
  const accountNameTemplate = template && template.accountNameTemplate ? sqlEsc(template.accountNameTemplate) : '[Name]-[Telefon]';
  const primaryFieldName = template && template.primaryFieldName ? sqlEsc(template.primaryFieldName) : 'Adı';

  const insertResult = rows(await sqlWide(`SET NOCOUNT ON;
    INSERT INTO EntityTypes (SortOrder, EntityName, AccountTypeId, WarehouseTypeId, AccountNameTemplate, PrimaryFieldName, Name)
      VALUES (0, N'Müşteri', ${accountTypeId}, ${warehouseTypeId}, N'${accountNameTemplate}', N'${primaryFieldName}', N'QR Menü');
    SELECT SCOPE_IDENTITY() AS id;`), ['id'])[0];
  console.log(`✅ "QR Menü" varlık tipi otomatik oluşturuldu (Id: ${insertResult.id})`);
  cachedCustomerEntityTypeId = +insertResult.id;
  return cachedCustomerEntityTypeId;
}
let cachedCustomerAccountTypeId = null;
async function customerAccountTypeId() {
  if (cachedCustomerAccountTypeId !== null) return cachedCustomerAccountTypeId;
  const entityType = await customerEntityTypeId();
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT AccountTypeId FROM EntityTypes WHERE Id=${entityType};`), ['accountTypeId'])[0];
  cachedCustomerAccountTypeId = found ? +found.accountTypeId : 0;
  return cachedCustomerAccountTypeId;
}
async function findCustomerEntityId(phoneDigits) {
  if (!phoneDigits) return null;
  const entityType = await customerEntityTypeId();
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT TOP 1 Id, COALESCE(AccountId,0) FROM Entities WHERE EntityTypeId=${entityType} AND Name=N'${sqlEsc(phoneDigits)}';`), ['id', 'accountId'])[0];
  return found ? { id: +found.id, accountId: +found.accountId } : null;
}

/* ============================================================
   SİPARİŞ OLUŞTUR (SambaPOS'a yazar)
   type: 'table' | 'delivery' | 'pickup'
   ============================================================ */
async function createOrder({ type, tableNumber, customerName, phone, address, note, zone, items }) {
  if (!Array.isArray(items) || !items.length) throw new Error('Sepet boş.');

  const orderType = type || 'delivery';
  const userId = await qrMenuUserId();
  const total = items.reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0);
  const phoneDigits = String(phone || '').replace(/\D/g, '');
  const now = netDateNow();

  /* ============================================================
     MASA SİPARİŞİ - masa zaten AÇIK bir adisyona sahipse (garson daha
     önce sipariş girmiş olabilir) yeni bağımsız adisyon AÇILMAZ, QR'dan
     gelen ürünler mevcut adisyona eklenir. Kullanıcı talebi: "aynı
     adisyona ürünleri ekle".
     ============================================================ */
  let ticketId = null, ticketNumber = null, appendedToExisting = false;
  let tableEntity = null;
  if (orderType === 'table' && tableNumber) {
    tableEntity = await findTableByName(tableNumber);
    /* Masa SambaPOS'ta bulunamazsa artik SESSIZCE masasiz bir adisyon
       ACILMAZ (canli bulgu, 18.09.2026: oncesinde boyle bir "hayalet"
       adisyon olusuyordu, hicbir masaya baglanmadigi icin SambaPOS'un
       Masalar ekraninda GORUNMUYORDU). Hata firlatilir, admin onay
       vermeden hicbir SQL yazimi yapilmaz. */
    if (!tableEntity) throw new Error(`Masa "${tableNumber}" SambaPOS'ta bulunamadı. Lütfen /admin > Masalar sekmesinden güncel QR kodu kullanın.`);
    const existing = await findOpenTableTicket(tableEntity.id);
    if (existing) {
      ticketId = existing.id;
      ticketNumber = existing.ticketNumber;
      appendedToExisting = true;
    }
  }

  /* ============================================================
     KÖK NEDEN DÜZELTMESİ (26.09.2026, canlı bulgu: SambaPOS'ta ödeme
     alırken "Adisyonda bir değişiklik yapılmış. Son işlemi tekrar
     yapınız. -exp3" ve bir seferinde PROGRAMIN ÇÖKMESİ) - eskiden
     adisyon/toplam TEK BAŞINA yazılıyor, sonra her sipariş satırı AYRI
     bir sqlWide() çağrısında (= AYRI bir sqlcmd süreci = AYRI SQL
     bağlantısı, kendi başına commit eden) TEK TEK ekleniyordu. Bu
     yüzden SambaPOS'un canlı yenilenen Paket Servis ekranı, adisyonu
     satırlar HENÜZ TAMAMLANMADAN (toplam dolu ama kalem sayısı eksik/
     değişen halde) yakalayıp önbelleğe alabiliyordu - kasiyer o
     adisyona dokunduğunda SambaPOS "veri değişti" diyordu, bazen de bu
     tutarsız ara durum SambaPOS'un kendi tarafında beklenmeyen bir
     hataya (çökme) yol açıyordu. Artık adisyon/güncelleme VE TÜM
     sipariş satırları TEK bir SQL toplu işinde, BEGIN TRAN...COMMIT ile
     atomik olarak yazılıyor - başka hiçbir bağlantı (SambaPOS terminali
     dahil) bu adisyonu YARIM/değişen halde GÖREMEZ; ya hiç görmez ya da
     TAM ve nihai haliyle görür. */
  const orderNumber = await nextNumeratorValue('Sipariş Numaratörü');
  let orderLinesSql = '';
  for (const item of items) {
    const portionName = item.portionName || 'Adet';
    const orderStates = JSON.stringify([{ D: now, S: 'Gönderildi', SN: 'Status', SV: '', U: userId }]).replace(/'/g, "''");
    /* 27.09.2026 (kullanici istegi: "acılı/soğansız gibi seçenekler,
       SambaPOS'un kendi sistemiyle") - OrderUid artık SQL'de NEWID() ile
       DEĞİL, burada JS'te üretilir; çünkü aynı değer hem bu satırın kendi
       OrderUid'ine HEM DE seçilen etiketlerin "OK" (OrderKey) alanına
       yazılmalı - SambaPOS'un kendi OrderTagValue.cs kaynağındaki şekil bu. */
    const orderUid = crypto.randomUUID();
    const selectedTags = Array.isArray(item.tags) ? item.tags : [];
    const orderTagsJson = selectedTags.length
      ? JSON.stringify(selectedTags.map(t => {
          const v = { TN: String(t.name), TV: String(t.name), UI: userId, OI: Number(t.groupId), OK: orderUid };
          if (t.price) { v.PR = Number(t.price); v.AP = true; }
          return v;
        })).replace(/'/g, "''")
      : '[]';
    orderLinesSql += `
      INSERT INTO Orders (TicketId, WarehouseId, DepartmentId, TerminalId, MenuItemId, MenuItemName, PortionName, Price, Quantity,
        PortionCount, Locked, CalculatePrice, DecreaseInventory, IncreaseInventory, OrderNumber, CreatingUserName,
        CreatedDateTime, LastUpdateDateTime, AccountTransactionTypeId, DisablePortionSelection, OrderUid, Taxes, OrderTags, OrderStates)
        VALUES (@ticketId, 1, 1, 1, ${Number(item.menuItemId)}, N'${sqlEsc(item.name)}', N'${sqlEsc(portionName)}', ${Number(item.price)}, ${Number(item.quantity)},
        1, 0, 1, 1, 0, ${orderNumber}, N'QR Menü',
        GETDATE(), GETDATE(), 3, 0, N'${orderUid}', N'[]', N'${orderTagsJson}', N'${orderStates}');`;
  }

  if (appendedToExisting) {
    /* MASA SİPARİŞİ - masa zaten AÇIK bir adisyona sahipse toplam
       güncellemesi VE yeni sipariş satırları AYNI transaction'da yazılır
       (bu adisyon büyük ihtimalle o an kasiyerin ekranında AÇIK olduğu
       için önceki ayrı-yazım deseni burada özellikle riskliydi). */
    await sqlWide(`SET NOCOUNT ON; SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      DECLARE @ticketId INT = ${ticketId};
      /* TicketVersion de guncellenir (27.09.2026) - SambaPOS terminalinde bu
         adisyon aciksa degisikligi fark edip yeniden yukler; yoksa kendi eski
         toplamini ustune yazabilirdi. Tam saniye: bkz. asagidaki INSERT notu. */
      DECLARE @ver DATETIME = DATEADD(ms, -DATEPART(ms, GETDATE()), GETDATE());
      UPDATE Tickets SET TotalAmount = TotalAmount + ${total}, TotalAmountPreTax = TotalAmountPreTax + ${total},
        RemainingAmount = RemainingAmount + ${total}, LastOrderDate = GETDATE(), LastUpdateTime = GETDATE(), TicketVersion = @ver
        WHERE Id = @ticketId;
      ${orderLinesSql}
      COMMIT TRANSACTION;`);
    console.log(`✅ Mevcut açık adisyona eklendi: Masa ${tableEntity.name} (TicketId: ${ticketId}, No: ${ticketNumber})`);
  } else {
    ticketNumber = await nextNumeratorValue('Adisyon Numaratörü');
    const TICKET_TYPE_ID = orderType === 'table' ? 1 : orderType === 'delivery' ? 2 : 3;

    /* TicketTags */
    const tags = [
      { TN: 'Adres', TT: 0, TV: address || '' },
      { TN: 'Telefon', TT: 0, TV: phone || '' },
      { TN: 'Müşteri Adı', TT: 0, TV: customerName || '' },
      { TN: 'Bölge', TT: 0, TV: zone || '' },
      { TN: 'Sipariş Tipi', TT: 0, TV: orderType }
    ];
    if (tableNumber) tags.push({ TN: 'Masa', TT: 0, TV: String(tableNumber) });
    const ticketTags = JSON.stringify(tags).replace(/'/g, "''");

    /* ============================================================
       TICKET STATES
       Paket Servis ekranında "Bekleyen Siparişler" için gerekli
       ============================================================ */
    /* GERI ALINDI (26.09.2026): "Paket Durumu" state'inin kaldirilmasi
       DENENDI (bir onceki commit), ama bu DAHA KOTU bir regresyona yol acti -
       kiosk siparisi artik Paket Servis ekraninda HIC GORUNMUYORDU (canli
       bulgu: "kiostan sipariş verdim paket servise düşmedi"). Demek ki bu
       state, ekranin "Bekleyen Siparişler" filtresi icin GEREKLI (yokluğunda
       ticket hic listelenmiyor) - sadece "odeme sonrasi hic guncellenmiyor"
       teorisi YANLIŞ/EKSIKTI. Eski haline donduruldu; "adisyon kapanmiyor"
       sorunu HALA gecerliyse kok neden BASKA bir yerde (SambaPOS'un kendi
       Otomasyon/Ekran ayarlarinda, bizim kod disinda) olmali. */
    const stateList = [
      { D: now, S: 'QR Menü', SN: 'Kaynak', SV: '' },
      { D: now, S: 'Ödenmedi', SN: 'Durum', SV: '' }
    ];

    if (orderType === 'delivery') {
      stateList.unshift(
        { D: now, S: 'Paket', SN: 'Paket', SV: '' },
        { D: now, S: 'Bekliyor', SN: 'Paket Durumu', SV: '' }
      );
    } else if (orderType === 'pickup') {
      stateList.unshift(
        { D: now, S: 'Gel-Al', SN: 'Paket', SV: '' },
        { D: now, S: 'Bekliyor', SN: 'Paket Durumu', SV: '' }
      );
    }

    const ticketStates = JSON.stringify(stateList).replace(/'/g, "''");
    const noteEsc = sqlEsc(`${customerName || 'QR Müşteri'} - ${note || 'Servis İstiyorum'}`);

    /* MASA SİPARİŞİ - TicketEntities'e masa bağlantısı ekle (YENİ adisyon)
       tableEntity bu noktada HER ZAMAN doludur (yoksa fonksiyon zaten
       yukarıda hata fırlatıp burayı hiç yapmadan çıkardı). */
    const tableEntitySql = (orderType === 'table' && tableEntity) ? `
      INSERT INTO TicketEntities (Ticket_Id, EntityId, EntityTypeId, EntityName, EntityCustomData, AccountId, AccountTypeId)
        VALUES (@ticketId, ${tableEntity.id}, 2, N'${sqlEsc(tableEntity.name)}', N'[]', 0, 0);` : '';

    /* AccountTransactionDocuments + Tickets + (varsa) masa bağlantısı +
       TÜM sipariş satırları - hepsi TEK atomik transaction. */
    const result = rows(await sqlWide(`SET NOCOUNT ON; SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      DECLARE @docId INT, @ticketId INT;
      /* KOK NEDEN (27.09.2026, canli bulgu: QR adisyonuna paketci secerken
         "Adisyon Paketçi-1'a taşınmış", odeme alirken "Adisyonda bir
         değişiklik yapılmış -exp3"): SambaPOS TicketVersion'u HER ZAMAN tam
         saniye (.000 ms) yazar ve eszamanlilik kontrolunde saniyeye yuvarlanmis
         degerle karsilastirir. GETDATE() milisaniyeli oldugu icin (.487 gibi)
         kontrol HIC eslesmiyor, SambaPOS adisyonu "baskasi degistirmis" sanip
         kaydi reddediyordu. */
      DECLARE @ver DATETIME = DATEADD(ms, -DATEPART(ms, GETDATE()), GETDATE());

      INSERT INTO AccountTransactionDocuments (Date, UserId, UserName, DocumentTypeId, Name)
        VALUES (GETDATE(), ${userId}, N'QR Menü', 0, N'Ticket Transaction [${ticketNumber}]');
      SET @docId = SCOPE_IDENTITY();

      INSERT INTO Tickets (LastUpdateTime, TicketVersion, TicketNumber, Date, LastOrderDate, LastPaymentDate, PreOrder, IsClosed, IsLocked, IsOpened,
        RemainingAmount, TotalAmount, TotalAmountPreTax, DepartmentId, TerminalId, TicketTypeId, Note,
        LastModifiedUserName, CreatedUserName, TicketTags, TicketStates, LineSeparators, ExchangeRate, TaxIncluded, TransactionDocument_Id, TicketUid)
        VALUES (GETDATE(), @ver, ${ticketNumber}, GETDATE(), GETDATE(), GETDATE(), 0, 0, 0, 0,
          ${total}, ${total}, ${total}, 1, 1, ${TICKET_TYPE_ID}, N'${noteEsc}',
          N'QR Menü', N'QR Menü', N'${ticketTags}', N'${ticketStates}', N'[]', 1, 1, @docId, CONVERT(nvarchar(50), NEWID()));
      SET @ticketId = SCOPE_IDENTITY();
      ${tableEntitySql}
      ${orderLinesSql}

      COMMIT TRANSACTION;
      SELECT @ticketId AS id;`), ['id'])[0];
    ticketId = +result.id;

    if (orderType === 'table' && tableEntity) {
      console.log(`✅ Masa bağlandı: ${tableEntity.name} (TicketId: ${ticketId}, EntityId: ${tableEntity.id})`);
    }
  }

  /* ============================================================
     MÜŞTERİ + PAKETÇİ VARLIĞI EKLE (yalnızca YENİ adisyonda)
     ============================================================ */
  if (orderType !== 'table' && !appendedToExisting) {
    /* 1) Müşteri varlığı (EntityTypeId = QR Menü) */
    try {
      const custEntityType = await customerEntityTypeId();
      const custAccountType = await customerAccountTypeId();
      let existingCustomer = await findCustomerEntityId(phoneDigits);
      const customData = JSON.stringify([
        { Name: 'Müşteri Adı', Value: customerName || '' },
        { Name: 'Adres', Value: address || '' },
        { Name: 'Bölge', Value: zone || '' },
        { Name: 'Not', Value: note || '' }
      ]).replace(/'/g, "''");

      /* KOK NEDEN (26.09.2026, kullanici bulgusu: "normal paket serviste
         müşteri sipariş verince sistem onu otomatik varlık olarak
         oluşturuyor, bizim qr menüde öyle bir olay yok" - iyice
         arastirildi): musteri bulunamayinca eskiden TicketEntities'e
         EntityId=0 (Entities tablosunda KARSILIGI OLMAYAN, SAHTE bir
         referans) yaziliyordu - musteri GERCEKTEN hicbir zaman SambaPOS'un
         kendi Entities/Accounts tablolarina eklenmiyordu. Native siparis
         girisi ise HER ZAMAN gercek bir Account + Entity cifti olusturur
         (dogrulandi: ornek native musteri Id=44, Account Id=8, Account adi
         "[Isim]-[Telefon]" sablonuyla). "Paket Servis" bir Entity Screen'dir
         (EntityScreens.EntityTypeId=1) - byuk ihtimalle gercek bir Entity'ye
         bagli native izleme/durum mekanizmalarini kullaniyor, EntityId=0
         ile bunlarin hicbiri calismiyordu. Artik biz de native ile AYNI
         sekilde GERCEK bir Account+Entity cifti olusturuyoruz. */
      if (!existingCustomer) {
        const accountName = sqlEsc(`${customerName || phoneDigits || 'Müşteri'}-${phoneDigits || ''}`);
        const accResult = rows(await sqlWide(`SET NOCOUNT ON;
          INSERT INTO Accounts (AccountTypeId, ForeignCurrencyId, Name) VALUES (${custAccountType}, 0, N'${accountName}');
          SELECT SCOPE_IDENTITY() AS id;`), ['id'])[0];
        const newAccountId = +accResult.id;

        const entResult = rows(await sqlWide(`SET NOCOUNT ON;
          INSERT INTO Entities (EntityTypeId, LastUpdateTime, CustomData, AccountId, WarehouseId, Name)
            VALUES (${custEntityType}, GETDATE(), N'${customData}', ${newAccountId}, 0, N'${sqlEsc(phoneDigits || customerName || 'Müşteri')}');
          SELECT SCOPE_IDENTITY() AS id;`), ['id'])[0];
        existingCustomer = { id: +entResult.id, accountId: newAccountId };
        console.log(`✅ Yeni müşteri varlığı oluşturuldu: ${customerName || phoneDigits} (EntityId: ${existingCustomer.id}, AccountId: ${newAccountId})`);
      }

      await sqlWide(`SET NOCOUNT ON;
        INSERT INTO TicketEntities (Ticket_Id, EntityId, EntityTypeId, EntityName, EntityCustomData, AccountId, AccountTypeId)
          VALUES (${ticketId}, ${existingCustomer.id}, ${custEntityType}, N'${sqlEsc(phoneDigits || customerName || 'Müşteri')}', N'${customData}', ${existingCustomer.accountId}, ${custAccountType});`);
      console.log(`✅ Müşteri bağlandı: ${customerName || phoneDigits}`);
    } catch (e) {
      console.error('❌ Müşteri bağlama hatası:', e.message);
    }

    /* GERI ALINDI (26.09.2026, canli bulgu): burada bir "varsayilan Paketçi"
       (findDefaultPaketci()) otomatik olarak HER adisyona SQL ile dogrudan
       ekleniyordu. Bu, adisyonu OLUSTURULDUGU ANDAN ITIBAREN "Kuryedeki
       Siparişler" listesinde de gosteriyordu - ama "Bekleyen Siparişler"den
       hic CIKMIYORDU, cunku kasiyer/personel SambaPOS'un KENDI "Paketçi Seç"
       ekranindan hicbir zaman GERCEKTEN atama YAPMAMIS oluyordu (biz zaten
       SQL ile atamistik) - dolayisiyla SambaPOS'un bu atama ANINDA tetikledigi
       kendi otomasyonu (orn. "Paket Durumu" state'ini guncelleme) hic
       CALISMIYORDU. Kullanici bulgusu: "direk paketçiye atanınca bekleyen
       kısımdan çıkıp kurye bölümüne geçsin" - yani atama SambaPOS'un KENDI
       ekranindan, MANUEL olarak yapilmali ki kendi otomasyonu dogru calissin.
       Artik adisyon PAKETÇİSİZ olusturuluyor - sadece "Bekleyen Siparişler"de
       görünür; personel SambaPOS'tan kuryeyi atayinca (kendi native akisi)
       "Kuryedeki Siparişler"e GECER (Bekleyen'den CIKAR). */
  }

  return { ticketId, ticketNumber, total, type: orderType, tableNumber, appendedToExisting };
}

/* ============================================================
   "PAKET DURUMU" SENKRONİZASYONU
   KOK NEDEN (26.09.2026, canli bulgu ve SQL ile dogrulandi): odeme SambaPOS'un
   kendi ekranindan alinip adisyon gercekten kapaninca (IsClosed=1), SambaPOS
   kendi otomasyonuyla "Paket"→"Teslim Edildi" ve "Durum"→"Ödendi" state'lerini
   DOGRU sekilde guncelliyor - ama "Paket Durumu" (Bekleyen Siparişler ekraninin
   ihtiyac duydugu, GORUNURLUK icin GEREKLI olan state - kaldirilinca adisyon
   ekranda HIC GORUNMEDI, canli test edildi) hicbir zaman guncellenmiyor,
   HER ZAMAN "Bekliyor" degerinde kaliyor. SambaPOS'un kendi Otomasyon
   Komutlari'nin bu OZEL state adini taniyip guncelleyecek bir kurali yok
   (bu state bizim kodumuzun kendi icat ettigi bir isim). Bizim tarafimizdan
   dogrudan bir "odeme alindi" bildirimi/webhook'u da YOK. Cozum: adisyon
   zaten IsClosed=1 olduysa (yani odeme kesin alindi), "Paket Durumu"nu da
   BIZ senkronize ediyoruz - server.js'ten periyodik (20-30 saniyede bir)
   cagrilir. Sadece BIZIM olusturdugumuz (CreatedUserName='QR Menü') ve HALA
   "Bekliyor" durumunda takili kalan KAPALI adisyonlari hedefler. */
async function syncClosedPaketDurumu() {
  const OLD = '"S":"Bekliyor","SN":"Paket Durumu"';
  const NEW = '"S":"Teslim Edildi","SN":"Paket Durumu"';
  /* Tickets tablosunda trigger'lar var (Tickets_*_trigger, 2022); SQL Server
     trigger'li tabloda INTO'suz OUTPUT'a izin vermiyor (Msg 334). Bu yuzden
     OUTPUT once tablo degiskenine yaziliyor (27.09.2026). */
  const result = await sqlWide(`SET NOCOUNT ON;
    DECLARE @guncellenen TABLE (Id int);
    UPDATE Tickets SET TicketStates = REPLACE(TicketStates, N'${OLD}', N'${NEW}')
      OUTPUT INSERTED.Id INTO @guncellenen
      WHERE CreatedUserName = N'QR Menü' AND IsClosed = 1 AND TicketStates LIKE N'%${OLD}%';
    SELECT Id FROM @guncellenen;`);
  const updated = rows(result, ['id']);
  if (updated.length) console.log(`✅ Paket Durumu senkronize edildi: ${updated.length} adisyon (${updated.map(r => r.id).join(', ')})`);
  return updated.length;
}

/* ============================================================
   ADİSYONU SİL (SambaPOS'tan)
   Kullanıcı isteği/tekrar eden sorun: SambaPOS'un kendi arayüzünde bir
   siparişi "iptal" etmek sadece Orders satırlarını "İPTAL EDİLDİ" olarak
   işaretler/tutarı sıfırlar, adisyon BAŞLIĞI (Tickets satırı) silinmez -
   admin panelden GÖNDERİLMİŞ bir siparişi tamamen kaldırmak için bu
   fonksiyon Orders/TicketEntities/Tickets/AccountTransactionDocuments
   satırlarını KALICI olarak siler.
   ============================================================ */
async function deleteTicketByNumber(ticketNumber) {
  const found = rows(await sqlWide(`SET NOCOUNT ON; SELECT TOP 1 Id, TransactionDocument_Id FROM Tickets WHERE TicketNumber = ${Number(ticketNumber)};`), ['id', 'docId'])[0];
  if (!found) throw new Error(`Adisyon No ${ticketNumber} SambaPOS'ta bulunamadı (zaten silinmiş olabilir).`);
  const ticketId = +found.id, docId = +found.docId;
  await sqlWide(`SET NOCOUNT ON;
    DELETE FROM Orders WHERE TicketId = ${ticketId};
    DELETE FROM TicketEntities WHERE Ticket_Id = ${ticketId};
    DELETE FROM Tickets WHERE Id = ${ticketId};
    ${docId ? `DELETE FROM AccountTransactionDocuments WHERE Id = ${docId};` : ''}`);
  return { ticketId };
}

module.exports = { liveMenu, liveScreenMenus, adminValidByPin, checkPin, createOrder, liveTables, findTableByName, findDefaultPaketci, findOpenTableTicket, deleteTicketByNumber, getKitchenPrinterRouting, getTableOrderSummary, terminalConfigOptions, syncClosedPaketDurumu, getOrderTagGroups };