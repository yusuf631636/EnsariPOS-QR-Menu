using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;

namespace QRMenu
{
    // config.json uzerindeki tum okuma/yazma kurallari (server.js'deki read*/write* fonksiyonlari)
    public static class St
    {
        static Dictionary<string, object> C { get { return Cfg.Read(); } }
        static void Set(string key, object v) { Cfg.Update(c => c[key] = v); }

        // ---- basit bayraklar
        public static bool DirectOrderSend { get { return J.IsTrue(C, "directOrderSend"); } set { Set("directOrderSend", value); } }
        public static bool KioskDirectSend { get { return !J.IsFalse(J.Get(C, "kioskDirectOrderSend")); } set { Set("kioskDirectOrderSend", value); } }
        public static bool RemoteGarsonAllowed { get { return J.IsTrue(C, "remoteGarsonAllowed"); } set { Set("remoteGarsonAllowed", value); } }
        public static bool KioskEnabled { get { return J.IsTrue(C, "kioskEnabled"); } set { Set("kioskEnabled", value); } }
        public static bool KioskA11yEnabled { get { return !J.IsFalse(J.Get(C, "kioskA11yEnabled")); } set { Set("kioskA11yEnabled", value); } }
        public static bool TvMenuEnabled { get { return J.IsTrue(C, "tvMenuEnabled"); } set { Set("tvMenuEnabled", value); } }
        public static bool WhatsappOrderEnabled { get { return !J.IsFalse(J.Get(C, "whatsappOrderEnabled")); } set { Set("whatsappOrderEnabled", value); } }
        public static string WaiterAppKey { get { return J.S(C, "waiterAppKey"); } }

        public static long? IdSetting(string key)
        {
            var v = J.Get(C, key);
            if (!J.Truthy(v)) return null;
            double n = J.Num(v);
            return J.Finite(n) ? (long?)(long)n : null;
        }
        public static void SetId(string key, object v) { Set(key, J.Truthy(v) && J.Finite(J.Num(v)) ? (object)J.NumVal(J.Num(v)) : null); }
        public static long? SambaposMenuId { get { return IdSetting("sambaposMenuId"); } }
        public static long? OrderTagGroupId { get { return IdSetting("orderTagGroupId"); } }

        public static List<string> AdminEmails
        {
            get
            {
                var l = J.L(J.Get(C, "adminEmails"));
                return l == null ? new List<string>() : l.Select(e => J.LowerTr(J.S(e).Trim())).Where(e => e.Length > 0).ToList();
            }
        }

        // ---- kategori->yazici
        public static Dictionary<string, object> KitchenPrinter
        {
            get
            {
                var p = J.D(J.Get(C, "kitchenPrinter"));
                var map = J.D(J.Get(p, "categoryMap")) ?? new Dictionary<string, object>();
                return J.Obj("enabled", J.IsTrue(p, "enabled"), "name", J.S(p, "name"), "autoRoute", p == null || !J.IsFalse(J.Get(p, "autoRoute")), "categoryMap", map);
            }
        }
        public static Dictionary<string, object> WriteKitchenPrinter(Dictionary<string, object> input)
        {
            var map = new Dictionary<string, object>();
            var im = J.D(J.Get(input, "categoryMap"));
            if (im != null) foreach (var kv in im) { string pr = J.Clip(J.S(kv.Value).Trim(), 120); if (pr.Length > 0) map[J.Clip(kv.Key.Trim(), 120)] = pr; }
            var v = J.Obj("enabled", J.IsTrue(input, "enabled"), "name", J.Clip(J.S(input, "name").Trim(), 120), "autoRoute", !J.IsFalse(J.Get(input, "autoRoute")), "categoryMap", map);
            Set("kitchenPrinter", v);
            return v;
        }

        // ---- teslimat
        public static List<object> DeliveryZones { get { return J.L(J.Get(C, "deliveryZones")) ?? new List<object>(); } set { Set("deliveryZones", value); } }

