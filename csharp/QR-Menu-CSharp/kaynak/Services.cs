using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Printing;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace QRMenu
{
    // ------------------------------------------------------------------ Lisans (license.js karsiligi)
    public static class License
    {
        public static string CloudUrl = "https://app.ornek-alanadi.com";
        public static string ActivationKey = "";
        static bool _ok; static string _error = "Lisans henüz doğrulanmadı."; static bool _everOk;
        static Timer _check, _beat;

        public static bool IsLicensed { get { return _ok; } }
        public static string Error { get { return _error; } }

        public static void Init()
        {
            var c = Cfg.Read();
            string cu = J.S(c, "cloudServerUrl"); if (cu.Length == 0) cu = "https://app.ornek-alanadi.com";
            CloudUrl = cu.TrimEnd('/');
            ActivationKey = J.S(c, "activationKey").Trim();
            CheckOnce();
            _check = new Timer(_ => CheckOnce(), null, 30 * 60 * 1000, 30 * 60 * 1000);
            _beat = new Timer(_ => Heartbeat(), null, 0, 60 * 1000);
        }

        public static void CheckOnce()
        {
            if (ActivationKey.Length == 0) { _ok = false; _error = "Aktivasyon anahtarı yapılandırılmamış."; return; }
            try
            {
                var r = Web.Get(CloudUrl + "/api/agent/license-check?key=" + Uri.EscapeDataString(ActivationKey) + "&product=qrmenu", 10000);
                Dictionary<string, object> j;
                try { j = J.D(J.Parse(r.Text)); } catch { throw new Exception("Lisans sunucusundan geçersiz yanıt."); }
                if (j == null) throw new Exception("Lisans sunucusundan geçersiz yanıt.");
                if (J.Truthy(J.Get(j, "ok"))) { _ok = true; _error = null; _everOk = true; }
                else { _ok = false; _error = J.S(j, "error").Length > 0 ? J.S(j, "error") : "Lisans doğrulanamadı."; }
            }
            catch
            {
                if (!_everOk) { _ok = false; _error = "Lisans sunucusuna erişilemedi. İnternet bağlantınızı kontrol edin."; }
            }
        }

        static void Heartbeat()
        {
            if (ActivationKey.Length == 0) return;
            try { Web.PostJson(CloudUrl + "/api/agent/heartbeat", J.Obj("activationKey", ActivationKey, "product", "qrmenu"), 10000); } catch { }
        }

        static Dictionary<string, object> Post(string path, object payload)
        {
            if (ActivationKey.Length == 0) return J.Obj("ok", false, "error", "Aktivasyon anahtarı yapılandırılmamış.");
            try
            {
                var r = Web.PostJson(CloudUrl + path, payload, 10000);
                var j = J.D(J.Parse(r.Text));
                if (j == null) throw new Exception();
                return j;
            }
            catch { return J.Obj("ok", false, "error", "Lisans sunucusuna erişilemedi. İnternet bağlantınızı kontrol edin."); }
        }
        public static Dictionary<string, object> VerifyPassword(string identifier, string password)
        {
            return Post("/api/agent/verify-password", J.Obj("key", ActivationKey, "product", "qrmenu", "identifier", identifier, "password", password));
        }
        public static Dictionary<string, object> SetQrmenuSlug(string slug) { return Post("/api/agent/qrmenu-set-slug", J.Obj("key", ActivationKey, "slug", slug)); }
    }

    // ------------------------------------------------------------------ Otomatik guncelleme (updater.js karsiligi, C# kanali)
    // Kanal: <bulut>/qrmenu-cs-update/version.json + f/<sha256>.bin. Her dosyanin SHA-256'si dogrulanir,
    // hepsi gecerse yazilir. Program dosyasi (QRMenuSrv.exe) degistiyse calisan exe ".old" olarak
    // yeniden adlandirilir (Windows buna izin verir), yenisi yerine konur, servis kendini kapatir -
    // Windows servis kurtarma ayari (sc failure) onu yeni exe ile yeniden baslatir.
    public static class Updater
    {
        static readonly Regex SafePath = new Regex(@"^(?:[a-zA-Z0-9_-]+/)?[a-zA-Z0-9_.-]+\.(?:html|css|json|webmanifest|js|png|txt|exe)$");
        static readonly string[] Never = { "config.json", "upsell-rules.json", "upsell-stats.json", "customer-reviews.json", "index.html", "orders.json", "calls.json" };
        static int _running;
        static Timer _t;

        public static string LocalVersion()
        {
            try { string v = File.ReadAllText(Path.Combine(App.Root, "surum.txt")).Trim(); if (v.Length > 0) return v; } catch { }
            return App.Version;
        }
        static int[] Parse(string v) { return (v ?? "0").Split('.').Select(n => { int x; return int.TryParse(n, out x) ? x : 0; }).ToArray(); }
        public static bool IsNewer(string remote, string local)
        {
            var r = Parse(remote); var l = Parse(local);
            for (int i = 0; i < Math.Max(r.Length, l.Length); i++)
            {
                int rv = i < r.Length ? r[i] : 0, lv = i < l.Length ? l[i] : 0;
                if (rv != lv) return rv > lv;
            }
            return false;
        }
        static void L(string m) { Log.Write("[guncelleme] " + m); }

        public static void Start()
        {
            // onceki guncellemeden kalan eski exe
            try { foreach (var f in Directory.GetFiles(App.Root, "*.old")) File.Delete(f); } catch { }
            _t = new Timer(_ => RunCheck(), null, 5 * 60 * 1000, 60 * 60 * 1000);
        }

        public static void RunCheck()
        {
            if (Interlocked.Exchange(ref _running, 1) == 1) return;
            string staging = null;
            try
            {
                string bas = License.CloudUrl + "/qrmenu-cs-update";
                Dictionary<string, object> manifest;
                try { var r = Web.Get(bas + "/version.json?t=" + J.NowMs(), 30000); if (!r.Ok) throw new Exception("HTTP " + r.Status); manifest = J.D(J.Parse(r.Text)); }
                catch (Exception ex) { L("surum bilgisi alinamadi, atlaniyor: " + ex.Message); return; }
                if (manifest == null) return;
                string remote = J.S(manifest, "version");
                var files = J.LL(J.Get(manifest, "files")).Select(J.D).Where(f => f != null)
                    .Where(f => SafePath.IsMatch(J.S(f, "path")) && !J.S(f, "path").Contains("..") && !Never.Contains(J.S(f, "path")) && Regex.IsMatch(J.S(f, "sha256"), "^[a-f0-9]{64}$")).ToList();
                string local = LocalVersion();
                if (remote.Length == 0 || files.Count == 0) { L("manifesto bos/gecersiz, atlaniyor."); return; }
                if (!IsNewer(remote, local)) return;
                L("yeni surum: " + local + " -> " + remote + ", " + files.Count + " dosya indiriliyor...");
                staging = Path.Combine(Path.GetTempPath(), "qrmenu-update-" + Crypto.RandomHex(6));
                foreach (var f in files)
                {
                    var r = Web.Get(bas + "/f/" + J.S(f, "sha256") + ".bin", 60000);
                    if (!r.Ok) throw new Exception("HTTP " + r.Status + " (" + J.S(f, "path") + ")");
                    if (Crypto.Sha256Hex(r.Body) != J.S(f, "sha256")) throw new Exception(J.S(f, "path") + " parmak izi uyusmuyor - indirme bozuk, iptal.");
                    string dest = Path.Combine(staging, J.S(f, "path").Replace('/', '\\'));
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    File.WriteAllBytes(dest, r.Body);
                }
                foreach (var f in files) if (J.S(f, "path").EndsWith(".json")) J.Parse(Files.Read(Path.Combine(staging, J.S(f, "path").Replace('/', '\\'))));
                string backup = Path.Combine(App.Root, "update-backup", local);
                foreach (var f in files)
                {
                    string live = Path.Combine(App.Root, J.S(f, "path").Replace('/', '\\'));
                    if (File.Exists(live)) { string b = Path.Combine(backup, J.S(f, "path").Replace('/', '\\')); Directory.CreateDirectory(Path.GetDirectoryName(b)); File.Copy(live, b, true); }
                }
                string logoExt = new[] { ".png", ".jpg", ".jpeg" }.FirstOrDefault(e => File.Exists(Path.Combine(App.Root, "logo" + e)));
                bool exeChanged = false;
                string exeName = Path.GetFileName(System.Reflection.Assembly.GetExecutingAssembly().Location);
                foreach (var f in files)
                {
                    string rel = J.S(f, "path").Replace('/', '\\');
                    string live = Path.Combine(App.Root, rel), src = Path.Combine(staging, rel);
                    Directory.CreateDirectory(Path.GetDirectoryName(live));
                    if (rel.Equals(exeName, StringComparison.OrdinalIgnoreCase))
                    {
                        string old = live + ".old";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(live, old);
                        File.Copy(src, live, true);
                        exeChanged = true;
                    }
                    else if (logoExt != null && rel.EndsWith(".html"))
                        Files.Write(live, Regex.Replace(Files.Read(src), @"\./logo\.(png|jpg|jpeg)", "./logo" + logoExt));
                    else File.Copy(src, live, true);
                }
                Files.Write(Path.Combine(App.Root, "surum.txt"), remote);
                L("guncelleme basarili: " + local + " -> " + remote + (exeChanged ? ". Servis yeniden baslatiliyor..." : "."));
                if (exeChanged) { var t = new Thread(() => { Thread.Sleep(800); Environment.Exit(3); }) { IsBackground = true }; t.Start(); }
            }
            catch (Exception ex) { L("guncelleme basarisiz, MEVCUT SURUM DEGISTIRILMEDI: " + ex.Message); }
            finally
            {
                if (staging != null) { try { Directory.Delete(staging, true); } catch { } }
                Interlocked.Exchange(ref _running, 0);
            }
        }
    }

    // ------------------------------------------------------------------ Mesafe (distance.js)
    public static class Distance
    {
        public static double Haversine(double lat1, double lng1, double lat2, double lng2)
        {
            const double R = 6371;
            Func<double, double> rad = d => d * Math.PI / 180;
            double dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
            double a = Math.Pow(Math.Sin(dLat / 2), 2) + Math.Cos(rad(lat1)) * Math.Cos(rad(lat2)) * Math.Pow(Math.Sin(dLng / 2), 2);
            return R * 2 * Math.Atan2(Math.Sqrt(a), Math.Sqrt(1 - a));
        }
        public static double Km(double lat1, double lng1, double lat2, double lng2, out string method)
        {
            try
            {
                var inv = J.Inv;
                var r = Web.Get("https://router.project-osrm.org/route/v1/driving/" + lng1.ToString(inv) + "," + lat1.ToString(inv) + ";" + lng2.ToString(inv) + "," + lat2.ToString(inv) + "?overview=false", 4000);
                var routes = J.LL(J.Get(r.JsonObj(), "routes"));
                double m = routes.Count > 0 ? J.Num(J.Get(J.D(routes[0]), "distance")) : double.NaN;
                if (!J.Finite(m)) throw new Exception("Rota bulunamadı.");
                method = "road";
                return m / 1000;
            }
            catch { method = "straight"; return Haversine(lat1, lng1, lat2, lng2); }
        }
    }

    // ------------------------------------------------------------------ Gorseller (sharp yerine System.Drawing)
    public static class Images
    {
        public static byte[] Resize(byte[] input, bool png, int maxDim)
        {
            try
            {
                using (var ms = new MemoryStream(input))
                using (var src = Image.FromStream(ms))
                {
                    // EXIF yonu (telefon fotograflari)
                    try
                    {
                        if (src.PropertyIdList.Contains(0x0112))
                        {
                            int o = src.GetPropertyItem(0x0112).Value[0];
                            RotateFlipType t = o == 3 ? RotateFlipType.Rotate180FlipNone : o == 6 ? RotateFlipType.Rotate90FlipNone : o == 8 ? RotateFlipType.Rotate270FlipNone :
                                o == 2 ? RotateFlipType.RotateNoneFlipX : o == 4 ? RotateFlipType.Rotate180FlipX : o == 5 ? RotateFlipType.Rotate90FlipX : o == 7 ? RotateFlipType.Rotate270FlipX : RotateFlipType.RotateNoneFlipNone;
                            if (t != RotateFlipType.RotateNoneFlipNone) src.RotateFlip(t);
                        }
                    }
                    catch { }
                    double scale = Math.Min(1.0, Math.Min((double)maxDim / src.Width, (double)maxDim / src.Height));
                    int w = Math.Max(1, (int)Math.Round(src.Width * scale)), h = Math.Max(1, (int)Math.Round(src.Height * scale));
                    using (var bmp = new Bitmap(w, h, png ? PixelFormat.Format32bppArgb : PixelFormat.Format24bppRgb))
                    {
                        using (var g = Graphics.FromImage(bmp))
                        {
                            if (!png) g.Clear(Color.White);
                            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            g.SmoothingMode = SmoothingMode.HighQuality;
                            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                            g.DrawImage(src, 0, 0, w, h);
                        }
                        using (var outMs = new MemoryStream())
                        {
                            if (png) bmp.Save(outMs, ImageFormat.Png);
                            else
                            {
                                var enc = ImageCodecInfo.GetImageEncoders().First(e => e.FormatID == ImageFormat.Jpeg.Guid);
                                var ps = new EncoderParameters(1);
                                ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 82L);
                                bmp.Save(outMs, enc, ps);
                            }
                            return outMs.ToArray();
                        }
                    }
                }
            }
            catch (Exception ex) { Log.Write("Görsel küçültme hatası (orijinal kullanılıyor): " + ex.Message); return input; }
        }
    }

    // ------------------------------------------------------------------ Mutfak yazicisi (PowerShell yerine dogrudan System.Drawing.Printing)
    public static class Printing
    {
        public static List<string> InstalledPrinters()
        {
            var l = new List<string>();
            try { foreach (string p in PrinterSettings.InstalledPrinters) l.Add(p); } catch { }
            return l;
        }

        public static void Print(string printer, List<string> titleLines, List<string> bodyLines)
        {
            var t = new Thread(() =>
            {
                try
                {
                    using (var doc = new PrintDocument())
                    using (var titleFont = new Font("Consolas", 20, FontStyle.Bold))
                    using (var bodyFont = new Font("Consolas", 16, FontStyle.Bold))
                    {
                        doc.PrinterSettings.PrinterName = printer;
                        doc.DefaultPageSettings.Margins = new Margins(6, 6, 6, 6);
                        doc.PrintController = new StandardPrintController();
                        doc.PrintPage += (s, e) =>
                        {
                            float y = e.MarginBounds.Top;
                            foreach (var l in titleLines) { e.Graphics.DrawString(l, titleFont, Brushes.Black, e.MarginBounds.Left, y); y += titleFont.GetHeight(e.Graphics) + 4; }
                            y += 6;
                            foreach (var l in bodyLines) { e.Graphics.DrawString(l, bodyFont, Brushes.Black, e.MarginBounds.Left, y); y += bodyFont.GetHeight(e.Graphics) + 3; }
                        };
                        doc.Print();
                    }
                }
                catch (Exception ex) { Log.Write("Mutfak yazdırma hatası (" + printer + "): " + ex.Message); }
            }) { IsBackground = true };
            t.Start();
        }
    }

    // ------------------------------------------------------------------ Garson APK push bildirimi (firebase-admin yerine FCM HTTP v1)
    public static class Push
    {
        static string _token; static DateTime _tokenExp;
        static readonly object _lock = new object();

        public static void SendGarson(Dictionary<string, object> call)
        {
            string keyPath = Path.Combine(App.Root, "firebase-service-account.json");
            if (!File.Exists(keyPath)) return;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    var sa = J.ParseObj(Files.Read(keyPath));
                    string token = AccessToken(sa);
                    string project = J.S(sa, "project_id");
                    var msg = J.Obj("message", J.Obj(
                        "topic", "garson_calls",
                        "notification", J.Obj("title", "🛎️ " + J.S(call, "table"), "body", J.S(call, "label")),
                        "data", J.Obj("table", J.S(call, "table"), "label", J.S(call, "label"), "type", J.S(call, "type")),
                        "android", J.Obj("priority", "high", "notification", J.Obj("sound", "default", "channel_id", "garson_calls"))));
                    var r = Web.PostJson("https://fcm.googleapis.com/v1/projects/" + project + "/messages:send", msg, 15000,
                        new Dictionary<string, string> { { "Authorization", "Bearer " + token } });
                    if (!r.Ok) Log.Write("Push gönderilemedi: HTTP " + r.Status + " " + J.Clip(r.Text, 200));
                }
                catch (Exception ex) { Log.Write("Push gönderilemedi: " + ex.Message); }
            });
        }

        static string AccessToken(Dictionary<string, object> sa)
        {
            lock (_lock)
            {
                if (_token != null && _tokenExp > DateTime.UtcNow.AddMinutes(2)) return _token;
                long now = J.NowMs() / 1000;
                string header = Crypto.B64Url(Encoding.UTF8.GetBytes("{\"alg\":\"RS256\",\"typ\":\"JWT\"}"));
                string claims = Crypto.B64Url(Encoding.UTF8.GetBytes(J.Str(J.Obj("iss", J.S(sa, "client_email"), "scope", "https://www.googleapis.com/auth/firebase.messaging",
                    "aud", "https://oauth2.googleapis.com/token", "iat", now, "exp", now + 3600))));
                string unsigned = header + "." + claims;
                byte[] sig;
                using (var rsa = Pem.RsaFromPkcs8(J.S(sa, "private_key")))
                using (var sha = new SHA256Managed())
                    sig = rsa.SignData(Encoding.UTF8.GetBytes(unsigned), sha);
                string jwt = unsigned + "." + Crypto.B64Url(sig);
                var r = Web.Request("POST", "https://oauth2.googleapis.com/token", "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt,
                    new Dictionary<string, string> { { "Content-Type", "application/x-www-form-urlencoded" } }, 15000);
                var j = r.JsonObj();
                _token = J.S(j, "access_token");
                if (_token.Length == 0) throw new Exception("Firebase erişim anahtarı alınamadı: " + J.Clip(r.Text, 200));
                _tokenExp = DateTime.UtcNow.AddSeconds(J.NumOr(J.Get(j, "expires_in"), 3600));
                return _token;
            }
        }
    }

    // PKCS#8 "-----BEGIN PRIVATE KEY-----" -> RSACryptoServiceProvider (.NET 4'te hazir ayrıştırıcı yok)
    public static class Pem
    {
        public static RSACryptoServiceProvider RsaFromPkcs8(string pem)
        {
            string b64 = Regex.Replace(pem.Replace("\\n", "\n"), "-----[^-]+-----|\\s", "");
            var der = Convert.FromBase64String(b64);
            int p = 0;
            Seq(der, ref p);                 // PrivateKeyInfo
            Skip(der, ref p);                // version
            Skip(der, ref p);                // algorithm
            if (der[p++] != 0x04) throw new Exception("Geçersiz anahtar.");
            Len(der, ref p);                 // OCTET STRING -> RSAPrivateKey
            Seq(der, ref p);
            Skip(der, ref p);                // version
            var prm = new RSAParameters { Modulus = Int(der, ref p), Exponent = Int(der, ref p), D = Int(der, ref p), P = Int(der, ref p), Q = Int(der, ref p), DP = Int(der, ref p), DQ = Int(der, ref p), InverseQ = Int(der, ref p) };
            int size = prm.Modulus.Length;
            prm.D = Pad(prm.D, size); prm.P = Pad(prm.P, size / 2); prm.Q = Pad(prm.Q, size / 2); prm.DP = Pad(prm.DP, size / 2); prm.DQ = Pad(prm.DQ, size / 2); prm.InverseQ = Pad(prm.InverseQ, size / 2);
            var rsa = new RSACryptoServiceProvider(new CspParameters { ProviderType = 24 });
            rsa.ImportParameters(prm);
            return rsa;
        }
        static int Len(byte[] d, ref int p)
        {
            int b = d[p++];
            if (b < 0x80) return b;
            int n = b & 0x7F, len = 0;
            for (int i = 0; i < n; i++) len = (len << 8) | d[p++];
            return len;
        }
        static void Seq(byte[] d, ref int p) { if (d[p++] != 0x30) throw new Exception("Geçersiz anahtar."); Len(d, ref p); }
        static void Skip(byte[] d, ref int p) { p++; int l = Len(d, ref p); p += l; }
        static byte[] Int(byte[] d, ref int p)
        {
            if (d[p++] != 0x02) throw new Exception("Geçersiz anahtar.");
            int l = Len(d, ref p);
            var v = new byte[l]; Array.Copy(d, p, v, 0, l); p += l;
            int z = 0; while (z < v.Length - 1 && v[z] == 0) z++;
            return z > 0 ? v.Skip(z).ToArray() : v;
        }
        static byte[] Pad(byte[] v, int size) { if (v.Length >= size) return v; var r = new byte[size]; Array.Copy(v, 0, r, size - v.Length, v.Length); return r; }
    }

    // ------------------------------------------------------------------ Yapay zeka (EVREN / Groq / Gemini)
    public class AiException : Exception
    {
        public string Code; public int Status;
        public AiException(string msg, string code = "", int status = 0) : base(msg) { Code = code; Status = status; }
    }

    public static class Ai
    {
        public static bool KeyLooksValid(string provider, string key)
        {
            key = key ?? "";
            return provider == "evren" ? key.StartsWith("evren_llm_") : provider == "groq" ? key.StartsWith("gsk_") : provider == "gemini" ? key.StartsWith("AIza") : false;
        }

        static string ErrMsg(Dictionary<string, object> j, string fallback)
        {
            var e = J.Get(j, "error");
            var ed = J.D(e);
            if (ed != null) { string m = J.S(ed, "message"); return m.Length > 0 ? m : fallback; }
            return e != null && J.S(e).Length > 0 ? J.S(e) : fallback;
        }

        public static string Complete(string provider, string key, string system, string prompt, double temperature = 0.9, int maxTokens = 1500)
        {
            if (!J.Finite(temperature)) temperature = 0.9;
            maxTokens = Math.Min(4000, maxTokens > 0 ? maxTokens : 1500);
            var auth = new Dictionary<string, string> { { "Authorization", "Bearer " + key } };
            if (provider == "evren")
            {
                Func<string, string> call = model =>
                {
                    var msgs = new List<object>();
                    if (!string.IsNullOrEmpty(system)) msgs.Add(J.Obj("role", "system", "content", system));
                    msgs.Add(J.Obj("role", "user", "content", prompt));
                    var r = Web.PostJson("https://evren-llmapi.ssyz.org.tr/v1/chat/completions", J.Obj("model", model, "temperature", temperature, "max_tokens", maxTokens, "messages", msgs), 60000, auth);
                    var j = r.JsonObj();
                    if (!r.Ok)
                    {
                        var ed = J.D(J.Get(j, "error"));
                        if (ed != null && J.S(ed, "code") == "terms_not_accepted") throw new AiException("EVREN kullanım şartları henüz onaylanmamış. Panelde şartları okuyup onaylayın.", "EVREN_TERMS", 403);
                        throw new AiException(ErrMsg(j, "Evren " + r.Status), "", r.Status);
                    }
                    return FirstChoice(j);
                };
                try { return call("auto"); }
                catch (AiException e)
                {
                    if (e.Code == "EVREN_TERMS") throw;
                    if (e.Status == 401) throw new AiException("Evren anahtarı geçersiz (401). Anahtar iptal edilmiş ya da yanlış olabilir; AI Araçları'ndaki çalışan anahtar kullanılır.");
                    return call("glm-5.3");
                }
            }
            if (provider == "gemini")
            {
                var r = Web.PostJson("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + Uri.EscapeDataString(key),
                    J.Obj("systemInstruction", J.Obj("parts", new List<object> { J.Obj("text", system) }), "contents", new List<object> { J.Obj("parts", new List<object> { J.Obj("text", prompt) }) },
                        "generationConfig", J.Obj("temperature", 0.9, "maxOutputTokens", 1500, "responseMimeType", "application/json")), 45000);
                var j = r.JsonObj();
                if (!r.Ok) throw new AiException(ErrMsg(j, "Gemini " + r.Status));
                var cands = J.LL(J.Get(j, "candidates"));
                var parts = cands.Count > 0 ? J.LL(J.Get(J.DD(J.Get(J.DD(cands[0]), "content")), "parts")) : new List<object>();
                return parts.Count > 0 ? J.S(J.DD(parts[0]), "text") : "";
            }
            {
                var r = Web.PostJson("https://api.groq.com/openai/v1/chat/completions", J.Obj("model", "openai/gpt-oss-120b", "temperature", 0.9, "max_tokens", 1500,
                    "response_format", J.Obj("type", "json_object"), "messages", new List<object> { J.Obj("role", "system", "content", system), J.Obj("role", "user", "content", prompt) }), 45000, auth);
                var j = r.JsonObj();
                if (!r.Ok) throw new AiException(ErrMsg(j, "Groq " + r.Status));
                return FirstChoice(j);
            }
        }
        static string FirstChoice(Dictionary<string, object> j)
        {
            var ch = J.LL(J.Get(j, "choices"));
            return ch.Count > 0 ? J.S(J.DD(J.Get(J.DD(ch[0]), "message")), "content") : "";
        }
        // ai-complete: JSON bulunamazsa metin OLDUGU GIBI doner (Node ile ayni)
        public static string ExtractJsonStrict(string raw)
        {
            string s = Regex.Replace(raw ?? "", "```(json)?", "");
            int a = s.IndexOf('{'), b = s.LastIndexOf('}');
            return a >= 0 && b > a ? s.Substring(a, b - a + 1) : raw;
        }
        public static string ExtractJson(string raw)
        {
            string s = Regex.Replace(raw ?? "", "```(json)?", "");
            int a = s.IndexOf('{'), b = s.LastIndexOf('}');
            return a >= 0 && b > a ? s.Substring(a, b - a + 1) : s;
        }
    }
}
