# QR Menü – Kurulum Paketine Aktarma (Devir Notu)

**Kime:** QR Menü kurulum programını (exe) yeniden derleyip bu değişiklikleri **tüm müşterilere** dağıtacak geliştirici / Claude.
**Kaynak:** Öz Urfa Yusuf Usta kurulumu, `C:\Program Files (x86)\AlfaPOS\QRMenu`, 27.09.2026.
**Klasörler:**
- **`QRMenu\dosyalar\`:** son hal.
- **`QRMenu\onceki_haller\`:** değişiklik öncesi.
- **`QRMenu\farklar\`:** unified diff.
- **Hata ve özellik ayrıntısı:** `QRMenu\DEGISIKLIKLER.md`.

---

## 1. Hangi dosya nasıl aktarılmalı

| Dosya | Aktarım | Not |
|---|---|---|
| `server.js` | **Dosyanın tamamı** | Restorana özel veri yok. |
| `sambapos.js` | **Dosyanın tamamı** | Restorana özel veri yok. |
| `yeni.html` | **Dosyanın tamamı (yeni dosya)** | Firma bilgisini `/api/site-info`'dan okur. HTML'deki "Öz Urfa" metinleri yalnızca yedek değer. |
| `tv.html` | **Dosyanın tamamı** | Aynı yöntem (`/api/site-info`). |
| `siparis.html` | **Dosyanın tamamı** | Kiosk ve düzen değişiklikleri; kiosk firma adı `/api/site-info`'dan geliyor. |
| `admin/index.html` | **Dosyanın tamamı** | Kiosk onay anahtarı, "görseli olmayanlar" filtresi. |
| `iletisim.html`, `garson.html` | **Dosyanın tamamı** | Sadece logo yolu ve logo görünümü. |
| `index.html` | ⚠ **Dosya olarak KOPYALAMAYIN; farkı yamayın** | Bu dosyadaki menü bölümü **Öz Urfa'nın ürünleri ve fiyatlarıyla** yeniden üretildi. Kurulumdaki şablon `index.html`'e yalnızca aşağıdaki kod parçalarını ekleyin. |

`index.html`'e eklenecek kod parçaları (`farklar\index.html.diff`):
1. `<head>` başında slug'a `/` ekleyen yönlendirme betiği (`location.pathname + '/'`).
2. `</head>` öncesindeki `ANA SAYFA DUZENI` `<style>` bloğu ve geniş ekrandaki `html{height:100%;overflow:hidden}` kuralı.
3. `buildHomeGrid()` içinde, fotoğraflı ilk ürüne kadar sıradakileri deneyen kod (`srcs` dizisi, `img.onerror` zinciri).
4. Başlık logosunda `onerror="this.remove()"` ve beyaz plaka stili.

Menü içeriği kurulumda değil, her müşteride panelden ("Menüyü yeniden oluştur") SambaPOS'tan üretilmeli.

## 2. Kurulumda / güncellemede dikkat
- **`config.json`:** Kurulum **üzerine yazmamalı**. 27.09 sabahı kurulum şunları sildi:
  - aktivasyon anahtarı,
  - firma ayarları,
  - teslimat bölgeleri,
  - mutfak yazıcısı,
  - kampanyalar.
  Yalnızca eksik anahtarlar eklenmeli (merge).
- **Yeni config anahtarı:** `kioskDirectOrderSend`. Yoksa `true` sayılır; varsayılan eklemeye gerek yok.
- **Yedekler ve dosyalar:** Kurulum `*.bak*` yedekleri, yüklenen ürün görsellerini, `logo.png`/`logo.jpg`'yi, `kampanya-*.jpg`'yi ve `orders.json`'ı silmemeli.
- **Config yazımı:** Atomik olmalı (geçici dosya + rename). Yarım yazılmış `config.json` servisi açılışta çökertti.
- **Harici bağımlılıklar:**
  - `tv.html`: Google Fonts ve `cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0`.
  - `yeni.html`: harici bağımlılık yok.

## 3. Yeni ve değişen uç noktalar (`server.js`)
| Uç nokta | Açıklama |
|---|---|
| `GET /api/site-info` | **Yeni, herkese açık.** Firma adı, slogan, telefon, adres, WhatsApp, sosyal medya, googleMaps, website, çalışma saati, tema. SQL/anahtar bilgisi **yok**. |
| `GET /api/menu-link` | **Yeni, herkese açık.** `{ menuBaseUrl }`, tünelden öğrenilen `menu.ornek-alanadi.com/<slug>`. |
| `GET/POST /api/admin/order-mode` | Artık `kioskDirectOrderSend`'i de döndürüyor. POST yalnızca gönderilen anahtarı yazıyor. |
| `serveStatic` yolları | `/` ve `/index` → `yeni.html`; `/eski` → `index.html`; `/yeni` → `yeni.html`. |
| `serveStatic` logo yedeği | `/logo.(png\|jpg\|jpeg)` istenip dosya yoksa mevcut logo veriliyor. |
| `renderSiteHtml` listesi | `yeni.html` eklendi. |
| `saveLogo` | Logo yolunu `yeni.html`, `tv.html`, `garson.html` ve `iletisim.html`'de de güncelliyor. |
| `/api/order` | Kiosk koşulu: `isKioskOrder && readKioskDirectSend()`. |

`sambapos.js` değişiklikleri (DEGISIKLIKLER.md 1.1–1.2):
- `TicketVersion` tam saniye yazılıyor.
- Açık masa adisyonuna ürün eklenirken `TicketVersion` güncelleniyor.
- `syncClosedPaketDurumu`: `OUTPUT … INTO @tablo`.

## 4. Temalar
- **Tema seçenekleri:** `THEME_PRESETS` (server.js) içinde mavi, kirmizi, yesil, turuncu, mor, lacivert ve bordo var. Panelden seçilen tema `siteSettings.theme`'e yazılıyor; bu kurulumda şu an **kirmizi**.
- **Nasıl uygulanıyor:** `renderSiteHtml`, sayfalardaki `--brand:#3498db;` (açık) ve `--brand:#007acc;` (koyu) değerlerini tema rengiyle değiştiriyor. Yeni sayfalarda bu satırlar **olduğu gibi korunmalı**.
- **Sayfalara etkisi:**
  - **`yeni.html`:** Başlık, butonlar, aktif kategori ve alt bilgi temadan alıyor. Gece modu kendi koyu paletini kullanıyor; tercih `localStorage.theme`'de saklanıyor ve `index.html` ile ortak.
  - **`siparis.html` / kiosk:** Temadan alıyor. Kiosk vurgu rengi altın (`--gold`).
  - **`tv.html`:** Tema renginden bağımsız, sabit sıcak koyu palet (siyah, altın, köz). Bilinçli bir seçim.