        public class DeliverySettings { public double? Lat, Lng; public List<Dictionary<string, object>> Tiers = new List<Dictionary<string, object>>(); public bool LocationRequired; public string FeeMenuItemName = ""; public bool HasLocation { get { return Lat.HasValue; } } }
        public static DeliverySettings Delivery
        {
            get
            {
                var ds = J.D(J.Get(C, "deliveryDistance"));
                var r = new DeliverySettings();
                if (ds == null) return r;
                var bl = J.D(J.Get(ds, "businessLocation"));
                if (bl != null && J.Truthy(J.Get(bl, "lat")) && J.Truthy(J.Get(bl, "lng"))) { r.Lat = J.Num(bl, "lat"); r.Lng = J.Num(bl, "lng"); }
                r.Tiers = (J.L(J.Get(ds, "tiers")) ?? new List<object>()).Select(J.DD).ToList();
                r.LocationRequired = J.IsTrue(ds, "locationRequired");
                r.FeeMenuItemName = J.S(ds, "feeMenuItemName");
                return r;
            }
        }
        public static Dictionary<string, object> DeliveryJson(DeliverySettings d)
        {
            return J.Obj("businessLocation", d.HasLocation ? J.Obj("lat", J.NumVal(d.Lat.Value), "lng", J.NumVal(d.Lng.Value)) : null,
                "tiers", d.Tiers.Cast<object>().ToList(), "locationRequired", d.LocationRequired, "feeMenuItemName", d.FeeMenuItemName);
        }
        public static Dictionary<string, object> WriteDelivery(Dictionary<string, object> input)
        {
            var bl = J.D(J.Get(input, "businessLocation"));
            double lat = J.Num(J.Get(bl, "lat")), lng = J.Num(J.Get(bl, "lng"));
            var tiers = (J.L(J.Get(input, "tiers")) ?? new List<object>()).Select(J.DD).Select(t => J.Obj(
                "maxKm", J.NumVal(Math.Max(0, J.NumOr(J.Get(t, "maxKm"), 0))), "fee", J.NumVal(Math.Max(0, J.NumOr(J.Get(t, "fee"), 0))), "label", J.Clip(J.S(t, "label").Trim(), 60)))
                .Where(t => J.Num(t["maxKm"]) > 0).OrderBy(t => J.Num(t["maxKm"])).Take(20).Cast<object>().ToList();
            var v = J.Obj("businessLocation", (J.Finite(lat) && J.Finite(lng) && lat != 0 && lng != 0) ? J.Obj("lat", J.NumVal(lat), "lng", J.NumVal(lng)) : null,
                "tiers", tiers, "locationRequired", J.IsTrue(input, "locationRequired"), "feeMenuItemName", J.Clip(J.S(input, "feeMenuItemName").Trim(), 120));
            Set("deliveryDistance", v);
            return v;
        }
        public static Dictionary<string, object> MatchTier(double km, List<Dictionary<string, object>> tiers)
        {
            foreach (var t in tiers) if (km <= J.Num(t, "maxKm")) return t;
            return null;
        }

        public static Dictionary<string, object> OrderAcceptance
        {
            get { var a = J.D(J.Get(C, "orderAcceptance")); return J.Obj("delivery", !J.IsFalse(J.Get(a, "delivery")), "table", !J.IsFalse(J.Get(a, "table")), "pickup", !J.IsFalse(J.Get(a, "pickup"))); }
        }
        public static Dictionary<string, object> WriteOrderAcceptance(Dictionary<string, object> i)
        {
            var v = J.Obj("delivery", !J.IsFalse(J.Get(i, "delivery")), "table", !J.IsFalse(J.Get(i, "table")), "pickup", !J.IsFalse(J.Get(i, "pickup")));
            Set("orderAcceptance", v);
            return v;
        }

        // ---- kampanyalar
        public static List<object> Campaigns { get { return J.L(J.Get(C, "campaigns")) ?? new List<object>(); } }
        public static List<object> WriteCampaigns(List<object> campaigns)
        {
            var list = (campaigns ?? new List<object>()).Take(20).Select(J.DD).Select(camp => J.Obj(
                "title", J.Clip(J.S(camp, "title"), 80),
                "tag", J.Clip(J.Truthy(J.Get(camp, "tag")) ? J.S(camp, "tag") : "Bugünün Fırsatı", 40),
                "oldPrice", J.Clip(J.S(camp, "oldPrice"), 20), "newPrice", J.Clip(J.S(camp, "newPrice"), 20), "imageUrl", J.Clip(J.S(camp, "imageUrl"), 200),
                "items", (J.L(J.Get(camp, "items")) ?? new List<object>()).Take(10).Select(J.DD)
                    .Select(i => J.Obj("name", J.Clip(J.S(i, "name"), 80), "qty", (long)Math.Max(1, Math.Min(99, J.NumOr(J.Get(i, "qty"), 1)))))
                    .Where(i => J.S(i["name"]).Length > 0).Cast<object>().ToList()))
                .Where(c => J.S(c["title"]).Length > 0).Cast<object>().ToList();
            Set("campaigns", list);
            return list;
        }

