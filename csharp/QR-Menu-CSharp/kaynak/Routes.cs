using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace QRMenu
{
    public static partial class App
    {
        static readonly Dictionary<string, string> WaiterCallTypes = new Dictionary<string, string> {
            { "garson", "Garson çağırıyor" }, { "hesap", "Hesap istiyor" }, { "su", "Su istiyor" }, { "ekstra", "Ekstra servis istiyor" } };
        static readonly HashSet<string> EditablePages = new HashSet<string> { "index.html", "siparis.html", "garson.html", "iletisim.html", "gizlilik-politikasi.html", "admin/index.html", "tv.html" };
        static readonly string[] EditablePagesOrder = { "index.html", "siparis.html", "garson.html", "iletisim.html", "gizlilik-politikasi.html", "admin/index.html", "tv.html" };
        static string PageAlias(string n) { return n == "kiosk" ? "siparis.html" : n; }

        static Dictionary<string, object> Err(string m) { return J.Obj("error", m); }
        static readonly Dictionary<string, object> NeedLogin = J.Obj("error", "Giriş gerekli.");

        public static void Handle(Req req, Res res)
        {
            try
            {
                res.SetHeader("X-Content-Type-Options", "nosniff");
                res.SetHeader("X-Frame-Options", "DENY");
                res.SetHeader("Referrer-Policy", "no-referrer");
                Route(req, res);
            }
            catch (Exception ex)
            {
                Log.Write("HATA " + req.Method + " " + req.Path + ": " + ex.Message);
                res.Headers.Clear(); res.Body.SetLength(0); res.Streamer = null;
                res.Json(500, Err(ex.Message));
            }
        }

        static void Route(Req req, Res res)
        {
            string path = req.Path, m = req.Method;
            bool GET = m == "GET", POST = m == "POST";

            if (!License.IsLicensed)
            {
                if (path.StartsWith("/api/")) { res.Json(402, Err(License.Error ?? "Lisansınız aktif değil.")); return; }
                res.Html(200, "<!doctype html><html lang=\"tr\"><meta charset=\"utf-8\"><title>Lisans Gerekli</title>" +
                    "<body style=\"font-family:system-ui;max-width:520px;margin:60px auto;padding:0 20px;text-align:center;color:#333\">" +
                    "<h2>🔒 Lisansınız Aktif Değil</h2><p>" + HtmlEscape(License.Error ?? "Lisans doğrulanamadı.") + "</p><p>Devam etmek için AlfaPOS ile iletişime geçin.</p></body></html>");
                return;
            }

            if (path == "/garson.apk")
            {
                string f = P("garson-app.apk");
                if (!File.Exists(f)) { res.Json(404, Err("Bulunamadı")); return; }
                res.SetHeader("Content-Disposition", "attachment; filename=\"AlfaPOS-Garson.apk\"");
                res.Send(200, "application/vnd.android.package-archive", File.ReadAllBytes(f), "no-store");
                return;
            }

            // ---------------- herkese acik uclar
            if (path == "/api/campaigns" && GET) { res.Json(200, J.Obj("campaigns", St.Campaigns)); return; }
            if (path == "/api/delivery-zones" && GET)
            {
                var ds = St.Delivery; var site = St.SiteSettings;
                res.Json(200, J.Obj("zones", St.DeliveryZones, "locationEnabled", ds.HasLocation, "locationRequired", ds.LocationRequired,
                    "whatsapp", St.WhatsappOrderEnabled ? St.WaNumber(J.S(site, "whatsapp")) : "", "workingHours", J.S(site, "workingHours")));
                return;
            }
            if (path == "/api/tv-extras" && GET)
            {
                var x = St.TvExtras; var pool = St.ReviewPool();
                x["reviews"] = J.Assign(new Dictionary<string, object>(J.DD(x["reviews"])), J.Obj("rating", pool["rating"], "count", pool["count"], "source", pool["source"], "items", pool["items"]));
                var notes = J.DD(x["notes"]); var ni = J.LL(notes["items"]);
                if (J.IsTrue(notes, "enabled") && ni.Count > 0)
                {
                    int per = Math.Min(3, ni.Count);
                    long slot = J.NowMs() / (long)(J.Num(notes, "intervalHours") * 3600000);
                    long start = (slot * per) % ni.Count;
                    x["notes"] = J.Obj("enabled", true, "current", Enumerable.Range(0, per).Select(i => ni[(int)((start + i) % ni.Count)]).ToList());
                }
                else x["notes"] = J.Obj("enabled", false, "current", new List<object>());
                var ez = J.DD(x["ezan"]);
                bool ezOn = J.IsTrue(ez, "enabled");
                x["ezan"] = J.Obj("enabled", ezOn && J.S(ez, "city").Length > 0, "city", ez["city"], "minutes", ez["minutes"], "times", ezOn ? St.EzanTimesToday() : new List<object>());
                res.Json(200, x);
                return;
            }
            if (path == "/api/reviews" && GET)
            {
                var x = St.TvExtras; var p = St.ReviewPool(); var g = St.GoogleCfg;
                res.Json(200, J.Obj("enabled", J.IsTrue(J.DD(x["reviews"]), "enabled") && J.IsTrue(g, "menuEnabled") && J.LL(p["items"]).Count > 0,
                    "rating", p["rating"], "count", p["count"], "source", p["source"], "items", p["items"], "writeReviewUrl", St.WriteReviewUrl()));
                return;
            }
            if (path == "/api/feedback" && POST)
            {
                string fbKey = "fb:" + ClientIp(req);
                if (LockedMs(fbKey) > 0) { res.Json(429, Err("Çok sık değerlendirme gönderildi, biraz sonra tekrar deneyin.")); return; }
                var body = req.JsonBody(5000);
                double rt = J.Num(body, "rating");
                int rating = J.Finite(rt) ? (int)Math.Round(rt, MidpointRounding.AwayFromZero) : 0;
                if (!(rating >= 1 && rating <= 5)) { res.Json(400, Err("Lütfen 1-5 arası yıldız seçin.")); return; }
                var list = St.ReadFeedback();
                list.Add(J.Obj("id", Crypto.RandomHex(6), "at", J.NowMs(), "rating", rating, "text", St.Clip(J.Get(body, "text"), 300), "name", St.Clip(J.Get(body, "name"), 40),
                    "consent", J.IsTrue(body, "consent"), "table", St.Clip(J.Get(body, "table"), 30), "hidden", false));
                St.WriteFeedback(list);
                Fail(fbKey, 3, 60 * 60 * 1000);
                res.Json(200, J.Obj("ok", true, "writeReviewUrl", rating >= 4 ? St.WriteReviewUrl() : ""));
                return;
            }
            if (path == "/api/site-flags" && GET)
            {
                var mu = St.TvMusic;
                res.Json(200, J.Obj("kioskEnabled", St.KioskEnabled, "kioskA11yEnabled", St.KioskA11yEnabled, "tvMenuEnabled", St.TvMenuEnabled,
                    "tvMusicEnabled", mu["enabled"], "tvMusicYoutubeId", mu["youtubeId"], "tvMusicVolume", mu["volume"]));
                return;
            }
            if (path == "/api/site-info" && GET)
            {
                var s = St.SiteSettings;
                Func<string, string> pick = k => J.S(s, k).Trim();
                res.Json(200, J.Obj("companyName", pick("companyName"), "slogan", pick("slogan"), "phone", pick("phone"), "address", pick("address"),
                    "whatsapp", Regex.Replace(pick("whatsapp"), @"\D", ""), "facebook", pick("facebook"), "instagram", pick("instagram"),
                    "tiktok", pick("tiktok"), "youtube", pick("youtube"), "twitter", pick("twitter"), "googleMaps", pick("googleMaps"),
                    "website", pick("website"), "workingHours", pick("workingHours"), "theme", pick("theme").Length > 0 ? pick("theme") : "mavi"));
                return;
            }
            if (path == "/api/menu-link" && GET) { var info = Tunnel.SiteInfo; res.Json(200, J.Obj("menuBaseUrl", info != null ? info["menuBaseUrl"] : null)); return; }
            if (path == "/api/order-acceptance" && GET) { res.Json(200, St.OrderAcceptance); return; }
            if (path == "/api/table-status" && GET)
            {
                try
                {
                    string table = J.Clip((req.Q("table") ?? "").Trim(), 20);
                    if (table.Length == 0) { res.Json(400, Err("Masa numarası eksik.")); return; }
                    res.Json(200, (object)Samba.GetTableOrderSummary(table) ?? J.Obj("items", new List<object>(), "total", 0));
                }
                catch (Exception e) { res.Json(500, Err(e.Message)); }
                return;
            }
            if (path == "/api/delivery-check" && POST)
            {
                try
                {
                    var body = req.JsonBody();
                    double lat = J.Num(body, "lat"), lng = J.Num(body, "lng");
                    if (!J.Finite(lat) || !J.Finite(lng) || J.Get(body, "lat") == null || J.Get(body, "lng") == null) { res.Json(400, Err("Konum eksik.")); return; }
                    var ds = St.Delivery;
                    if (!ds.HasLocation) { res.Json(400, Err("Konum kontrolü yapılandırılmamış.")); return; }
                    string method; double km = Distance.Km(ds.Lat.Value, ds.Lng.Value, lat, lng, out method);
                    var tier = St.MatchTier(km, ds.Tiers);
                    double kmR = Math.Round(km, 2);
                    if (tier == null) res.Json(200, J.Obj("allowed", false, "distanceKm", kmR, "method", method, "message", "Bu adres servis bölgemiz dışında. Lütfen bizi arayın."));
                    else res.Json(200, J.Obj("allowed", true, "distanceKm", kmR, "method", method, "fee", tier["fee"], "label", tier["label"]));
                }
                catch (Exception e) { res.Json(500, Err(e.Message)); }
                return;
            }
            if (path == "/api/menu" && GET)
            {
                try
                {
                    string t = req.Q("type");
                    string orderType = t == "table" ? "table" : t == "pickup" ? "pickup" : "delivery";
                    res.Json(200, J.Obj("categories", MenuWithSiteData(orderType).Cast<object>().ToList(), "orderType", orderType));
                }
                catch (Exception e) { res.Json(500, Err(e.Message)); }
                return;
            }
            if (path == "/api/upsell-rules" && GET) { res.Json(200, J.Obj("rules", Upsell.ActiveForCustomer())); return; }
            if (path == "/api/upsell-event" && POST)
            {
                try { var b = req.JsonBody(); Upsell.LogEvent(J.S(b, "ruleId"), J.S(b, "event")); } catch { }
                res.Json(200, J.Obj("ok", true));
                return;
            }
            if (path == "/api/order" && POST) { HandleOrder(req, res); return; }
            if (path == "/api/waiter-call" && POST)
            {
                if (RateLimited(_callHits, ClientIp(req), 15)) { res.Json(429, Err("Çok fazla çağrı denemesi. Birkaç dakika sonra tekrar deneyin.")); return; }
                try
                {
                    var body = req.JsonBody();
                    string table = J.Clip(J.S(body, "table").Trim(), 20), type = J.S(body, "type").Trim(), note = J.Clip(J.S(body, "note").Trim(), 200);
                    if (table.Length == 0) { res.Json(400, Err("Masa numarası eksik.")); return; }
                    string label; string tl;
                    if (type == "custom")
                    {
                        if (note.Length == 0) { res.Json(400, Err("Lütfen bir mesaj yazın.")); return; }
                        label = note;
                    }
                    else
                    {
                        if (!WaiterCallTypes.TryGetValue(type, out tl)) { res.Json(400, Err("Geçersiz çağrı türü.")); return; }
                        label = note.Length > 0 ? tl + " — " + note : tl;
                    }
                    var call = J.Obj("id", Crypto.Uuid(), "table", table, "type", type, "note", note, "label", label, "status", "pending", "time", J.IsoNow());
                    lock (_callsLock) { var calls = ReadCalls(); calls.Add(call); WriteCalls(calls); }
                    Broadcast("waiter-call", call);
                    NotifyDesktop("🔔 Garson Çağrısı", table + " - " + label);
                    Push.SendGarson(call);
                    res.Json(200, J.Obj("ok", true));
                }
                catch (Exception e) { res.Json(400, Err(e.Message)); }
                return;
            }
            if (path == "/api/order-tags" && GET)
            {
                var empty = J.Obj("groupId", null, "minSelected", 0, "maxSelected", 0, "tags", new List<object>());
                try
                {
                    var gid = St.OrderTagGroupId;
                    if (!gid.HasValue) { res.Json(200, empty); return; }
                    var g = Samba.GetOrderTagGroups().FirstOrDefault(x => x.Id == gid.Value);
                    if (g == null) { res.Json(200, empty); return; }
                    res.Json(200, J.Obj("groupId", g.Id, "minSelected", g.MinSelected, "maxSelected", g.MaxSelected, "tags", g.Tags.Cast<object>().ToList()));
                }
                catch { res.Json(200, empty); }
                return;
            }
            // Garson APK (paylasilan anahtar)
            if (path == "/api/app/waiter-calls" && GET)
            {
                if (req.Q("key") != St.WaiterAppKey) { res.Json(403, Err("Geçersiz anahtar.")); return; }
                res.Json(200, J.Obj("calls", Reverse(ReadCalls().Where(c => J.S(J.D(c), "status") == "pending"))));
                return;
            }
            if ((path == "/api/app/waiter-calls/ack" || path == "/api/admin/waiter-calls/ack") && POST)
            {
                if (path.StartsWith("/api/app/") ? req.Q("key") != St.WaiterAppKey : !IsAuthed(req)) { res.Json(403, path.StartsWith("/api/app/") ? Err("Geçersiz anahtar.") : NeedLogin); return; }
                try
                {
                    var body = req.JsonBody();
                    lock (_callsLock)
                    {
                        var calls = ReadCalls();
                        var call = calls.Select(J.D).FirstOrDefault(c => c != null && J.S(c, "id") == J.S(body, "id") && J.S(c, "status") == "pending");
                        if (call == null) { res.Json(404, Err("Çağrı bulunamadı.")); return; }
                        call["status"] = "seen"; call["seenAt"] = J.IsoNow();
                        WriteCalls(calls);
                    }
                    res.Json(200, J.Obj("ok", true));
                }
                catch (Exception e) { res.Json(400, Err(e.Message)); }
                return;
            }

            // ---------------- giris
            if (path == "/api/admin/login-step1" && POST)
            {
                string pwKey = "pw:" + ClientIp(req);
                long wait = LockedMs(pwKey);
                if (wait > 0) { res.Json(429, Err("Çok fazla hatalı deneme. " + (long)Math.Ceiling(wait / 1000.0) + " saniye sonra tekrar deneyin.")); return; }
                var body = req.JsonBody();
                string identifier = J.S(body, "identifier").Trim(), password = J.S(body, "password");
                if (identifier.Length == 0 || password.Length == 0) { res.Json(400, Err("E-posta/telefon ve şifrenizi girin.")); return; }
                var v = License.VerifyPassword(identifier, password);
                if (!J.Truthy(J.Get(v, "ok"))) { Fail(pwKey); res.Json(401, Err(J.S(v, "error").Length > 0 ? J.S(v, "error") : "E-posta/telefon veya şifre hatalı.")); return; }
                Success(pwKey);
                res.AddHeader("Set-Cookie", SignedCookie(req, "qr_admin_pending", J.Obj("exp", J.NowMs() + 10 * 60 * 1000), Secret("qrmenu-pending:"), 600));
                Log.Write("[login] 1. adim basarili");
                res.Json(200, J.Obj("ok", true));
                return;
            }
            if (path == "/api/admin/login-step2" && POST)
            {
                string pinKey = "pin:" + ClientIp(req);
                long wait = LockedMs(pinKey);
                if (wait > 0) { res.Json(429, Err("Çok fazla hatalı deneme. " + (long)Math.Ceiling(wait / 1000.0) + " saniye sonra tekrar deneyin.")); return; }
                if (!HasValidPending(req)) { res.Json(401, Err("Önce e-posta/telefon ve şifrenizle giriş yapın.")); return; }
                var body = req.JsonBody();
                Samba.PinResult pr;
                try { pr = Samba.CheckPin(J.Get(body, "pin")); }
                catch (Exception e) { Log.Write("[login-step2] SambaPOS PIN sorgusu basarisiz: " + e.Message); res.Json(503, Err("SambaPOS veritabanına bağlanılamadı. Restoran bilgisayarında SQL Server açık mı, ayarlardaki veritabanı doğru mu kontrol edin.")); return; }
                if (!pr.IsAdmin)
                {
                    Fail(pinKey, 10, 2 * 60 * 1000);
                    Log.Write("[login-step2] PIN reddedildi: " + (pr.Found ? "yonetici olmayan rol \"" + pr.Role + "\"" : "SambaPOS kullanicilarinda yok"));
                    res.Json(401, Err(pr.Found
                        ? "Bu PIN \"" + (string.IsNullOrEmpty(pr.Role) ? "rolsüz" : pr.Role) + "\" rolündeki bir kullanıcıya ait. Yönetim paneline SambaPOS'ta Admin/Yönetici rolündeki kullanıcının PIN'i ile girilir."
                        : "Bu PIN SambaPOS kullanıcıları arasında bulunamadı. SambaPOS'a girerken kullandığınız PIN'i yazın."));
                    return;
                }
                Log.Write("[login-step2] giris basarili: " + pr.UserName);
                Success(pinKey);
                res.AddHeader("Set-Cookie", "qr_admin_pending=; Path=/; HttpOnly; Max-Age=0");
                NewSession(req, res, "admin");
                res.Json(200, J.Obj("ok", true));
                return;
            }
            if (path == "/api/admin/garson-login" && POST)
            {
                string gKey = "gpin:" + ClientIp(req);
                long wait = LockedMs(gKey);
                if (wait > 0) { res.Json(429, Err("Çok fazla hatalı deneme. " + (long)Math.Ceiling(wait / 1000.0) + " saniye sonra tekrar deneyin.")); return; }
                var body = req.JsonBody();
                var emails = St.AdminEmails;
                if (emails.Count > 0)
                {
                    string email = J.LowerTr(J.S(body, "email").Trim());
                    if (email.Length == 0 || !emails.Contains(email)) { Fail(gKey); res.Json(401, Err("E-posta veya PIN hatalı.")); return; }
                }
                Samba.PinResult pr;
                try { pr = Samba.CheckPin(J.Get(body, "pin")); }
                catch (Exception e) { Log.Write("[garson-login] SambaPOS PIN sorgusu basarisiz: " + e.Message); res.Json(503, Err("SambaPOS veritabanına bağlanılamadı.")); return; }
                if (!pr.Found) { Fail(gKey); res.Json(401, Err("PIN hatalı - SambaPOS kullanıcıları arasında bulunamadı.")); return; }
                Success(gKey);
                NewSession(req, res, "garson");
                res.Json(200, J.Obj("ok", true));
                return;
            }
            if (path == "/api/admin/logout" && POST) { res.AddHeader("Set-Cookie", "qr_admin_session=; Path=/; HttpOnly; Max-Age=0"); res.Json(200, J.Obj("ok", true)); return; }
            if (path == "/api/admin/me") { res.Json(200, J.Obj("authed", IsAuthed(req))); return; }

            // ---------------- SambaPOS terminali / garson-web / PWA
            if (path == "/admin/icon-192.png" || path == "/admin/icon-512.png")
            {
                string f = P("admin\\" + path.Substring(7));
                if (File.Exists(f)) res.Send(200, "image/png", File.ReadAllBytes(f), "public, max-age=86400"); else { res.Status = 404; res.Handled = true; }
                return;
            }
            if (path == "/sw.js")
            {
                res.SetHeader("Service-Worker-Allowed", "/");
                res.Send(200, "text/javascript; charset=utf-8", Encoding.UTF8.GetBytes("self.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', e => e.waitUntil(self.clients.claim()));\nself.addEventListener('fetch', event => { event.respondWith(fetch(event.request).catch(() => caches.match(event.request))); });"), "no-store");
                return;
            }
            if (path.StartsWith("/samba-lan"))
            {
                if (!CanUseSambaposTerminal(req)) { res.Json(404, Err("Bulunamadı")); return; }
                ProxySamba(req, res);
                return;
            }
            if (path.StartsWith("/garson-web"))
            {
                if (!CanUseSambaposTerminal(req)) { res.Json(404, Err("Bulunamadı")); return; }
                ServeGarsonWeb(res, path.Substring("/garson-web".Length));
                return;
            }
            if (path == "/api/admin/terminal-config-options" && GET)
            {
                if (!CanUseSambaposTerminal(req)) { res.Json(401, NeedLogin); return; }
                try { res.Json(200, Samba.TerminalConfigOptions()); } catch (Exception e) { res.Json(500, Err(e.Message)); }
                return;
            }

            if (path.StartsWith("/api/admin/")) { AdminApi(req, res, path, GET, POST); if (res.Handled) return; }

            if (path.StartsWith("/admin"))
            {
                string rel = path == "/admin" || path == "/admin/" ? "/admin/index.html" : Decode(path);
                string file;
                try { file = Path.GetFullPath(Path.Combine(Root, rel.TrimStart('/').Replace('/', '\\'))); } catch { res.Json(404, Err("Bulunamadı")); return; }
                if (!Inside(file, P("admin")) || !File.Exists(file)) { res.Json(404, Err("Bulunamadı")); return; }
                res.Send(200, TypeOf(Path.GetExtension(file)), File.ReadAllBytes(file), "no-store");
                return;
            }
            if ((path == "/tv" || path == "/tv.html") && !St.TvMenuEnabled)
            {
                res.Html(200, "<!doctype html><html lang=\"tr\"><meta charset=\"utf-8\"><title>TV Menü</title>" +
                    "<body style=\"font-family:system-ui;background:#141414;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center\">" +
                    "<div><h2>📺 TV Menü şu an kapalı</h2><p style=\"color:#999\">Panelden Ayarlar → Kiosk &amp; TV Menü bölümünden açabilirsiniz.</p></div></body></html>");
                return;
            }
            ServeStatic(req, res, path);
        }

        // ============================================================== musteri siparisi
        static void HandleOrder(Req req, Res res)
        {
            if (RateLimited(_orderHits, ClientIp(req), 5)) { res.Json(429, Err("Çok fazla sipariş denemesi. Birkaç dakika sonra tekrar deneyin.")); return; }
            try
            {
                var body = req.JsonBody();
                var cart = J.L(J.Get(body, "items")) ?? new List<object>();
                if (cart.Count == 0) { res.Json(400, Err("Sepetiniz boş.")); return; }
                if (cart.Count > 40) { res.Json(400, Err("Sepette çok fazla ürün var.")); return; }
                string bt = J.S(body, "type");
                string orderType = bt == "table" ? "table" : bt == "pickup" ? "pickup" : "delivery";
                string tableNumber = orderType == "table" ? J.Clip(J.S(body, "tableNumber").Trim(), 20) : "";
                if (orderType == "table" && tableNumber.Length == 0) { res.Json(400, Err("Masa numarası eksik.")); return; }
                bool isKiosk = J.IsTrue(body, "fromKiosk") && St.KioskEnabled;
                string customerName = J.Clip(J.S(body, "customerName").Trim(), 80), phone = J.Clip(J.S(body, "phone").Trim(), 30),
                    address = J.Clip(J.S(body, "address").Trim(), 300), note = J.Clip(J.S(body, "note").Trim(), 200), zone = J.Clip(J.S(body, "zone").Trim(), 60);
                Dictionary<string, object> deliveryInfo = null;
                if (orderType != "table" && !isKiosk)
                {
                    if (customerName.Length == 0 || phone.Length == 0 || zone.Length == 0) { res.Json(400, Err("Ad soyad, telefon ve bölge zorunlu.")); return; }
                    string digits = Regex.Replace(phone, @"\D", "");
                    if (digits.Length < 10 || digits.Length > 15) { res.Json(400, Err("Geçerli bir telefon numarası girin.")); return; }
                    var zones = St.DeliveryZones.Select(J.S).ToList();
                    if (zones.Count > 0 && !zones.Contains(zone)) { res.Json(400, Err("Geçersiz teslimat bölgesi.")); return; }
                    if (orderType == "delivery")
                    {
                        var ds = St.Delivery;
                        double lat = J.Num(body, "lat"), lng = J.Num(body, "lng");
                        bool hasLoc = ds.HasLocation && J.Get(body, "lat") != null && J.Get(body, "lng") != null && J.Finite(lat) && J.Finite(lng);
                        if (ds.HasLocation && ds.LocationRequired && !hasLoc) { res.Json(400, Err("Sipariş için konum paylaşımı zorunlu.")); return; }
                        if (hasLoc)
                        {
                            string method; double km = Distance.Km(ds.Lat.Value, ds.Lng.Value, lat, lng, out method);
                            var tier = St.MatchTier(km, ds.Tiers);
                            if (tier == null) { res.Json(400, Err("Bu adres servis bölgemiz dışında. Lütfen bizi arayın.")); return; }
                            deliveryInfo = J.Obj("distanceKm", Math.Round(km, 2), "method", method, "fee", tier["fee"], "label", tier["label"]);
                        }
                    }
                }
                var cats = Samba.LiveMenu(St.SambaposMenuId, orderType == "table" ? null : "PAKET");
                var byId = new Dictionary<string, Samba.Item>();
                foreach (var c in cats) foreach (var i in c.Items) byId[i.Id] = i;   // Map: son gelen kazanir (Node ile ayni)
                var gid = St.OrderTagGroupId;
                var tagGroup = gid.HasValue ? Samba.GetOrderTagGroups().FirstOrDefault(g => g.Id == gid.Value) : null;
                var tagsById = new Dictionary<string, Dictionary<string, object>>();
                if (tagGroup != null) foreach (var t in tagGroup.Tags) tagsById[J.S(t, "id")] = t;
                var items = new List<object>();
                foreach (var lineObj in cart)
                {
                    var line = J.DD(lineObj);
                    Samba.Item real;
                    if (!byId.TryGetValue(J.S(line, "menuItemId"), out real)) { res.Json(400, Err("Ürün bulunamadı (menü güncellenmiş olabilir, sayfayı yenileyin).")); return; }
                    var portion = real.Portions.FirstOrDefault(p => p.Id == J.S(line, "portionId")) ?? real.Portions[0];
                    long qty = (long)Math.Max(1, Math.Min(20, Math.Round(J.NumOr(J.Get(line, "quantity"), 1), MidpointRounding.AwayFromZero)));
                    var tags = new List<object>();
                    var tagIds = J.L(J.Get(line, "tagIds"));
                    if (tagIds != null) foreach (var id in tagIds) { Dictionary<string, object> t; if (tagsById.TryGetValue(J.S(id), out t)) tags.Add(J.Obj("groupId", gid, "name", t["name"], "price", t["price"])); }
                    items.Add(J.Obj("menuItemId", real.Id, "portionId", portion.Id, "portionName", portion.Name, "name", real.Name, "price", J.NumVal(portion.Price), "quantity", qty, "categoryName", real.CategoryName, "tags", tags));
                }
                if (deliveryInfo != null && J.Num(deliveryInfo, "fee") > 0)
                {
                    string feeName = J.LowerTr(St.Delivery.FeeMenuItemName.Trim());
                    var feeItem = feeName.Length > 0 ? cats.SelectMany(c => c.Items).FirstOrDefault(i => J.LowerTr(i.Name.Trim()) == feeName) : null;
                    if (feeItem != null)
                    {
                        var p0 = feeItem.Portions[0];
                        items.Add(J.Obj("menuItemId", feeItem.Id, "portionId", p0.Id, "portionName", p0.Name, "name", feeItem.Name, "price", deliveryInfo["fee"], "quantity", 1L));
                    }
                }
                double total = items.Select(J.DD).Sum(i => J.Num(i, "price") * J.Num(i, "quantity"));
                var order = J.Obj("id", Crypto.Uuid(), "status", "pending", "type", orderType, "tableNumber", tableNumber, "customerName", customerName, "phone", phone,
                    "address", address, "note", note, "zone", zone, "deliveryInfo", deliveryInfo, "items", items, "total", J.NumVal(total), "time", J.IsoNow());
                string kind = orderType == "table" ? tableNumber + " siparişi" : orderType == "pickup" ? "Gel-Al siparişi" : "Paket servis siparişi";
                if (St.DirectOrderSend || IsAuthed(req) || (isKiosk && St.KioskDirectSend))
                {
                    var result = Samba.CreateOrder(order);
                    var ev = new Dictionary<string, object>(order); ev["status"] = "approved"; ev["ticketNumber"] = result["ticketNumber"]; ev["total"] = result["total"];
                    Broadcast("new-order", ev);
                    NotifyDesktop("🛎️ Yeni Sipariş", kind + " geldi (#" + J.S(result["ticketNumber"]) + ").");
                    PrintOrderToKitchen(order, result["ticketNumber"]);
                    res.Json(200, J.Obj("ok", true, "ticketNumber", result["ticketNumber"], "total", result["total"]));
                    return;
                }
                lock (_ordersLock) { var orders = ReadOrders(); orders.Add(order); WriteOrders(orders); }
                Broadcast("new-order", order);
                NotifyDesktop("🛎️ Yeni Sipariş", kind + " geldi, onay bekliyor.");
                res.Json(200, J.Obj("ok", true, "pending", true, "orderId", order["id"], "total", order["total"]));
            }
            catch (Exception e) { res.Json(500, Err(e.Message)); }
        }
    }

    // ------------------------------------------------------------------ Capraz satis (upsell.js)
    public static class Upsell
    {
        static string RulesPath { get { return Path.Combine(App.Root, "upsell-rules.json"); } }
        static string StatsPath { get { return Path.Combine(App.Root, "upsell-stats.json"); } }
        static readonly object _lock = new object();
        public static List<object> ReadRules() { return Files.ReadJsonArray(RulesPath); }
        static void WriteRules(List<object> r) { Files.Write(RulesPath, J.Pretty(r)); }
        public static List<object> ActiveForCustomer()
        {
            return ReadRules().Select(J.DD).Where(r => J.Truthy(J.Get(r, "active"))).Select(r => (object)J.Obj("id", J.Get(r, "id"), "triggerCategory", J.Get(r, "triggerCategory"),
                "suggestItemNames", J.Get(r, "suggestItemNames"), "message", J.Get(r, "message"), "buttonLabel", J.Get(r, "buttonLabel"), "scaleWithQty", J.Truthy(J.Get(r, "scaleWithQty")))).ToList();
        }
        public static Dictionary<string, object> Upsert(Dictionary<string, object> input)
        {
            lock (_lock)
            {
                var rules = ReadRules();
                string trig = J.S(input, "triggerCategory").Trim();
                var names = (J.L(J.Get(input, "suggestItemNames")) ?? new List<object>()).Select(s => (object)J.S(s).Trim()).Where(s => ((string)s).Length > 0).ToList();
                string msg = J.Clip(J.S(input, "message").Trim(), 140);
                string btn = J.Clip((J.Truthy(J.Get(input, "buttonLabel")) ? J.S(input, "buttonLabel") : "Ekle").Trim(), 30);
                if (trig.Length == 0) throw new Exception("Tetikleyici kategori zorunlu.");
                if (names.Count == 0) throw new Exception("En az bir önerilecek ürün girin.");
                if (msg.Length == 0) throw new Exception("Öneri mesajı zorunlu.");
                var rule = J.Obj("id", J.Truthy(J.Get(input, "id")) ? J.Get(input, "id") : Crypto.Uuid(), "active", !J.IsFalse(J.Get(input, "active")),
                    "triggerCategory", trig, "suggestItemNames", names, "message", msg, "buttonLabel", btn, "scaleWithQty", J.Truthy(J.Get(input, "scaleWithQty")));
                int idx = rules.FindIndex(r => J.S(J.D(r), "id") == J.S(rule, "id"));
                if (idx == -1) rules.Add(rule); else rules[idx] = rule;
                WriteRules(rules);
                return rule;
            }
        }
        public static void Delete(string id) { lock (_lock) WriteRules(ReadRules().Where(r => J.S(J.D(r), "id") != id).ToList()); }
        public static void LogEvent(string ruleId, string ev)
        {
            if (!new[] { "impression", "click", "decline" }.Contains(ev)) return;
            if (!ReadRules().Any(r => J.S(J.D(r), "id") == ruleId)) return;
            lock (_lock)
            {
                var stats = Files.ReadJsonArray(StatsPath);
                stats.Add(J.Obj("ruleId", ruleId, "event", ev, "time", J.IsoNow()));
                Files.Write(StatsPath, J.Pretty(Files.TakeLast(stats, 20000)));
            }
        }
        public static List<object> StatsSummary()
        {
            var stats = Files.ReadJsonArray(StatsPath).Select(J.DD).ToList();
            return ReadRules().Select(J.DD).Select(r =>
            {
                var f = stats.Where(s => J.S(s, "ruleId") == J.S(r, "id")).ToList();
                int imp = f.Count(s => J.S(s, "event") == "impression"), clk = f.Count(s => J.S(s, "event") == "click");
                double conv = imp > 0 ? Math.Round((double)clk / imp * 1000, MidpointRounding.AwayFromZero) / 10 : 0;
                return (object)J.Obj("id", r["id"], "triggerCategory", J.Get(r, "triggerCategory"), "suggestItemNames", J.Get(r, "suggestItemNames"), "active", J.Get(r, "active"),
                    "impressions", imp, "clicks", clk, "conversionRate", J.NumVal(conv));
            }).ToList();
        }
    }
}
