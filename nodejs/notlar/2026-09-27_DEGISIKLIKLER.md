# QR Menü – 27.09.2026 Değişiklikleri

Kurulum: `C:\Program Files (x86)\AlfaPOS\QRMenu` (servis: AlfaPOSQRMenuYerel), SambaPOS 5 / SQL Server 2017.

Bu paket yalnızca bu tarihte yapılan değişiklikleri içerir:
- **`dosyalar/`:** Değişen dosyaların son hali.
- **`farklar/`:** Kurulumdaki önceki hallerine göre farklar (unified diff).

`config.json` bilerek konmadı; içinde şifre ve anahtar var. Yeni ayar anahtarları aşağıda listeleniyor.

> Not: Kurulum programı (unins/setup) klasörü baştan yazıyor. Bu değişiklikler kaynak koda işlenmezse bir sonraki kurulumda kaybolur.

## 1. Hata düzeltmeleri

### 1.1 Paketçi atama / ödeme alırken hata (`sambapos.js`)
- **Belirti:** QR adisyonunda paketçi seçince "Adisyon Paketçi-1'a taşınmış" hatası, ödeme alırken "Adisyonda bir değişiklik yapılmış. -exp3" hatası çıkıyor.
- **Neden:** `Tickets.TicketVersion` alanı `GETDATE()` ile milisaniyeli yazılıyordu. SambaPOS bu alanı hep tam saniye (`.000`) yazıyor ve eşzamanlılık kontrolü hiç eşleşmiyor.
- **Düzeltme:** Yeni adisyonda `@ver = DATEADD(ms,-DATEPART(ms,GETDATE()),GETDATE())` kullanılıyor. Açık masa adisyonuna ürün eklenirken de `TicketVersion = @ver` güncelleniyor.

### 1.2 "Paket Durumu" senkronu hiç çalışmıyordu (`sambapos.js` → `syncClosedPaketDurumu`)
- **Hata:** Her 20 sn'de `Msg 334`: "cannot have any enabled triggers if the statement contains an OUTPUT clause without INTO".
- **Neden:** `Tickets` tablosunda trigger'lar var (`Tickets_*_trigger`).
- **Düzeltme:** `OUTPUT INSERTED.Id INTO @guncellenen` ile tablo değişkenine yazılıp oradan `SELECT` ediliyor.

### 1.3 Menü linki slug'sız açılınca "Bulunamadı" / görseller yok (`index.html`, `yeni.html`)
- **Neden:** `menu.ornek-alanadi.com/<slug>` sonunda `/` olmadan açılınca göreli yollar (`./siparis`, `./x.jpg`) slug'ı kaybediyor.
- **Düzeltme:** `<head>` başında sonuna `/` ekleyip yeniden yönlendiren bir betik var. TV QR'ı da `/` ile biten adres üretiyor.

### 1.4 Kurulumla gelen eski `index.html`
- **Sorun:** Tüm ürün görselleri `./logo.jpg`, fiyatlar eskiydi.
- **Düzeltme:** Menü, paneldeki "Menüyü yeniden oluştur" ile aynı kod yolu (`menuEditor.regenerateFullMenu`) kullanılarak SambaPOS'tan yeniden oluşturuldu.

### 1.5 `siparis.html` "Sepeti Temizle"
- **Sorun:** Olmayan `renderCartBar()` / `renderProducts()` fonksiyonları çağrılıyordu.
- **Düzeltme:** `updateCartBar()` / `renderList()` çağrılıyor.

### 1.6 `config.json` bozulması
- **Sorun:** Dosyanın sonundaki `}` eksikti ve servis açılışta çöküyordu.
- **Öneri:** Config yazımlarının atomik yapılması (geçici dosya + rename).

## 2. Yeni özellikler

### 2.1 Yeni müşteri arayüzü – `yeni.html` (yeni dosya)
- **Adresler:** `/` ve `/index` artık `yeni.html`'i açıyor, eski sayfa `/eski` altında (`server.js` → `serveStatic` map).
- **Veri kaynakları:** `/api/menu`, `/api/campaigns`, `/api/delivery-zones`. Statik menü HTML'ine bağımlı değil.
- **Ana ekran:** Kampanya slider'ı; kampanya butonu `campaigns[].items`'taki ürünleri doğrudan sepete ekliyor. Altında durum kartları (paket servis / yol tarifi / çalışma saati), arama ve fotoğraflı kategori kartları var.
- **Kategori ekranı (`#k/<kategori>`):**
  - Telefonda üstte kategori çubuğu, altta sepet çubuğu.
  - PC'de sol kategori listesi, orta ürün ızgarası, sağda sabit sepet paneli.
- **Sepet:** `siparis.html` ile aynı `localStorage` anahtarını (`ultra_cart_paket`) kullanıyor. "Siparişi Tamamla" → `./siparis#sepet`; `siparis.html` bu hash ile sepeti doğrudan açıyor.
- **Logo:** `logo.jpg` yoksa firma adının baş harflerinden bir amblem gösteriliyor.
- **`server.js`:** `yeni.html` `renderSiteHtml` listesine eklendi (firma adı / telefon / sosyal medya / tema rengi ayarlardan gelir).