        // ---- TV muzigi
        static readonly Regex YtId = new Regex("^[a-zA-Z0-9_-]{11}$");
        public static string ExtractYoutubeId(string input)
        {
            string v = (input ?? "").Trim();
            if (YtId.IsMatch(v)) return v;
            foreach (var re in new[] { @"[?&]v=([a-zA-Z0-9_-]{11})", @"youtu\.be/([a-zA-Z0-9_-]{11})", @"youtube\.com/(?:embed|live|shorts)/([a-zA-Z0-9_-]{11})" })
            { var m = Regex.Match(v, re); if (m.Success) return m.Groups[1].Value; }
            return null;
        }
        public static Dictionary<string, object> TvMusic
        {
            get
            {
                var c = C;
                string id = J.S(c, "tvMusicYoutubeId");
                var vol = J.Get(c, "tvMusicVolume");
                return J.Obj("enabled", J.IsTrue(c, "tvMusicEnabled") && id.Length > 0, "youtubeId", id.Length > 0 ? id : null, "volume", J.IsNum(vol) ? J.NumVal(J.Num(vol)) : 50L);
            }
        }
        public static void WriteTvMusic(Dictionary<string, object> body)
        {
            Cfg.Update(c =>
            {
                if (J.Has(body, "youtubeUrl") && J.Get(body, "youtubeUrl") != null)
                {
                    string id = ExtractYoutubeId(J.S(body, "youtubeUrl"));
                    if (id == null) throw new Exception("Geçersiz YouTube linki.");
                    c["tvMusicYoutubeId"] = id;
                }
                if (J.Has(body, "enabled") && J.Get(body, "enabled") != null) c["tvMusicEnabled"] = J.IsTrue(body, "enabled");
                if (J.Has(body, "volume") && J.Get(body, "volume") != null) c["tvMusicVolume"] = J.NumVal(Math.Max(0, Math.Min(100, J.NumOr(J.Get(body, "volume"), 0))));
            });
        }

        // ---- TV ekstralari
        static readonly Regex Hhmm = new Regex("^([01]\\d|2[0-3]):[0-5]\\d$");
        static bool IsHhmm(object v) { return v is string && Hhmm.IsMatch((string)v); }
        public static string Clip(object v, int max) { return J.Clip(Regex.Replace(J.S(v), "[\\x00-\\x1f]", " ").Trim(), max); }

        public static Dictionary<string, object> TvExtras
        {
            get
            {
                var x = J.DD(J.Get(C, "tvExtras"));
                var cp = J.DD(J.Get(x, "campaign")); var rv = J.DD(J.Get(x, "reviews")); var ez = J.D(J.Get(x, "ezan")); var nt = J.D(J.Get(x, "notes"));
                int[] allowed = { 2, 3, 4, 6 };
                double ih = J.Num(J.Get(nt, "intervalHours"));
                return J.Obj(
                    "refreshAt", J.NumVal(J.NumOr(J.Get(x, "refreshAt"), 0)),
                    "pinCategory", Clip(J.Get(x, "pinCategory"), 120),
                    "night", J.IsTrue(x, "night"),
                    "offEnabled", J.IsTrue(x, "offEnabled"),
                    "offFrom", IsHhmm(J.Get(x, "offFrom")) ? J.Get(x, "offFrom") : "23:30",
                    "offTo", IsHhmm(J.Get(x, "offTo")) ? J.Get(x, "offTo") : "10:00",
                    "campaign", J.Obj("enabled", J.IsTrue(cp, "enabled"), "title", Clip(J.Get(cp, "title"), 80), "text", Clip(J.Get(cp, "text"), 200), "price", Clip(J.Get(cp, "price"), 20),
                        "itemName", Clip(J.Get(cp, "itemName"), 120), "from", IsHhmm(J.Get(cp, "from")) ? J.Get(cp, "from") : "00:00", "until", IsHhmm(J.Get(cp, "until")) ? J.Get(cp, "until") : "14:00"),
                    "ezan", J.Obj("enabled", ez != null && J.IsTrue(ez, "enabled"), "city", ez != null && IlKoord.ContainsKey(J.S(ez, "city")) ? J.S(ez, "city") : "",
                        "minutes", (long)Math.Max(1, Math.Min(20, Math.Round(J.NumOr(J.Get(ez, "minutes"), 5))))),
                    "notes", J.Obj("enabled", nt != null && J.IsTrue(nt, "enabled"), "intervalHours", (long)(allowed.Contains((int)ih) && ih == Math.Floor(ih) ? ih : 3),
                        "items", (J.L(J.Get(nt, "items")) ?? new List<object>()).Select(t => (object)Clip(t, 160)).Where(t => ((string)t).Length > 0).Take(40).ToList()),
                    "reviews", J.Obj("enabled", J.IsTrue(rv, "enabled"), "rating", J.NumVal(Math.Max(0, Math.Min(5, J.NumOr(J.Get(rv, "rating"), 0)))),
                        "count", (long)Math.Max(0, Math.Floor(J.NumOr(J.Get(rv, "count"), 0))),
                        "items", (J.L(J.Get(rv, "items")) ?? new List<object>()).Take(15).Select(J.D).Select(r => J.Obj("name", Clip(J.Get(r, "name"), 40), "text", Clip(J.Get(r, "text"), 220)))
                            .Where(r => ((string)r["text"]).Length > 0).Cast<object>().ToList()));
            }
        }
        public static Dictionary<string, object> WriteTvExtras(Dictionary<string, object> patch)
        {
            var cur = TvExtras;
            var next = new Dictionary<string, object>(cur);
            foreach (var k in new[] { "pinCategory", "night", "offEnabled", "offFrom", "offTo" }) if (J.Has(patch, k)) next[k] = patch[k];
            foreach (var k in new[] { "campaign", "reviews", "notes" })
            {
                var p = J.D(J.Get(patch, k));
                if (p != null) next[k] = J.Assign(new Dictionary<string, object>(J.DD(cur[k])), p);
            }
            var pe = J.D(J.Get(patch, "ezan"));
            if (pe != null)
            {
                if (J.Truthy(J.Get(pe, "city")) && !IlKoord.ContainsKey(J.S(pe, "city"))) throw new Exception("Geçersiz il.");
                next["ezan"] = J.Assign(new Dictionary<string, object>(J.DD(cur["ezan"])), pe);
            }
            if (J.IsTrue(patch, "refresh")) next["refreshAt"] = J.NowMs();
            if ((J.Has(patch, "offFrom") && !IsHhmm(patch["offFrom"])) || (J.Has(patch, "offTo") && !IsHhmm(patch["offTo"]))) throw new Exception("Saat SS:DD biçiminde olmalı (örn. 23:30).");
            var pc = J.D(J.Get(patch, "campaign"));
            if (pc != null && ((J.Truthy(J.Get(pc, "from")) && !IsHhmm(pc["from"])) || (J.Truthy(J.Get(pc, "until")) && !IsHhmm(pc["until"])))) throw new Exception("Kampanya saatleri SS:DD biçiminde olmalı.");
            Set("tvExtras", next);
            return TvExtras;
        }

