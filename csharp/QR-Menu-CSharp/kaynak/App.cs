using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace QRMenu
{
    public static partial class App
    {
        public const string Version = "2.0.0";
        public static string Root;
        public static int Port = 4500;
        static LocalHost _host;
        static Timer _paketTimer, _googleTimer, _notesTimer;

        public static void Start()
        {
            Web.Init();
            Root = Path.GetFullPath(Program.Opt("root") ?? AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\');
            Log.Init(Program.Opt("logs") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), @"AlfaPOS\QRMenuYerel\logs"));
            Cfg.PathFile = Path.Combine(Root, "config.json");
            MenuEditor.IndexPath = Path.Combine(Root, "index.html");
            var c = Cfg.Read();
            int p;
            Port = int.TryParse(Program.Opt("port"), out p) ? p : (int)J.NumOr(J.Get(c, "port"), 4500);
            int w, io; ThreadPool.GetMinThreads(out w, out io); ThreadPool.SetMinThreads(Math.Max(w, 48), Math.Max(io, 48));
            License.Init();
            _host = new LocalHost(Port, Handle);
            _host.Start();
            Log.Write("QR Menu (C#) " + Updater.LocalVersion() + ": http://127.0.0.1:" + Port + "  (yönetim paneli: /admin)  klasör: " + Root);
            if (!Program.Opts.ContainsKey("notunnel")) Tunnel.Start(Handle);
            if (!Program.Opts.ContainsKey("noupdate")) Updater.Start();
            if (Program.Opts.ContainsKey("updatenow")) ThreadPool.QueueUserWorkItem(delegate { Updater.RunCheck(); });
            _googleTimer = new Timer(_ => { try { St.RefreshGoogleReviews(); } catch { } }, null, 60 * 1000, St.RotateMs);
            _notesTimer = new Timer(_ =>
            {
                var a = St.NotesAi;
                if (J.IsTrue(a, "enabled") && J.S(a, "key").Length > 0 && J.NowMs() - J.Num(a, "lastRunAt") > 24 * 3600000.0)
                    try { St.GenerateChefNotes(null, null); } catch (Exception ex) { Log.Write("[sefin-notu] yazilamadi: " + ex.Message); }
            }, null, 60 * 60 * 1000, 60 * 60 * 1000);
            if (!Program.Opts.ContainsKey("nosync"))
                _paketTimer = new Timer(_ => { try { Samba.SyncClosedPaketDurumu(); } catch (Exception ex) { Log.Write("Paket Durumu senkron hatası: " + ex.Message); } }, null, 20000, 20000);
            ThreadPool.QueueUserWorkItem(delegate { try { Db.Query("SELECT 1"); Log.Write("SQL bağlantısı hazır: " + Db.Source); } catch (Exception ex) { Log.Write("UYARI - SQL'e bağlanılamadı: " + ex.Message); } });
        }

        public static void Stop()
        {
            try { Tunnel.Stop(); _host.Stop(); } catch { }
            Log.Write("QR Menu durduruldu.");
        }

        // ============================================================== yardimcilar
        static string P(string name) { return Path.Combine(Root, name); }
        static string ClientIp(Req req)
        {
            string xf = req.Header("x-forwarded-for");
            return (string.IsNullOrEmpty(xf) ? req.RemoteIp : xf).Split(',')[0].Trim();
        }
        static bool IsHttps(Req req) { return req.Header("x-forwarded-proto") == "https"; }
        static string HtmlEscape(string v) { return (v ?? "").Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;").Replace("'", "&#39;"); }

        // ---- oturumlar (imzali durumsuz cerez - Node surumuyle AYNI bicim, gecis sirasinda oturumlar dusmez)
        const long SessionTtlMs = 30L * 24 * 60 * 60 * 1000;
        static byte[] Secret(string purpose) { return Crypto.Sha256(purpose + (License.ActivationKey.Length > 0 ? License.ActivationKey : "no-key")); }
        static Dictionary<string, object> VerifySigned(string raw, byte[] secret)
        {
            raw = raw ?? "";
            int dot = raw.LastIndexOf('.');
            if (dot < 1) return null;
            string payload = raw.Substring(0, dot), sig = raw.Substring(dot + 1);
            if (!Crypto.FixedEquals(sig, Crypto.HmacB64Url(secret, payload))) return null;
            try { return J.D(J.Parse(Encoding.UTF8.GetString(Crypto.FromB64Url(payload)))); } catch { return null; }
        }
        static Dictionary<string, object> CurrentSession(Req req)
        {
            var rec = VerifySigned(req.Cookie("qr_admin_session"), Secret("qrmenu-session:"));
            if (rec == null || !J.Truthy(J.Get(rec, "exp")) || J.Num(rec, "exp") < J.NowMs()) return null;
            return rec;
        }
        static bool IsAuthed(Req req) { var s = CurrentSession(req); string r = J.S(s, "role"); return s != null && (r == "admin" || r == "garson"); }
        static bool CanUseSambaposTerminal(Req req)
        {
            var s = CurrentSession(req);
            if (s == null) return false;
            if (J.S(s, "role") == "admin") return true;
            if (J.S(s, "role") == "garson") return !req.IsTunnel || St.RemoteGarsonAllowed;
            return false;
        }
        static string SignedCookie(Req req, string name, object payloadObj, byte[] secret, long maxAgeSec)
        {
            string payload = Crypto.B64Url(Encoding.UTF8.GetBytes(J.Str(payloadObj)));
            string v = name + "=" + payload + "." + Crypto.HmacB64Url(secret, payload) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAgeSec;
            return IsHttps(req) ? v + "; Secure" : v;
        }
        static void NewSession(Req req, Res res, string role)
        {
            res.AddHeader("Set-Cookie", SignedCookie(req, "qr_admin_session", J.Obj("role", role, "exp", J.NowMs() + SessionTtlMs), Secret("qrmenu-session:"), SessionTtlMs / 1000));
        }
        static bool HasValidPending(Req req)
        {
            var rec = VerifySigned(req.Cookie("qr_admin_pending"), Secret("qrmenu-pending:"));
            if (rec == null) { if (!string.IsNullOrEmpty(req.Cookie("qr_admin_pending"))) Log.Write("[login] gecici oturum imzasi gecersiz"); return false; }
            bool ok = J.Num(rec, "exp") > J.NowMs();
            if (!ok) Log.Write("[login] gecici oturum suresi dolmus");
            return ok;
        }

        // ---- deneme kilidi / hiz siniri
        class Lock { public int Count; public long Until; }
        static readonly ConcurrentDictionary<string, Lock> _attempts = new ConcurrentDictionary<string, Lock>();
        static long LockedMs(string key) { Lock s; return _attempts.TryGetValue(key, out s) && s.Until > J.NowMs() ? s.Until - J.NowMs() : 0; }
        static void Fail(string key, int threshold = 6, long lockMs = 5 * 60 * 1000)
        {
            var s = _attempts.GetOrAdd(key, _ => new Lock());
            lock (s) { s.Count++; if (s.Count >= threshold) { s.Until = J.NowMs() + lockMs; s.Count = 0; } }
        }
        static void Success(string key) { Lock s; _attempts.TryRemove(key, out s); }
        static readonly ConcurrentDictionary<string, List<long>> _orderHits = new ConcurrentDictionary<string, List<long>>(), _callHits = new ConcurrentDictionary<string, List<long>>();
        static bool RateLimited(ConcurrentDictionary<string, List<long>> map, string ip, int max)
        {
            long now = J.NowMs(), win = 10 * 60 * 1000;
            var hits = map.GetOrAdd(ip, _ => new List<long>());
            lock (hits) { hits.RemoveAll(t => now - t >= win); hits.Add(now); return hits.Count > max; }
        }

        // ---- canli bildirim (SSE)
        class SseClient { public Stream S; public readonly object L = new object(); public volatile bool Dead; }
        static readonly List<SseClient> _sse = new List<SseClient>();
        static void Broadcast(string ev, object data)
        {
            var b = Encoding.UTF8.GetBytes("event: " + ev + "\ndata: " + J.Str(data) + "\n\n");
            SseClient[] list; lock (_sse) list = _sse.ToArray();
            foreach (var c in list) { try { lock (c.L) { c.S.Write(b, 0, b.Length); c.S.Flush(); } } catch { c.Dead = true; } }
        }

        // ---- siparis / cagri dosyalari
        static readonly object _ordersLock = new object(), _callsLock = new object();
        static List<object> ReadOrders() { return Files.ReadJsonArray(P("orders.json")); }
        static void WriteOrders(List<object> o) { Files.Write(P("orders.json"), J.Pretty(Files.TakeLast(o, 500))); }
        static List<object> ReadCalls() { return Files.ReadJsonArray(P("calls.json")); }
        static void WriteCalls(List<object> c) { Files.Write(P("calls.json"), J.Pretty(Files.TakeLast(c, 300))); }
        static List<object> Reverse(IEnumerable<object> l) { var x = l.ToList(); x.Reverse(); return x; }

        // ---- gorseller
        static readonly string[] ImageExts = { ".jpg", ".jpeg", ".png", ".webp" };
        static string SafeImageBase(string itemName) { return J.Clip(Regex.Replace(itemName ?? "", "[\\\\/:*?\"<>|\\x00-\\x1f]", "").Trim(), 120); }
        public static string FindProductImage(string itemName)
        {
            string b = SafeImageBase(itemName);
            if (b.Length == 0) return null;
            foreach (var e in ImageExts)
            {
                try
                {
                    string f = Path.GetFullPath(Path.Combine(Root, b + e));
                    if (f.StartsWith(Root + "\\", StringComparison.OrdinalIgnoreCase) && File.Exists(f)) return "./" + b + e;
                }
                catch { }
            }
            return null;
        }
        static readonly Regex DataUrlRe = new Regex("^data:image/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$");
        static string SaveDataUrlImage(string itemName, string dataUrl)
        {
            var m = DataUrlRe.Match((dataUrl ?? "").Trim());
            if (!m.Success) throw new Exception("Geçersiz görsel (sadece JPEG/PNG).");
            string b = SafeImageBase(itemName);
            if (b.Length == 0) throw new Exception("Ürün adı geçersiz.");
            bool png = m.Groups[1].Value == "png";
            var buf = Convert.FromBase64String(m.Groups[2].Value);
            if (buf.Length > 8 * 1024 * 1024) throw new Exception("Görsel çok büyük (8MB üstü).");
            string file = Path.GetFullPath(Path.Combine(Root, b + (png ? ".png" : ".jpg")));
            if (!file.StartsWith(Root + "\\", StringComparison.OrdinalIgnoreCase)) throw new Exception("Geçersiz dosya adı.");
            File.WriteAllBytes(file, Images.Resize(buf, png, 1000));
            return b + (png ? ".png" : ".jpg");
        }
        static string SaveLogo(string dataUrl)
        {
            var m = DataUrlRe.Match((dataUrl ?? "").Trim());
            if (!m.Success) throw new Exception("Geçersiz görsel (sadece JPEG/PNG).");
            bool png = m.Groups[1].Value == "png";
            string ext = png ? ".png" : ".jpg";
            var buf = Convert.FromBase64String(m.Groups[2].Value);
            if (buf.Length > 8 * 1024 * 1024) throw new Exception("Görsel çok büyük (8MB üstü).");
            var resized = Images.Resize(buf, png, 500);
            foreach (var old in new[] { ".png", ".jpg", ".jpeg" }) { try { File.Delete(P("logo" + old)); } catch { } }
            File.WriteAllBytes(P("logo" + ext), resized);
            foreach (var f in new[] { "index.html", "siparis.html", "yeni.html", "tv.html", "garson.html", "iletisim.html" })
            {
                string p = P(f);
                if (!File.Exists(p)) continue;
                Files.Write(p, Regex.Replace(Files.Read(p), @"\./logo\.(png|jpg|jpeg)", "./logo" + ext));
            }
            return ext;
        }

        // ---- menu + site verisi (/api/menu ve sefin notu icin)
        public static List<Dictionary<string, object>> MenuWithSiteData(string orderType)
        {
            string priceTag = orderType == "table" ? null : "PAKET";
            var cats = Samba.LiveMenu(St.SambaposMenuId, priceTag);
            List<MenuEditor.SiteItem> site = null;
            try { site = MenuEditor.ParseSiteItems(Files.Read(P("index.html"))); } catch { }
            var list = new List<Dictionary<string, object>>();
            foreach (var cat in cats)
            {
                var items = new List<object>();
                foreach (var item in cat.Items)
                {
                    var o = Samba.ItemJson(item);
                    if (site != null)
                    {
                        string n = J.LowerTr(item.Name.Trim());
                        var si = site.FirstOrDefault(s => J.LowerTr(s.Name.Trim()) == n);
                        if (si != null) { o["description"] = si.Description; o["badges"] = si.Badges.Cast<object>().ToList(); o["subcat"] = si.Subcat; o["oldPrice"] = si.OldPrice; }
                        o["imageUrl"] = FindProductImage(item.Name);
                    }
                    items.Add(o);
                }
                list.Add(J.Obj("id", cat.Id, "name", cat.Name, "items", items));
            }
            return list;
        }

        // ---- mutfak yazicisi
        static void PrintOrderToKitchen(Dictionary<string, object> order, object ticketNumber)
        {
            var printer = St.KitchenPrinter;
            if (!J.IsTrue(printer, "enabled")) return;
            var items = J.LL(J.Get(order, "items")).Select(J.DD).ToList();
            if (!J.IsTrue(printer, "autoRoute")) { if (J.S(printer, "name").Length > 0) SendPrintJob(J.S(printer, "name"), order, ticketNumber, items, null); return; }
            ThreadPool.QueueUserWorkItem(delegate
            {
                var samba = new Samba.PrinterRouting();
                try { samba = Samba.GetKitchenPrinterRouting(); } catch (Exception e) { Log.Write("SambaPOS yazıcı eşlemesi okunamadı: " + e.Message); }
                var map = J.DD(printer["categoryMap"]);
                var groups = new Dictionary<string, List<Dictionary<string, object>>>();
                var orderList = new List<string>();
                foreach (var it in items)
                {
                    string cat = J.S(it, "categoryName"); string s;
                    string target = (cat.Length > 0 && J.S(map, cat).Length > 0) ? J.S(map, cat)
                        : (cat.Length > 0 && samba.ByCategory.TryGetValue(cat, out s) && s.Length > 0) ? s
                        : !string.IsNullOrEmpty(samba.DefaultPrinter) ? samba.DefaultPrinter : J.S(printer, "name");
                    if (string.IsNullOrEmpty(target)) continue;
                    if (!groups.ContainsKey(target)) { groups[target] = new List<Dictionary<string, object>>(); orderList.Add(target); }
                    groups[target].Add(it);
                }
                foreach (var t in orderList) SendPrintJob(t, order, ticketNumber, groups[t], t);
            });
        }
        static void SendPrintJob(string printerName, Dictionary<string, object> order, object ticketNumber, List<Dictionary<string, object>> items, string station)
        {
            string type = J.S(order, "type");
            string kind = type == "table" ? (J.S(order, "tableNumber").Length > 0 ? J.S(order, "tableNumber") : "MASA") : type == "pickup" ? "GEL-AL SERVİS" : "PAKET SERVİS";
            var title = new List<string> { kind };
            if (J.Truthy(ticketNumber)) title.Add("Adisyon No: #" + J.S(ticketNumber));
            if (!string.IsNullOrEmpty(station)) title.Add("[" + station + "]");
            var body = new List<string>();
            if (J.S(order, "customerName").Length > 0) body.Add(J.S(order, "customerName"));
            if (J.S(order, "phone").Length > 0) body.Add(J.S(order, "phone"));
            body.Add("------------------------------");
            foreach (var i in items)
            {
                body.Add(J.S(i, "quantity") + "x " + J.S(i, "name"));
                string pn = J.S(i, "portionName");
                if (pn.Length > 0 && pn != "Adet" && pn != "Normal") body.Add("   (" + pn + ")");
            }
            body.Add("------------------------------");
            if (J.S(order, "note").Length > 0) body.Add("Not: " + J.S(order, "note"));
            body.Add(DateTime.Now.ToString("dd.MM.yyyy HH:mm:ss"));
            Printing.Print(printerName, title, body);
        }

        // ---- masaustu bildirimi (servis oturumunda ekran yok - sadece konsol modunda)
        static void NotifyDesktop(string title, string text) { if (Environment.UserInteractive) Log.Write("[bildirim] " + title + " - " + text); }

        // ---- sayfa isleme (site ayarlarini HTML'e uygular)
        static readonly Dictionary<string, string[]> Themes = new Dictionary<string, string[]> {
            { "mavi", new[] { "Mavi (varsayılan)", "#3498db", "#007acc" } }, { "kirmizi", new[] { "Kırmızı", "#e74c3c", "#c0392b" } }, { "yesil", new[] { "Yeşil", "#27ae60", "#1e8e3e" } },
            { "turuncu", new[] { "Turuncu", "#e67e22", "#d35400" } }, { "mor", new[] { "Mor", "#9b59b6", "#8e44ad" } }, { "lacivert", new[] { "Lacivert", "#2c3e50", "#1a252f" } },
            { "bordo", new[] { "Bordo (Premium)", "#7c1d1d", "#4a1010" } } };

        static string RenderSiteHtml(string file, string html)
        {
            var s = St.SiteSettings;
            if (s.Count == 0) return html;
            Func<string, string> g = k => J.S(s, k);
            string company = HtmlEscape(g("companyName").Length > 0 ? g("companyName") : "Öz Urfa Yusuf Usta");
            string slogan = HtmlEscape(g("slogan").Length > 0 ? g("slogan") : "Bursa'nın Lezzet Durağı");
            string r = Regex.Replace(html, "Öz Urfa Yusuf Usta|&Ouml;z Urfa Yusuf Usta", m => company);
            r = Regex.Replace(r, "Bursa'nın Lezzet Durağı|Bursa'n&#305;n Lezzet Dura&#287;&#305;", m => slogan);
            if (g("facebook").Length > 0) r = Regex.Replace(r, "https://www\\.facebook\\.com/[^\"']*", m => HtmlEscape(g("facebook")));
            if (g("instagram").Length > 0) r = Regex.Replace(r, "https://www\\.instagram\\.com/[^\"']*", m => HtmlEscape(g("instagram")));
            if (g("whatsapp").Length > 0) r = Regex.Replace(r, "https://wa\\.me/[0-9]+", m => "https://wa.me/" + St.WaNumber(g("whatsapp")));
            if (g("website").Length > 0)
            {
                r = r.Replace("https://ozurfayusufusta.com", HtmlEscape(g("website")).Replace("&amp;", "&"));
                string disp = HtmlEscape(Regex.Replace(Regex.Replace(g("website").Trim(), "^https?://", ""), "/+$", ""));
                if (disp.Length > 0) r = r.Replace("ozurfayusufusta.com", disp);
            }
            Func<string, string, string, string> icon = (url, bg, svg) => "<a href=\"" + HtmlEscape(url) + "\" target=\"_blank\" style=\"width:46px;height:46px;border-radius:50%;background:" + bg +
                ";display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.25);\"><svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"white\">" + svg + "</svg></a>";
            Func<string, string, string, string> repl1 = (src, marker, val) => { int i = src.IndexOf(marker, StringComparison.Ordinal); return i < 0 ? src : src.Substring(0, i) + val + src.Substring(i + marker.Length); };
            if (g("tiktok").Length > 0) r = repl1(r, "<!--SOCIAL_EXTRA_TIKTOK-->", icon(g("tiktok"), "#000", "<path d=\"M16.6 5.82c-.9-.6-1.5-1.6-1.6-2.72h-3.1v13.3c0 1.6-1.3 2.9-2.9 2.9s-2.9-1.3-2.9-2.9 1.3-2.9 2.9-2.9c.3 0 .6.05.85.13v-3.15c-.28-.04-.56-.06-.85-.06-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6V9.4c1.2.85 2.66 1.35 4.2 1.35V7.65c-.9 0-1.75-.28-2.5-.75-.4-.25-.75-.55-1.1-.9-.3-.3-.55-.65-.75-1.1z\"/>"));
            if (g("youtube").Length > 0) r = repl1(r, "<!--SOCIAL_EXTRA_YOUTUBE-->", icon(g("youtube"), "#ff0000", "<path d=\"M22 12s0-3.2-.4-4.7c-.24-.9-.94-1.6-1.84-1.84C18.05 5 12 5 12 5s-6.05 0-7.76.46c-.9.24-1.6.94-1.84 1.84C2 8.8 2 12 2 12s0 3.2.4 4.7c.24.9.94 1.6 1.84 1.84C5.95 19 12 19 12 19s6.05 0 7.76-.46c.9-.24 1.6-.94 1.84-1.84.4-1.5.4-4.7.4-4.7ZM10 15.2V8.8l5.5 3.2Z\"/>"));
            if (g("twitter").Length > 0) r = repl1(r, "<!--SOCIAL_EXTRA_TWITTER-->", icon(g("twitter"), "#000", "<path d=\"M18.9 3H21.7l-6.1 7 6.9 10.9h-5.4l-4.2-6.6-4.8 6.6H2.3l6.5-8.9L2.2 3h5.5l3.9 6.1L18.9 3Zm-1.9 16.2h1.7L7.1 4.7H5.3l11.7 14.5Z\"/>"));
            if (g("googleMaps").Length > 0) r = repl1(r, "<!--SOCIAL_EXTRA_MAPS-->", icon(g("googleMaps"), "#4285f4", "<path d=\"M12 2C7.6 2 4 5.6 4 10c0 5.4 6.8 11.2 7.4 11.7.35.3.85.3 1.2 0C13.2 21.2 20 15.4 20 10c0-4.4-3.6-8-8-8Zm0 10.8a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6Z\"/>"));
            r = Regex.Replace(r, "<!--SOCIAL_EXTRA_[A-Z]+-->", "");
            string[] th; if (!Themes.TryGetValue(g("theme"), out th)) th = Themes["mavi"];
            r = r.Replace("--brand:#3498db;", "--brand:" + th[1] + ";").Replace("--brand:#007acc;", "--brand:" + th[2] + ";");
            if (g("phone").Length > 0)
            {
                r = Regex.Replace(r, @"tel:\+?[0-9]+", m => "tel:" + Uri.EscapeDataString(Regex.Replace(g("phone"), @"\D", "")));
                r = new Regex(@"(Telefon:</strong>\s*<a[^>]*>)[^<]*", RegexOptions.IgnoreCase).Replace(r, m => m.Groups[1].Value + HtmlEscape(g("phone")), 1);
            }
            if (g("googleMaps").Length > 0) r = Regex.Replace(r, "https://www\\.google\\.com/maps/search/\\?api=1&amp;query=[^\"']*", m => HtmlEscape(g("googleMaps")));
            if (file == "iletisim.html" && g("address").Length > 0) r = r.Replace("Arabayatağı Mah. 1.Aras Sokak No:18, Yıldırım/Bursa", HtmlEscape(g("address")));
            return r;
        }
        static string RenderManifest(string text)
        {
            string name = J.S(St.SiteSettings, "companyName").Trim();
            if (name.Length == 0) return text;
            string esc = name.Replace("\\", "\\\\").Replace("\"", "\\\"");
            return text.Replace("\"Öz Urfa Yusuf Usta\"", "\"" + esc + "\"").Replace("\"Yusuf Usta\"", "\"" + esc + "\"");
        }

        // ---- statik dosyalar
        static readonly HashSet<string> AllowedExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".html", ".htm", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".css", ".webmanifest", ".json" };
        static readonly HashSet<string> DenyNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "config.json", "orders.json", "package-lock.json", ".env", ".gitignore", "upsell-rules.json", "upsell-stats.json",
            "firebase-service-account.json", "google-services.json", "customer-reviews.json", "calls.json", "package.json", "config.example.json" };
        static readonly HashSet<string> PublicJs = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "reviews-strip.js" };
        static readonly Dictionary<string, string> Types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            { ".html", "text/html; charset=utf-8" }, { ".htm", "text/html; charset=utf-8" }, { ".css", "text/css; charset=utf-8" }, { ".json", "application/json; charset=utf-8" },
            { ".webmanifest", "application/manifest+json; charset=utf-8" }, { ".png", "image/png" }, { ".jpg", "image/jpeg" }, { ".jpeg", "image/jpeg" }, { ".gif", "image/gif" },
            { ".webp", "image/webp" }, { ".svg", "image/svg+xml" }, { ".ico", "image/x-icon" }, { ".js", "text/javascript; charset=utf-8" }, { ".map", "application/json; charset=utf-8" } };
        static string TypeOf(string ext) { string t; return Types.TryGetValue(ext, out t) ? t : "application/octet-stream"; }
        static string Decode(string p) { try { return Uri.UnescapeDataString(p); } catch { return p; } }
        static bool Inside(string file, string dir) { return file.StartsWith(dir.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase); }

        static readonly Dictionary<string, string> PageMap = new Dictionary<string, string> {
            { "/", "/yeni.html" }, { "/eski", "/index.html" }, { "/siparis", "/siparis.html" }, { "/garson", "/garson.html" }, { "/iletisim", "/iletisim.html" },
            { "/index", "/yeni.html" }, { "/gizlilik-politikasi", "/gizlilik-politikasi.html" }, { "/tv", "/tv.html" }, { "/yeni", "/yeni.html" } };

        static void ServeStatic(Req req, Res res, string pathname)
        {
            string mapped; string rel = Decode(PageMap.TryGetValue(pathname, out mapped) ? mapped : pathname);
            if (Regex.IsMatch(rel, @"^/logo\.(png|jpe?g)$", RegexOptions.IgnoreCase) && !File.Exists(P(rel.TrimStart('/'))))
            {
                var alt = new[] { "/logo.png", "/logo.jpg", "/logo.jpeg" }.FirstOrDefault(n => File.Exists(P(n.TrimStart('/'))));
                if (alt != null) rel = alt;
            }
            string file;
            try { file = Path.GetFullPath(Path.Combine(Root, rel.TrimStart('/').Replace('/', '\\'))); } catch { res.Text(404, "Bulunamadı"); return; }
            string bas = Path.GetFileName(file), ext = Path.GetExtension(file).ToLowerInvariant();
            if (!Inside(file, Root) || DenyNames.Contains(bas) || bas.StartsWith(".") || !(AllowedExt.Contains(ext) || PublicJs.Contains(bas)) || !File.Exists(file))
            { res.Text(404, "Bulunamadı"); return; }
            // alt klasorlerdeki (update-backup vb.) dosyalar Node'da da sunuluyordu; yedek klasoru disari kapali
            if (file.IndexOf("\\update-backup\\", StringComparison.OrdinalIgnoreCase) >= 0) { res.Text(404, "Bulunamadı"); return; }
            string cache = ext == ".html" ? "no-store" : "public, max-age=3600";
            if (ext == ".html" && new[] { "index.html", "siparis.html", "iletisim.html", "tv.html", "yeni.html" }.Contains(bas.ToLowerInvariant()))
            {
                string o = RenderSiteHtml(bas, Files.Read(file));
                if ((bas == "index.html" || bas == "yeni.html") && !o.Contains("reviews-strip.js"))
                    o = new Regex("</body>", RegexOptions.IgnoreCase).Replace(o, "<script src=\"./reviews-strip.js\" defer></script></body>", 1);
                res.Send(200, TypeOf(ext), Encoding.UTF8.GetBytes(o), cache);
                return;
            }
            if (bas == "manifest.webmanifest") { res.Send(200, TypeOf(ext), Encoding.UTF8.GetBytes(RenderManifest(Files.Read(file))), cache); return; }
            res.Send(200, TypeOf(ext), File.ReadAllBytes(file), cache);
        }

        static readonly HashSet<string> GarsonWebExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".html", ".htm", ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".map" };
        static void ServeGarsonWeb(Res res, string sub)
        {
            string gw = P("garson-web");
            string rel = Decode(sub ?? "");
            if (rel.Length == 0 || rel == "/") rel = "/index.html";
            string file;
            try { file = Path.GetFullPath(Path.Combine(gw, rel.TrimStart('/').Replace('/', '\\'))); } catch { res.Text(404, "Bulunamadı"); return; }
            string ext = Path.GetExtension(file);
            if (!Inside(file, gw) || !GarsonWebExt.Contains(ext) || !File.Exists(file)) { res.Text(404, "Bulunamadı"); return; }
            res.Send(200, TypeOf(ext), File.ReadAllBytes(file), "no-store");
        }

        // /samba-lan -> SambaPOS Mesaj Sunucusu (127.0.0.1:9000) koprusu; akisli
        static readonly HashSet<string> HopHeaders = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "host", "connection", "content-length", "transfer-encoding", "keep-alive", "expect", "accept-encoding" };
        static void ProxySamba(Req req, Res res)
        {
            if (!IsAuthed(req)) { res.Json(401, J.Obj("error", "Giriş gerekli.")); return; }
            string sub = req.Path.Substring("/samba-lan".Length);
            if (sub.Length == 0) sub = "/";
            HttpWebResponse up;
            try
            {
                var hr = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:9000" + sub + req.Search);
                hr.Method = req.Method;
                hr.Timeout = 120000; hr.ReadWriteTimeout = 120000;
                hr.AllowAutoRedirect = false;
                hr.KeepAlive = true;
                foreach (var kv in req.Headers)
                {
                    if (HopHeaders.Contains(kv.Key)) continue;
                    try
                    {
                        if (kv.Key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)) hr.ContentType = kv.Value;
                        else if (kv.Key.Equals("Accept", StringComparison.OrdinalIgnoreCase)) hr.Accept = kv.Value;
                        else if (kv.Key.Equals("User-Agent", StringComparison.OrdinalIgnoreCase)) hr.UserAgent = kv.Value;
                        else if (kv.Key.Equals("Referer", StringComparison.OrdinalIgnoreCase)) hr.Referer = kv.Value;
                        else hr.Headers[kv.Key] = kv.Value;
                    }
                    catch { }
                }
                if (req.Body.Length > 0 || (req.Method != "GET" && req.Method != "HEAD"))
                {
                    hr.ContentLength = req.Body.Length;
                    if (req.Body.Length > 0) using (var s = hr.GetRequestStream()) s.Write(req.Body, 0, req.Body.Length);
                }
                try { up = (HttpWebResponse)hr.GetResponse(); }
                catch (WebException ex) { up = ex.Response as HttpWebResponse; if (up == null) throw; }
            }
            catch { res.Json(502, J.Obj("error", "SambaPOS mesaj sunucusuna erişilemedi.")); return; }
            res.Status = (int)up.StatusCode;
            foreach (string k in up.Headers.AllKeys)
            {
                if (HopHeaders.Contains(k)) continue;
                foreach (var v in up.Headers.GetValues(k) ?? new string[0]) res.AddHeader(k, v);
            }
            res.Handled = true;
            var upResp = up;
            res.Streamer = outStream =>
            {
                using (upResp)
                using (var s = upResp.GetResponseStream())
                {
                    var buf = new byte[16384]; int n;
                    while ((n = s.Read(buf, 0, buf.Length)) > 0) { outStream.Write(buf, 0, n); outStream.Flush(); }
                }
            };
        }
    }
}