### 2.2 Kiosk yeniden tasarımı (`siparis.html?kiosk=1`)
Tüm CSS `body.kiosk-mode` altında; normal mobil sipariş sayfası etkilenmiyor.
- **Karşılama ekranı:** Ürün fotoğrafları slayt olarak geçiyor, müşteri "Burada Yiyeceğim" / "Paket Alacağım" seçiyor. Seçim sipariş notunun başına `KIOSK - BURADA YENECEK` / `KIOSK - PAKET` olarak yazılıyor.
- **Yatay ekran:** Solda fotoğraflı kategoriler, ortada ürün kartları, sağda sabit sepet.
- **Dikey ekran:** Kategoriler üstte, sepet çubuğu altta.
- **Ekrandaki diğer öğeler:** Porsiyon ve onay pencereleri ortada açılıyor. 60 sn hareketsizlikte 15 sn'lik "Hâlâ orada mısınız?" geri sayımı çıkıyor. Sipariş verilince büyük sipariş numarası gösteriliyor.

### 2.3 Kiosk için ayrı onay ayarı (`server.js`, `admin/index.html`)
- **Yeni config anahtarı:** `kioskDirectOrderSend` (boolean). Yoksa `true` sayılıyor; bu eski davranış.
- **`/api/admin/order-mode`:** GET her iki anahtarı döndürüyor. POST yalnızca gönderilen anahtarı yazıyor, diğerini ezmiyor.
- **Sipariş gönderme koşulu:** `readDirectOrderSend() || isAuthed(req) || (isKioskOrder && readKioskDirectSend())`.

### 2.4 TV menü yeniden tasarımı (`tv.html`)
- **İki sayfa tipi:** "Vitrin" (1 büyük + 4 fotoğraflı ürün) ve "Fiyat panosu" (fotoğrafsız ürünler kategoriye göre, yanında bir öneri paneli).
- **Alt bant:** Menüye giden gerçek QR kodu (qrcodejs, cdnjs) ve telefon.
- **Temizlik:** Ürün adındaki kaçış metinleri (`\r` gibi) temizleniyor. Fiyatı 0 olan ürünlerde en düşük porsiyon fiyatı gösteriliyor, o da yoksa fiyat gizleniyor.
- **Kurulum yardımı:** `/tv#sayfa=N` ile istenen sayfadan başlıyor.
- **Yeni herkese açık uç nokta:** `GET /api/menu-link` → `{ menuBaseUrl }`. Yalnızca tünelden öğrenilen menü adresini döndürüyor.

### 2.5 Admin – görseli olmayan ürünler (`admin/index.html`)
- **Filtre:** Menü listesine "Sadece görseli olmayanlar (N)" filtresi eklendi.
- **İşaretleme:** Görseli olmayan ürünlerde kırmızı "Görsel yok" etiketi var.
- **Yenileme:** Görsel yüklenince liste kendiliğinden yenileniyor.

### 2.6 Eski ana sayfa (`index.html`) düzenlemeleri – artık `/eski` altında
- **Masaüstü taşması:** Kartlar dışarı taşıyordu (body overflow pencereye aktarılıyordu). Geniş ekranda tam genişlik düzenine geçildi.
- **Kategori kartı görseli:** Fotoğrafı olan ilk ürüne kadar sıradakiler deneniyor.
- **Logo:** `logo.jpg` yoksa kırık resim simgesi gizleniyor.

## 3. Veritabanında yapılanlar (bilgi amaçlı)
- **Açık QR adisyonları:** `TicketVersion` alanları tam saniyeye yuvarlandı (1 kayıt).
- **Kampanyalar:** config `campaigns[].items` dolduruldu ("10'lu Kıymalı Cantık Menü", "10'lu Lahmacun Menü").
- **Yeni config anahtarı:** `kioskDirectOrderSend: true`.

## 4. Sonradan eklenenler

### 4.1 Logo yükleme (`server.js` → `saveLogo`, `serveStatic`)
- **Sorun:** PNG yüklenince `logo.png` yazılıp `logo.jpg` siliniyor. HTML'deki yol ise yalnızca `index.html` ve `siparis.html`'de güncelleniyordu. `yeni.html`, `tv.html`, `garson.html` ve `iletisim.html` kırık kalıyordu.
- **Düzeltme:**
  - Bu 4 dosya `saveLogo`'nun güncelleme listesine eklendi.
  - `serveStatic`'te `/logo.(png|jpg|jpeg)` istenip dosya yoksa, mevcut olan logo dosyası veriliyor.
- **Görünüm:** Yatay logolar her sayfada `object-fit:contain` ve beyaz plaka ile gösteriliyor, kırpılmıyor. `yeni.html` en-boy oranı 1.6'dan büyük olan logoya `.wide` sınıfını ekliyor.

### 4.2 Firma bilgisi `/api/site-info` (tüm müşteriler için)
- **Sorun:** `yeni.html`, `tv.html` ve kiosk; telefon, sosyal medya ve firma adını HTML'deki örnek değerlerden (Öz Urfa) alıyordu. `renderSiteHtml` bu değerleri yalnızca ayar doluysa değiştiriyor. Bu yüzden ayarı boş bir müşteride başka restoranın bilgileri görünürdü.
- **Düzeltme:** Herkese açık `GET /api/site-info` eklendi; sayfalar bilgiyi buradan okuyor. Boş olan bilgi gizleniyor.
- **Uyumluluk:** Uç nokta yoksa (eski sunucu) sayfalar eski yönteme geri dönüyor.

## 5. Paketteki dosyalar
| Dosya | Durum |
|---|---|
| server.js | değişti |
| sambapos.js | değişti |
| siparis.html | değişti (kiosk + düzen) |
| index.html | değişti (artık `/eski`) |
| tv.html | yeniden tasarlandı |
| yeni.html | **yeni dosya** (ana sayfa) |
| admin/index.html | değişti |
| iletisim.html | logo yolu ve logo görünümü |
| garson.html | logo (favicon) yolu |

`farklar/` klasöründe her dosya için önceki haline göre fark dosyası var. `yeni.html` baştan yazıldığı için onun farkı tüm dosyayı içeriyor.