        // ---- ezan vakitleri
        public static readonly Dictionary<string, double[]> IlKoord = new Dictionary<string, double[]> {
            {"Adana",new[]{37.00,35.32}},{"Adıyaman",new[]{37.76,38.28}},{"Afyonkarahisar",new[]{38.76,30.54}},{"Ağrı",new[]{39.72,43.05}},{"Aksaray",new[]{38.37,34.03}},
            {"Amasya",new[]{40.65,35.83}},{"Ankara",new[]{39.93,32.86}},{"Antalya",new[]{36.89,30.71}},{"Ardahan",new[]{41.11,42.70}},{"Artvin",new[]{41.18,41.82}},
            {"Aydın",new[]{37.84,27.84}},{"Balıkesir",new[]{39.65,27.89}},{"Bartın",new[]{41.64,32.34}},{"Batman",new[]{37.88,41.13}},{"Bayburt",new[]{40.26,40.23}},
            {"Bilecik",new[]{40.14,29.98}},{"Bingöl",new[]{38.88,40.50}},{"Bitlis",new[]{38.40,42.11}},{"Bolu",new[]{40.74,31.61}},{"Burdur",new[]{37.72,30.29}},
            {"Bursa",new[]{40.19,29.06}},{"Çanakkale",new[]{40.15,26.41}},{"Çankırı",new[]{40.60,33.62}},{"Çorum",new[]{40.55,34.95}},{"Denizli",new[]{37.78,29.09}},
            {"Diyarbakır",new[]{37.91,40.24}},{"Düzce",new[]{40.84,31.16}},{"Edirne",new[]{41.68,26.56}},{"Elazığ",new[]{38.68,39.22}},{"Erzincan",new[]{39.75,39.49}},
            {"Erzurum",new[]{39.90,41.27}},{"Eskişehir",new[]{39.78,30.52}},{"Gaziantep",new[]{37.07,37.38}},{"Giresun",new[]{40.91,38.39}},{"Gümüşhane",new[]{40.46,39.48}},
            {"Hakkari",new[]{37.58,43.74}},{"Hatay",new[]{36.20,36.16}},{"Iğdır",new[]{39.92,44.05}},{"Isparta",new[]{37.76,30.55}},{"İstanbul",new[]{41.01,28.98}},
            {"İzmir",new[]{38.42,27.14}},{"Kahramanmaraş",new[]{37.58,36.94}},{"Karabük",new[]{41.20,32.62}},{"Karaman",new[]{37.18,33.22}},{"Kars",new[]{40.60,43.10}},
            {"Kastamonu",new[]{41.38,33.78}},{"Kayseri",new[]{38.73,35.49}},{"Kilis",new[]{36.72,37.12}},{"Kırıkkale",new[]{39.85,33.51}},{"Kırklareli",new[]{41.73,27.22}},
            {"Kırşehir",new[]{39.15,34.16}},{"Kocaeli",new[]{40.77,29.92}},{"Konya",new[]{37.87,32.48}},{"Kütahya",new[]{39.42,29.98}},{"Malatya",new[]{38.36,38.31}},
            {"Manisa",new[]{38.61,27.43}},{"Mardin",new[]{37.31,40.74}},{"Mersin",new[]{36.81,34.64}},{"Muğla",new[]{37.22,28.36}},{"Muş",new[]{38.75,41.51}},
            {"Nevşehir",new[]{38.62,34.71}},{"Niğde",new[]{37.97,34.68}},{"Ordu",new[]{40.98,37.88}},{"Osmaniye",new[]{37.07,36.25}},{"Rize",new[]{41.02,40.52}},
            {"Sakarya",new[]{40.78,30.40}},{"Samsun",new[]{41.29,36.33}},{"Siirt",new[]{37.93,41.94}},{"Sinop",new[]{42.03,35.15}},{"Sivas",new[]{39.75,37.02}},
            {"Şanlıurfa",new[]{37.16,38.80}},{"Şırnak",new[]{37.52,42.46}},{"Tekirdağ",new[]{40.98,27.51}},{"Tokat",new[]{40.31,36.55}},{"Trabzon",new[]{41.00,39.72}},
            {"Tunceli",new[]{39.11,39.55}},{"Uşak",new[]{38.68,29.41}},{"Van",new[]{38.49,43.38}},{"Yalova",new[]{40.65,29.27}},{"Yozgat",new[]{39.82,34.81}},
            {"Zonguldak",new[]{41.45,31.79}} };