- **Test edilen temalar:** mavi, lacivert ve kirmizi (ekran görüntüleriyle).

## 5. Bu kurulumdaki TÜM özellikler (envanter)
**Müşteri tarafı**
- **Ana sayfa (`yeni.html`):**
  - Kampanya slider'ı; "Sepete Ekle" `campaigns[].items`'ı doğrudan sepete koyuyor.
  - Durum kartları, arama, fotoğraflı kategori kartları.
  - Kategori ekranı: telefonda üst çubuk + alt sepet; PC'de sol liste, ürünler ve sağ sepet.
  - Porsiyon/adet penceresi, gece modu.
- **Eski ana sayfa:** `/eski`.
- **Sipariş sayfası (`/siparis`):**
  - Paket servis: bölge, adres, konum paylaşımıyla mesafe ücreti.
  - Masa QR (`?masa=`): masanın açık adisyonu ve garson çağırma.
  - Gel-al.
  - WhatsApp ile gönderme (ayara bağlı).
  - Upsell önerileri.
  - Kampanya (`?promo=`).
  - Çalışma saati ve sipariş kabul (açık/kapalı) kontrolü.
- **Kiosk (`/siparis?kiosk=1`, panelden açılıp kapanıyor):**
  - Karşılama ekranı ve "Burada / Paket" seçimi (sipariş notuna yazılıyor).
  - Büyük kartlar, sabit sepet; yatay ve dikey ekran desteği.
  - Hareketsizlikte geri sayım, büyük sipariş numarası.
  - Onay: doğrudan gönder ya da panele düşür (ayar).
- **TV menü (`/tv`, panelden açılıp kapanıyor):**
  - Vitrin ve fiyat panosu sayfaları.
  - Menü QR'ı, saat, telefon.
  - YouTube fon müziği (panelden).
- **Diğer sayfalar:** İletişim, gizlilik, garson paneli (`/garson`: e-posta + yönetici PIN'i; SambaPOS terminali LAN'a kısıtlı).