        static readonly object _ezanLock = new object();
        static string Hhmm2(string s) { var m = Regex.Match(s ?? "", @"(\d{1,2}):(\d{2})"); return m.Success ? m.Groups[1].Value.PadLeft(2, '0') + ":" + m.Groups[2].Value : null; }
        public static List<object> EzanTimesToday()
        {
            var ez = J.DD(TvExtras["ezan"]);
            string city = J.S(ez, "city");
            if (!J.IsTrue(ez, "enabled") || city.Length == 0) return new List<object>();
            var d = DateTime.Now;
            string ym = d.Year + "-" + d.Month;
            Func<Dictionary<string, object>> cacheOf = () => J.D(J.Get(C, "ezanCache"));
            var cache = cacheOf();
            if (cache == null || J.S(cache, "city") != city || J.S(cache, "ym") != ym)
            {
                lock (_ezanLock)
                {
                    cache = cacheOf();
                    if (cache == null || J.S(cache, "city") != city || J.S(cache, "ym") != ym)
                    {
                        try
                        {
                            var ll = IlKoord[city];
                            var r = Web.Get("https://api.aladhan.com/v1/calendar/" + d.Year + "/" + d.Month + "?latitude=" + ll[0].ToString(J.Inv) + "&longitude=" + ll[1].ToString(J.Inv) + "&method=13", 15000);
                            var days = new Dictionary<string, object>();
                            foreach (var x in J.LL(J.Get(r.JsonObj(), "data")).Select(J.DD))
                            {
                                double day = J.Num(J.Get(J.DD(J.Get(J.DD(J.Get(x, "date")), "gregorian")), "day"));
                                var t = J.DD(J.Get(x, "timings"));
                                if (J.Finite(day) && day > 0)
                                    days[J.NumStr(day)] = new[] { "Fajr", "Dhuhr", "Asr", "Maghrib", "Isha" }.Select(k => Hhmm2(J.S(t, k))).Where(v => v != null).Cast<object>().ToList();
                            }
                            if (days.Count > 0)
                            {
                                Cfg.Update(c => c["ezanCache"] = J.Obj("city", city, "ym", ym, "days", days));
                                Log.Write("[ezan] " + city + " " + ym + " vakitleri alindi");
                            }
                        }
                        catch (Exception ex) { Log.Write("[ezan] vakitler alinamadi: " + ex.Message); }
                        cache = cacheOf();
                    }
                }
            }
            if (cache != null && J.S(cache, "city") == city && J.S(cache, "ym") == ym)
            {
                var v = J.L(J.Get(J.DD(J.Get(cache, "days")), d.Day.ToString()));
                if (v != null) return v;
            }
            return new List<object>();
        }

        // ---- Sefin notu yapay zeka
        public static Dictionary<string, object> NotesAi
        {
            get
            {
                var a = J.DD(J.Get(C, "notesAi"));
                string p = J.S(a, "provider");
                return J.Obj("enabled", J.IsTrue(a, "enabled"), "provider", new[] { "evren", "groq", "gemini" }.Contains(p) ? p : "evren", "key", J.S(a, "key"),
                    "lastRunAt", J.NumVal(J.NumOr(J.Get(a, "lastRunAt"), 0)), "lastError", J.S(a, "lastError"));
            }
        }
        public static void WriteNotesAi(Dictionary<string, object> patch) { Cfg.Update(c => c["notesAi"] = J.Assign(new Dictionary<string, object>(J.DD(J.Get(c, "notesAi"))), patch)); }

        static int _notesRunning;
        public static List<object> GenerateChefNotes(string overrideProvider, string overrideKey)
        {
            var saved = NotesAi;
            string provider = J.S(saved, "provider"), key = J.S(saved, "key");
            if (!string.IsNullOrEmpty(overrideKey) && Ai.KeyLooksValid(overrideProvider, overrideKey)) { provider = overrideProvider; key = overrideKey; }
            if (key.Length == 0) throw new Exception("Yapay zeka anahtarı yok. \"✨ AI Araçları\" sekmesinde anahtarı kaydedin ya da burada girin.");
            if (Interlocked.Exchange(ref _notesRunning, 1) == 1) throw new Exception("Zaten yazılıyor, birkaç saniye bekleyin.");
            try
            {
                var cats = App.MenuWithSiteData("table");
                string lines = string.Join("\n", cats.Select(c => J.S(c, "name") + ": " + string.Join(", ", J.LL(J.Get(c, "items")).Select(J.DD)
                    .Select(i => J.S(i, "name") + (J.S(i, "description").Length > 0 ? " (" + J.Clip(J.S(i, "description"), 70) + ")" : "")))));
                lines = J.Clip(lines, 6000);
                if (lines.Length == 0) throw new Exception("Menü okunamadı (SambaPOS bağlantısını kontrol edin).");
                string company = J.S(SiteSettings, "companyName");
                string system = "Sen bir Türk restoranının şefisin. Restoranın TV ekranındaki kayan bantta \"Şefin notu\" başlığıyla gösterilecek kısa, samimi, iştah açıcı tavsiyeler yazarsın. " +
                    "KURALLAR: Sadece sana verilen menüdeki ürünlerden bahset, menüde olmayan ürün uydurma. Fiyat yazma. \"En çok satan\", \"ödüllü\", \"herkes bayılıyor\", \"müşterilerimiz diyor ki\" gibi doğrulanamayan iddialar ve müşteri yorumu taklidi YAZMA. " +
                    "Her not en fazla 110 karakter, en fazla 1 emoji. Türkçe yaz.";
                string prompt = "Restoran: " + (company.Length > 0 ? company : "restoranımız") + "\nMenü:\n" + lines + "\n\n12 farklı şef notu yaz: 4'ü sabah-öğle, 4'ü öğleden sonra, 4'ü akşam için uygun olsun; farklı ürünlerden bahset. " +
                    "SADECE şu biçimde JSON döndür: {\"notes\":[\"...\",\"...\"]}";
                string raw = Ai.Complete(provider, key, system, prompt);
                List<object> notes;
                try { notes = J.LL(J.Get(J.D(J.Parse(Ai.ExtractJson(raw))), "notes")); } catch { throw new Exception("Yapay zeka cevabı okunamadı, tekrar deneyin."); }
                notes = notes.Select(t => (object)Clip(t, 160)).Where(t => ((string)t).Length > 5).Take(20).ToList();
                if (notes.Count < 3) throw new Exception("Yapay zeka yeterli not yazmadı, tekrar deneyin.");
                WriteTvExtras(J.Obj("notes", J.Obj("items", notes)));
                WriteNotesAi(J.Obj("lastRunAt", J.NowMs(), "lastError", "", "provider", provider, "key", key));
                Log.Write("[sefin-notu] yapay zeka " + notes.Count + " not yazdi (" + provider + ")");
                return notes;
            }
            catch (Exception e) { WriteNotesAi(J.Obj("lastError", e.Message, "lastRunAt", J.NowMs())); throw; }
            finally { Interlocked.Exchange(ref _notesRunning, 0); }
        }