**Yönetim paneli (`/admin`, iki adımlı giriş: bulut e-posta/şifre + SambaPOS yönetici PIN'i)**
- **Siparişler:** Onay, ret, geçmiş, adisyon silme, canlı bildirim.
- **Menü:** SambaPOS'tan canlı liste, "Görseli olmayanlar" filtresi, görsel yükleme, ürün düzenleme/silme/sıralama, eksik ürünleri ekleme, fiyat farkları, menüyü yeniden oluşturma, SambaPOS ekran menüsü seçimi.
- **Kategoriler:** Ad değiştirme, silme, sıralama, aktif/pasif.
- **Satış araçları:** Kampanyalar (görsel + ürün bağlama), upsell kuralları ve istatistikleri.
- **Masa ve garson:** Masalar, garson çağrıları.
- **Sayfa düzenleyici** (kiosk dahil) ve yapay zekâ sekmesi.
- **Ayarlar:**
  - firma bilgileri ve tema, logo,
  - veritabanı,
  - sipariş gönderme (QR/paket + **kiosk ayrı**),
  - sipariş kabul (paket/masa/gel-al),
  - teslimat bölgeleri ve mesafe kademeleri,
  - mutfak yazıcısı ve kategori yönlendirme,
  - uzaktan garson,
  - kiosk/TV açma-kapama, TV müziği,
  - menü adresi (slug).

**Arka plan**
- Bulut tüneli (menu.ornek-alanadi.com/<slug>, app.ornek-alanadi.com/qrmenu), lisans kontrolü.
- Otomatik "Paket Durumu" senkronu (her 20 sn).
- Mutfak yazdırma, masaüstü bildirimi.

## 6. Test listesi (derlemeden sonra)
1. **Temiz kurulum:** Ayarlar boşken `/` açılmalı. Öz Urfa'nın telefonu ya da sosyal medyası **görünmemeli**; firma adı "Menü", amblem "M" olmalı; telefon ve sosyal medya ikonları gizli olmalı.
2. **`/api/site-info` ve `/api/menu-link`:** 200 dönmeli. `/api/site-info` şifre ya da anahtar içermemeli.
3. **Slug:** `menu.ornek-alanadi.com/<slug>` sonunda `/` olmadan açılınca `/<slug>/`'a yönlenmeli; "Sipariş Ver" çalışmalı.
4. **Paketçi/ödeme:** QR ile paket siparişi ver, SambaPOS'ta paketçi ata ve ödeme al. "taşınmış" / "-exp3" hatası **çıkmamalı**. Kapanan adisyonun Paket Durumu "Teslim Edildi" olmalı.
5. **Trigger'lı veritabanı:** `server.err.log`'da `Msg 334` olmamalı.
6. **Kiosk:** Kiosk onay kutusu kapalıyken sipariş onay listesine düşmeli; açıkken doğrudan SambaPOS'a gitmeli. Not "KIOSK - …" ile başlamalı.
7. **Logo:** PNG ve JPG logo yükle; `/`, `/tv`, `/siparis?kiosk=1` ve `/iletisim`'de görünmeli. Geniş logo kırpılmamalı.
8. **Tema:** Temayı değiştir; `/`, `/siparis` ve kiosk rengi değişmeli.
9. **Görsel filtresi:** Admin > Menü > "Sadece görseli olmayanlar" doğru sayıyı vermeli; görsel yükleyince liste güncellenmeli.
10. **Güncelleme kurulumu:** Mevcut `config.json`, görseller, logo ve kampanya görselleri korunmalı.

## 7. Bilinen açık konular
- **QR müşteri kaydı:** QR müşterisi SambaPOS'a ayrı bir varlık tipinde (25) ve cari hesapla yazılıyor. Native paket akışı "Müşteriler" tipini (1) cari hesap olmadan kullanıyor; gerekirse hizalanmalı.
- **Eski menü adresi:** Slug değişince eski adres 404 veriyor; eskiden yeniye yönlendirme önerilir. Bu düzeltme bulut tarafında (app.ornek-alanadi.com), bu pakette değil.
- **`index.html` (`/eski`) varsayılan değerleri:** Hâlâ HTML'deki örnek değerlere dayanıyor (eski davranış). Ayarı boş müşteride Öz Urfa bilgileri görünebilir; `yeni.html` bu sorunu çözüyor.
- **Kampanya fiyatı:** Kampanyada gösterilen fiyat (`newPrice`) yalnızca görsel. Sepete ürünün SambaPOS fiyatı ekleniyor; kampanya ürününün SambaPOS fiyatı doğru girilmeli.