        // ---- Google yorumlari
        public static Dictionary<string, object> GoogleCfg
        {
            get
            {
                var g = J.DD(J.Get(C, "googleReviews"));
                return J.Obj("apiKey", J.S(g, "apiKey"), "placeId", J.S(g, "placeId"), "placeName", J.S(g, "placeName"), "lastFetchAt", J.NumVal(J.NumOr(J.Get(g, "lastFetchAt"), 0)),
                    "lastError", J.S(g, "lastError"), "rating", J.NumVal(J.NumOr(J.Get(g, "rating"), 0)), "count", J.NumVal(J.NumOr(J.Get(g, "count"), 0)),
                    "items", J.L(J.Get(g, "items")) ?? new List<object>(), "menuEnabled", !J.IsFalse(J.Get(g, "menuEnabled")));
            }
        }
        public static void WriteGoogleCfg(Dictionary<string, object> patch) { Cfg.Update(c => c["googleReviews"] = J.Assign(new Dictionary<string, object>(J.DD(J.Get(c, "googleReviews"))), patch)); }
        public static string WriteReviewUrl()
        {
            string pid = J.S(GoogleCfg, "placeId");
            if (pid.Length > 0) return "https://search.google.com/local/writereview?placeid=" + Uri.EscapeDataString(pid);
            return J.S(SiteSettings, "googleMaps");
        }
        static Dictionary<string, object> GoogleFetch(string method, string url, object body, string fieldMask)
        {
            string key = J.S(GoogleCfg, "apiKey");
            if (key.Length == 0) throw new Exception("Google API anahtarı girilmemiş.");
            var h = new Dictionary<string, string> { { "X-Goog-Api-Key", key }, { "X-Goog-FieldMask", fieldMask }, { "Content-Type", "application/json" } };
            var r = Web.Request(method, url, body == null ? null : J.Str(body), h, 15000);
            var j = r.JsonObj();
            if (!r.Ok) { var e = J.D(J.Get(j, "error")); throw new Exception(e != null && J.S(e, "message").Length > 0 ? J.S(e, "message") : "Google HTTP " + r.Status); }
            return j;
        }
        public static List<object> SearchGooglePlace(string query)
        {
            var j = GoogleFetch("POST", "https://places.googleapis.com/v1/places:searchText", J.Obj("textQuery", J.Clip(query, 200), "languageCode", "tr"),
                "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount");
            return J.LL(J.Get(j, "places")).Take(8).Select(J.DD).Select(p => (object)J.Obj("placeId", J.S(p, "id"), "name", J.S(J.DD(J.Get(p, "displayName")), "text"),
                "address", J.S(p, "formattedAddress"), "rating", J.NumVal(J.NumOr(J.Get(p, "rating"), 0)), "count", J.NumVal(J.NumOr(J.Get(p, "userRatingCount"), 0)))).ToList();
        }
        static int _gFetching;
        public static Dictionary<string, object> RefreshGoogleReviews()
        {
            var g = GoogleCfg;
            if (J.S(g, "apiKey").Length == 0 || J.S(g, "placeId").Length == 0 || Interlocked.Exchange(ref _gFetching, 1) == 1) return g;
            try
            {
                var j = GoogleFetch("GET", "https://places.googleapis.com/v1/places/" + Uri.EscapeDataString(J.S(g, "placeId")) + "?languageCode=tr", null, "rating,userRatingCount,reviews");
                var items = J.LL(J.Get(j, "reviews")).Select(J.DD).Select(r => J.Obj(
                    "name", Clip(J.Get(J.DD(J.Get(r, "authorAttribution")), "displayName"), 40),
                    "text", Clip(J.S(J.DD(J.Get(r, "text")), "text").Length > 0 ? J.S(J.DD(J.Get(r, "text")), "text") : J.S(J.DD(J.Get(r, "originalText")), "text"), 300),
                    "rating", J.NumVal(J.NumOr(J.Get(r, "rating"), 0)), "when", Clip(J.Get(r, "relativePublishTimeDescription"), 40)))
                    .Where(r => ((string)r["text"]).Length > 0).Cast<object>().ToList();
                WriteGoogleCfg(J.Obj("rating", J.NumVal(J.NumOr(J.Get(j, "rating"), 0)), "count", J.NumVal(J.NumOr(J.Get(j, "userRatingCount"), 0)), "items", items, "lastFetchAt", J.NowMs(), "lastError", ""));
                Log.Write("[google-yorum] " + items.Count + " yorum alindi");
            }
            catch (Exception e) { WriteGoogleCfg(J.Obj("lastError", e.Message, "lastFetchAt", J.NowMs())); Log.Write("[google-yorum] alinamadi: " + e.Message); }
            finally { Interlocked.Exchange(ref _gFetching, 0); }
            return GoogleCfg;
        }

        // ---- musteri degerlendirmeleri + yorum havuzu
        public static string FeedbackPath { get { return Path.Combine(App.Root, "customer-reviews.json"); } }
        static readonly object _fbLock = new object();
        public static List<object> ReadFeedback() { return Files.ReadJsonArray(FeedbackPath); }
        public static void WriteFeedback(List<object> list)
        {
            lock (_fbLock) Files.WriteAtomic(FeedbackPath, J.Pretty1(Files.TakeLast(list, 500)));
        }
        public const long RotateMs = 4L * 60 * 60 * 1000;
        public static Dictionary<string, object> ReviewPool()
        {
            var g = GoogleCfg;
            var manual = J.DD(TvExtras["reviews"]);
            double manualRating = J.Num(manual, "rating");
            var pool = new List<object>();
            pool.AddRange(J.LL(g["items"]).Select(J.DD).Where(r => J.Num(r, "rating") >= 4).Select(r => (object)J.Obj("name", J.Get(r, "name"), "text", J.Get(r, "text"), "rating", J.Get(r, "rating"), "source", "google")));
            pool.AddRange(ReadFeedback().Select(J.DD).Where(f => J.Truthy(J.Get(f, "consent")) && !J.Truthy(J.Get(f, "hidden")) && J.Num(f, "rating") >= 4 && J.Truthy(J.Get(f, "text")))
                .Select(f => (object)J.Obj("name", J.Truthy(J.Get(f, "name")) ? J.Get(f, "name") : "Misafirimiz", "text", J.Get(f, "text"), "rating", J.Get(f, "rating"), "source", "musteri")));
            pool.AddRange(J.LL(manual["items"]).Select(J.DD).Select(r => (object)J.Obj("name", J.Get(r, "name"), "text", J.Get(r, "text"),
                "rating", manualRating >= 4 ? J.NumVal(Math.Round(manualRating, MidpointRounding.AwayFromZero)) : 5L, "source", "manuel")));
            long bucket = J.NowMs() / RotateMs;
            long seed = bucket % 2147483647; if (seed == 0) seed = 1;
            Func<double> rnd = () => { seed = seed * 16807 % 2147483647; return seed / 2147483647.0; };
            for (int i = pool.Count - 1; i > 0; i--) { int k = (int)Math.Floor(rnd() * (i + 1)); var t = pool[i]; pool[i] = pool[k]; pool[k] = t; }
            bool useGoogle = J.Num(g["rating"]) > 0;
            return J.Obj("rating", useGoogle ? g["rating"] : manual["rating"], "count", useGoogle ? g["count"] : manual["count"], "source", useGoogle ? "google" : "manuel", "items", pool.Take(10).ToList());
        }

        // ---- WhatsApp numarasi
        public static string WaNumber(string raw)
        {
            string d = Regex.Replace(raw ?? "", @"\D", "");
            if (d.StartsWith("00")) d = d.Substring(2);
            if (d.Length == 11 && d.StartsWith("0")) d = "90" + d.Substring(1);
            else if (d.Length == 10 && d.StartsWith("5")) d = "90" + d;
            return d;
        }

        // ---- site ayarlari / veritabani
        public static readonly string[] SiteKeys = { "companyName", "slogan", "phone", "address", "website", "facebook", "instagram", "whatsapp", "tiktok", "youtube", "twitter", "googleMaps", "domain", "appDomain", "theme", "workingHours" };
        public static Dictionary<string, object> SiteSettings { get { return J.D(J.Get(C, "siteSettings")) ?? new Dictionary<string, object>(); } }
        public static Dictionary<string, object> WriteSiteSettings(Dictionary<string, object> input)
        {
            var v = new Dictionary<string, object>();
            foreach (var k in SiteKeys) v[k] = J.Clip(J.S(input, k).Trim(), 300);
            Set("siteSettings", v);
            return v;
        }
        public static Dictionary<string, object> DatabaseSettings
        {
            get { var c = Cfg.ReadStrict(); return J.Obj("server", J.S(c, "server"), "database", J.S(c, "database"), "user", J.S(c, "user"), "hasPassword", J.S(c, "password").Length > 0, "sqlcmdPath", J.S(c, "sqlcmdPath")); }
        }
        public static Dictionary<string, object> WriteDatabaseSettings(Dictionary<string, object> input)
        {
            Cfg.Update(c =>
            {
                if (J.Truthy(J.Get(input, "server"))) c["server"] = J.Clip(J.S(input, "server").Trim(), 150);
                if (J.Truthy(J.Get(input, "database"))) c["database"] = J.Clip(J.S(input, "database").Trim(), 150);
                if (J.Truthy(J.Get(input, "user"))) c["user"] = J.Clip(J.S(input, "user").Trim(), 150);
                c["sqlcmdPath"] = J.Clip(J.S(input, "sqlcmdPath").Trim(), 300);
                if (J.Truthy(J.Get(input, "password"))) c["password"] = J.Clip(J.S(input, "password"), 300);
            });
            Db.Reset();
            return DatabaseSettings;
        }
        public static List<object> DetectSambaposDb()
        {
            var srcs = new[] { new[] { "AlfaPOS", @"C:\ProgramData\AlfaPOS\AlfaPOS5\AlfaSettings.txt" }, new[] { "SambaPOS", @"C:\ProgramData\SAMBAPOS\SambaPOS5\SambaSettings.txt" } };
            return srcs.Select(s =>
            {
                var o = J.Obj("label", s[0], "file", s[1]);
                try
                {
                    if (!File.Exists(s[1])) { o["found"] = false; return (object)o; }
                    var m = Regex.Match(File.ReadAllText(s[1]), @"<ConnectionString>([\s\S]*?)</ConnectionString>");
                    if (!m.Success) { o["found"] = false; return o; }
                    var p = Db.ParseConn(m.Groups[1].Value);
                    Func<string, string> g = k => { string v; return p.TryGetValue(k, out v) ? v : ""; };
                    if (g("server").Length == 0 && g("database").Length == 0) { o["found"] = false; return o; }
                    o["found"] = true; o["server"] = g("server"); o["database"] = g("database"); o["user"] = g("user"); o["password"] = g("password");
                }
                catch (Exception ex) { o["found"] = false; o["error"] = ex.Message; }
                return o;
            }).ToList();
        }
    }
}
