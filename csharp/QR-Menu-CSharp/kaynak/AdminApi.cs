using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace QRMenu
{
    public static partial class App
    {
        static int? IntOrNull(object v)
        {
            if (!(J.IsNum(v))) return null;
            double d = J.Num(v);
            return d == Math.Floor(d) ? (int?)(int)d : null;
        }
        static List<string> Badges(Dictionary<string, object> body)
        {
            var l = J.L(J.Get(body, "badges"));
            return l == null ? null : l.Select(J.S).Where(b => b == "featured" || b == "new" || b == "discount").ToList();
        }

        // res.Handled kalmazsa (bilinmeyen /api/admin/ ucu) statik sunucuya duser (Node'daki gibi 404)
        static void AdminApi(Req req, Res res, string path, bool GET, bool POST)
        {
            // Node'da /api/admin/me, login uclari vb. zaten yukarida islendi.
            bool authed = IsAuthed(req);
            Action need = () => res.Json(403, NeedLogin);

            switch (path)
            {
                case "/api/admin/campaigns":
                    if (!authed) { need(); return; }
                    if (GET) { res.Json(200, J.Obj("campaigns", St.Campaigns)); return; }
                    if (POST)
                    {
                        try
                        {
                            var body = req.JsonBody();
                            HashSet<string> real;
                            try { real = new HashSet<string>(Samba.LiveMenu(St.SambaposMenuId, null).SelectMany(c => c.Items).Select(i => J.LowerTr(i.Name.Trim()))); }
                            catch { real = new HashSet<string>(); }
                            var warnings = new List<object>();
                            var cleaned = (J.L(J.Get(body, "campaigns")) ?? new List<object>()).Select(J.DD).Select(camp =>
                            {
                                var items = (J.L(J.Get(camp, "items")) ?? new List<object>()).Select(J.DD).Where(it =>
                                {
                                    bool ok = J.Truthy(J.Get(it, "name")) && real.Contains(J.LowerTr(J.S(it, "name").Trim()));
                                    if (!ok && J.Truthy(J.Get(it, "name"))) warnings.Add("\"" + J.S(it, "name") + "\" (" + J.S(camp, "title") + ") menüde bulunamadı, çıkarıldı");
                                    return ok;
                                }).Cast<object>().ToList();
                                var c2 = new Dictionary<string, object>(camp); c2["items"] = items;
                                return (object)c2;
                            }).ToList();
                            res.Json(200, J.Obj("ok", true, "campaigns", St.WriteCampaigns(cleaned), "warnings", warnings));
                        }
                        catch (Exception e) { res.Json(400, Err(e.Message)); }
                        return;
                    }
                    break;
                case "/api/admin/campaign-image":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var body = req.JsonBody(12 * 1024 * 1024);
                        if (!J.Truthy(J.Get(body, "dataUrl"))) { res.Json(400, Err("Görsel eksik.")); return; }
                        res.Json(200, J.Obj("ok", true, "imageUrl", "./" + SaveDataUrlImage("kampanya-" + J.NowMs(), J.S(body, "dataUrl"))));
                    }
                    catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
                case "/api/admin/whatsapp-order":
                    if (!authed) { need(); return; }
                    if (GET) { res.Json(200, J.Obj("enabled", St.WhatsappOrderEnabled)); return; }
                    if (POST) { try { St.WhatsappOrderEnabled = J.IsTrue(req.JsonBody(), "enabled"); res.Json(200, J.Obj("ok", true, "enabled", St.WhatsappOrderEnabled)); } catch (Exception e) { res.Json(400, Err(e.Message)); } return; }
                    break;
                case "/api/admin/order-acceptance":
                    if (!authed) { need(); return; }
                    if (GET) { res.Json(200, St.OrderAcceptance); return; }
                    if (POST) { try { var r = St.WriteOrderAcceptance(req.JsonBody()); var o = J.Obj("ok", true); J.Assign(o, r); res.Json(200, o); } catch (Exception e) { res.Json(400, Err(e.Message)); } return; }
                    break;
                case "/api/admin/kitchen-printer":
                    if (!authed) { need(); return; }
                    if (GET)
                    {
                        var printers = Printing.InstalledPrinters();
                        var categories = new List<object>(); var suggested = new Dictionary<string, object>();
                        try
                        {
                            categories = Samba.LiveMenu(St.SambaposMenuId, null).Select(c => (object)c.Name).ToList();
                            foreach (var kv in Samba.GetKitchenPrinterRouting().ByCategory) suggested[kv.Key] = kv.Value;
                        }
                        catch (Exception e) { Log.Write("Kategori listesi alınamadı: " + e.Message); }
                        var o = new Dictionary<string, object>(St.KitchenPrinter);
                        o["availablePrinters"] = printers.Cast<object>().ToList(); o["categories"] = categories; o["sambaSuggested"] = suggested;
                        res.Json(200, o);
                        return;
                    }
                    if (POST) { try { var o = J.Obj("ok", true); J.Assign(o, St.WriteKitchenPrinter(req.JsonBody())); res.Json(200, o); } catch (Exception e) { res.Json(400, Err(e.Message)); } return; }
                    break;
                case "/api/admin/kitchen-printer/test":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    PrintOrderToKitchen(J.Obj("type", "table", "tableNumber", "TEST", "customerName", "Test Yazdırma", "items", new List<object> { J.Obj("name", "TEST ÜRÜNÜ", "quantity", 1) }, "total", 0, "note", "Bu bir test çıktısıdır."), 0);
                    res.Json(200, J.Obj("ok", true));
                    return;
                case "/api/admin/db-detect":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    res.Json(200, J.Obj("sources", St.DetectSambaposDb()));
                    return;
                case "/api/admin/delivery-distance":
                    if (!authed) { need(); return; }
                    if (GET) { res.Json(200, St.DeliveryJson(St.Delivery)); return; }
                    if (POST) { try { var o = J.Obj("ok", true); J.Assign(o, St.WriteDelivery(req.JsonBody())); res.Json(200, o); } catch (Exception e) { res.Json(400, Err(e.Message)); } return; }
                    break;
                case "/api/admin/delivery-zones":
                    if (!authed) { need(); return; }
                    if (GET) { res.Json(200, J.Obj("zones", St.DeliveryZones)); return; }
                    if (POST)
                    {
                        try
                        {
                            var zl = J.L(J.Get(req.JsonBody(), "zones"));
                            var zones = zl == null ? new List<object>() : zl.Select(z => (object)J.S(z).Trim()).Where(z => ((string)z).Length > 0).Take(50).ToList();
                            St.DeliveryZones = zones;
                            res.Json(200, J.Obj("ok", true, "zones", zones));
                        }
                        catch (Exception e) { res.Json(400, Err(e.Message)); }
                        return;
                    }
                    break;
                case "/api/admin/pages":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    res.Json(200, J.Obj("pages", EditablePagesOrder.SelectMany(p => p == "siparis.html" ? new object[] { p, "kiosk" } : new object[] { p }).ToList()));
                    return;
                case "/api/admin/page":
                    if (!authed) { need(); return; }
                    if (GET)
                    {
                        try
                        {
                            string name = req.Q("file") ?? "", real = PageAlias(name);
                            if (!EditablePages.Contains(real)) throw new Exception("Bu dosya düzenlenemez.");
                            res.Json(200, J.Obj("file", name, "content", Files.Read(P(real.Replace('/', '\\')))));
                        }
                        catch (Exception e) { res.Json(400, Err(e.Message)); }
                        return;
                    }
                    if (POST)
                    {
                        try
                        {
                            var body = req.JsonBody(3 * 1024 * 1024);
                            string real = PageAlias(J.S(body, "file"));
                            if (!EditablePages.Contains(real)) throw new Exception("Bu dosya düzenlenemez.");
                            var content = J.Get(body, "content") as string;
                            if (content == null || content.Trim().Length == 0) throw new Exception("İçerik boş olamaz.");
                            string file = P(real.Replace('/', '\\'));
                            try { File.Copy(file, file + ".bak", true); } catch { }
                            Files.Write(file, content);
                            res.Json(200, J.Obj("ok", true));
                        }
                        catch (Exception e) { res.Json(400, Err(e.Message)); }
                        return;
                    }
                    break;
                case "/api/admin/upload-logo":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try { res.Json(200, J.Obj("ok", true, "ext", SaveLogo(J.S(req.JsonBody(12 * 1024 * 1024), "dataUrl")))); }
                    catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
                case "/api/admin/waiter-calls":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    res.Json(200, J.Obj("calls", Reverse(ReadCalls().Where(c => J.S(J.D(c), "status") == "pending"))));
                    return;
                case "/api/admin/site-info":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    { var info = Tunnel.SiteInfo; res.Json(200, J.Obj("slug", info != null ? info["slug"] : null, "menuBaseUrl", info != null ? info["menuBaseUrl"] : null)); }
                    return;
                case "/api/admin/qrmenu-slug":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var r = License.SetQrmenuSlug(J.S(req.JsonBody(), "slug"));
                        if (!J.Truthy(J.Get(r, "ok"))) { res.Json(400, Err(J.S(r, "error").Length > 0 ? J.S(r, "error") : "Bağlantı adı değiştirilemedi.")); return; }
                        Tunnel.UpdateSlug(J.S(r, "slug"));
                        res.Json(200, J.Obj("ok", true, "slug", J.Get(r, "slug"), "menuBaseUrl", "https://menu.ornek-alanadi.com/" + J.S(r, "slug")));
                    }
                    catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
                case "/api/admin/order-mode":
                    if (!authed) { need(); return; }
                    if (GET) { res.Json(200, J.Obj("directOrderSend", St.DirectOrderSend, "kioskDirectOrderSend", St.KioskDirectSend)); return; }
                    if (POST)
                    {
                        try
                        {
                            var b = req.JsonBody();
                            if (J.Has(b, "directOrderSend")) St.DirectOrderSend = J.IsTrue(b, "directOrderSend");
                            if (J.Has(b, "kioskDirectOrderSend")) St.KioskDirectSend = J.IsTrue(b, "kioskDirectOrderSend");
                            res.Json(200, J.Obj("ok", true, "directOrderSend", St.DirectOrderSend, "kioskDirectOrderSend", St.KioskDirectSend));
                        }
                        catch (Exception e) { res.Json(400, Err(e.Message)); }
                        return;
                    }
                    break;
                case "/api/admin/order-tag-groups":
                    if (!authed) { need(); return; }
                    if (GET) { try { res.Json(200, J.Obj("groups", Samba.GetOrderTagGroups().Select(g => (object)Samba.TagGroupJson(g)).ToList(), "selectedGroupId", St.OrderTagGroupId)); } catch (Exception e) { res.Json(500, Err(e.Message)); } return; }
                    if (POST) { try { var b = req.JsonBody(); St.SetId("orderTagGroupId", J.Get(b, "groupId")); res.Json(200, J.Obj("ok", true, "selectedGroupId", St.OrderTagGroupId)); } catch (Exception e) { res.Json(400, Err(e.Message)); } return; }
                    break;
                case "/api/admin/remote-garson":
                    if (GET) { if (!authed) { need(); return; } res.Json(200, J.Obj("remoteGarsonAllowed", St.RemoteGarsonAllowed)); return; }
                    if (POST)
                    {
                        var s = CurrentSession(req);
                        if (s == null || J.S(s, "role") != "admin") { res.Json(403, Err("Sadece patron/admin bu ayarı değiştirebilir.")); return; }
                        try { St.RemoteGarsonAllowed = J.IsTrue(req.JsonBody(), "remoteGarsonAllowed"); res.Json(200, J.Obj("ok", true, "remoteGarsonAllowed", St.RemoteGarsonAllowed)); }
                        catch (Exception e) { res.Json(400, Err(e.Message)); }
                        return;
                    }
                    break;
                case "/api/admin/kiosk-tv":
                    if (!authed) { need(); return; }
                    if (POST)
                    {
                        try
                        {
                            var b = req.JsonBody();
                            if (J.Has(b, "kioskEnabled")) St.KioskEnabled = J.IsTrue(b, "kioskEnabled");
                            if (J.Has(b, "tvMenuEnabled")) St.TvMenuEnabled = J.IsTrue(b, "tvMenuEnabled");
                            if (J.Has(b, "kioskA11yEnabled")) St.KioskA11yEnabled = J.IsTrue(b, "kioskA11yEnabled");
                        }
                        catch (Exception e) { res.Json(400, Err(e.Message)); return; }
                        res.Json(200, J.Obj("ok", true, "kioskEnabled", St.KioskEnabled, "kioskA11yEnabled", St.KioskA11yEnabled, "tvMenuEnabled", St.TvMenuEnabled));
                        return;
                    }
                    if (GET) { res.Json(200, J.Obj("kioskEnabled", St.KioskEnabled, "kioskA11yEnabled", St.KioskA11yEnabled, "tvMenuEnabled", St.TvMenuEnabled)); return; }
                    break;
                case "/api/admin/notes-ai":
                    if (!authed) { need(); return; }
                    if (GET)
                    {
                        var a = St.NotesAi;
                        string prov = J.S(a, "provider"), key = J.S(a, "key");
                        if (key.Length > 0 && !Ai.KeyLooksValid(prov, key)) { St.WriteNotesAi(J.Obj("key", "")); key = ""; }
                        res.Json(200, J.Obj("enabled", a["enabled"], "provider", prov, "hasKey", key.Length > 0, "keyValid", Ai.KeyLooksValid(prov, key), "lastRunAt", a["lastRunAt"], "lastError", a["lastError"]));
                        return;
                    }
                    if (POST)
                    {
                        var b = req.JsonBody();
                        var patch = new Dictionary<string, object>();
                        if (J.Get(b, "enabled") is bool) patch["enabled"] = J.Get(b, "enabled");
                        string bp = J.S(b, "provider");
                        if (bp == "evren" || bp == "groq" || bp == "gemini") patch["provider"] = bp;
                        var bk = J.Get(b, "key") as string;
                        if (bk != null && bk.Trim().Length > 0)
                        {
                            string prov = patch.ContainsKey("provider") ? (string)patch["provider"] : J.S(St.NotesAi, "provider");
                            if (!Ai.KeyLooksValid(prov, bk.Trim())) { res.Json(400, Err(prov == "evren" ? "Bu bir EVREN anahtarı değil (evren_llm_ ile başlamalı). Tarayıcı kutuya şifrenizi doldurmuş olabilir." : "Anahtar seçilen sağlayıcıya ait görünmüyor.")); return; }
                            patch["key"] = J.Clip(bk.Trim(), 200);
                        }
                        St.WriteNotesAi(patch);
                        res.Json(200, J.Obj("ok", true));
                        return;
                    }
                    break;
                case "/api/admin/ai-complete":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    {
                        var b = req.JsonBody(200000);
                        var saved = St.NotesAi;
                        var bk = J.Get(b, "key") as string;
                        string key = (bk != null && bk.Trim().Length > 0) ? bk.Trim() : (J.S(saved, "provider") == "evren" ? J.S(saved, "key") : "");
                        if (key.Length == 0) { res.Json(400, Err("EVREN anahtarı girilmemiş (AI Araçları ya da Şefin Notu bölümünden kaydedin).")); return; }
                        try
                        {
                            string text = Ai.Complete("evren", key, J.Clip(J.S(b, "system"), 4000), J.Clip(J.S(b, "prompt"), 60000), J.Num(b, "temperature"), (int)J.NumOr(J.Get(b, "maxTokens"), 1500));
                            if (J.Truthy(J.Get(b, "json"))) text = Ai.ExtractJsonStrict(text);
                            res.Json(200, J.Obj("text", text));
                        }
                        catch (AiException e) { res.Json(400, J.Obj("error", e.Message, "code", e.Code ?? "")); }
                        catch (Exception e) { res.Json(400, J.Obj("error", e.Message, "code", "")); }
                    }
                    return;
                case "/api/admin/evren-terms":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    {
                        var b = req.JsonBody();
                        var saved = St.NotesAi;
                        var bk = J.Get(b, "key") as string;
                        string key = (bk != null && bk.Trim().StartsWith("evren_llm_")) ? bk.Trim() : (J.S(saved, "provider") == "evren" ? J.S(saved, "key") : "");
                        if (key.Length == 0) { res.Json(400, Err("EVREN anahtarı yok.")); return; }
                        var H = new Dictionary<string, string> { { "Authorization", "Bearer " + key } };
                        try
                        {
                            if (J.S(b, "action") == "accept")
                            {
                                long version = (long)Math.Max(1, Math.Floor(J.NumOr(J.Get(b, "version"), 1)));
                                var r = Web.PostJson("https://evren-llmapi.ssyz.org.tr/v1/terms/accept", J.Obj("version", version), 20000, H);
                                var j = r.JsonObj();
                                if (!r.Ok) { var ed = J.D(J.Get(j, "error")); res.Json(400, Err(ed != null && J.S(ed, "message").Length > 0 ? J.S(ed, "message") : "EVREN " + r.Status)); return; }
                                Log.Write("[evren] kullanim sartlari v" + version + " panelden kullanici tarafindan onaylandi");
                                res.Json(200, J.Obj("ok", true));
                                return;
                            }
                            var r2 = Web.Request("GET", "https://evren-llmapi.ssyz.org.tr/v1/terms/text", null, H, 20000);
                            var j2 = r2.JsonObj();
                            if (!r2.Ok) { var ed = J.D(J.Get(j2, "error")); res.Json(400, Err(ed != null && J.S(ed, "message").Length > 0 ? J.S(ed, "message") : "EVREN " + r2.Status)); return; }
                            res.Json(200, J.Obj("version", J.Truthy(J.Get(j2, "version")) ? J.Get(j2, "version") : 1, "content", J.Clip(J.S(j2, "content"), 30000)));
                        }
                        catch (Exception e) { res.Json(400, Err(e.Message)); }
                    }
                    return;
                case "/api/admin/notes-ai/run":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    {
                        var b = req.JsonBody();
                        var bk = J.Get(b, "key") as string;
                        try { res.Json(200, J.Obj("ok", true, "notes", St.GenerateChefNotes(J.S(b, "provider"), bk != null ? bk.Trim() : ""))); }
                        catch (AiException e) { res.Json(400, J.Obj("error", e.Message, "code", e.Code ?? "")); }
                        catch (Exception e) { res.Json(400, J.Obj("error", e.Message, "code", "")); }
                    }
                    return;
                case "/api/admin/google-reviews":
                    if (!authed) { need(); return; }
                    if (GET)
                    {
                        var g = St.GoogleCfg; var items = J.LL(g["items"]);
                        res.Json(200, J.Obj("hasKey", J.S(g, "apiKey").Length > 0, "placeId", g["placeId"], "placeName", g["placeName"], "lastFetchAt", g["lastFetchAt"], "lastError", g["lastError"],
                            "rating", g["rating"], "count", g["count"], "fetched", items.Count, "positive", items.Count(r => J.Num(J.D(r), "rating") >= 4), "menuEnabled", g["menuEnabled"]));
                        return;
                    }
                    if (POST)
                    {
                        var b = req.JsonBody();
                        var patch = new Dictionary<string, object>();
                        var ak = J.Get(b, "apiKey") as string;
                        if (ak != null && ak.Trim().Length > 0) patch["apiKey"] = J.Clip(ak.Trim(), 200);
                        if (J.IsTrue(b, "removeKey")) { patch["apiKey"] = ""; patch["items"] = new List<object>(); patch["rating"] = 0; patch["count"] = 0; }
                        var pid = J.Get(b, "placeId") as string;
                        if (pid != null) { patch["placeId"] = J.Clip(pid.Trim(), 200); patch["placeName"] = St.Clip(J.Get(b, "placeName"), 120); }
                        if (J.Get(b, "menuEnabled") is bool) patch["menuEnabled"] = J.Get(b, "menuEnabled");
                        St.WriteGoogleCfg(patch);
                        if (J.Truthy(J.Get(patch, "placeId")) || J.Truthy(J.Get(patch, "apiKey"))) St.RefreshGoogleReviews();
                        res.Json(200, J.Obj("ok", true));
                        return;
                    }
                    break;
                case "/api/admin/google-reviews/search":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try { res.Json(200, J.Obj("places", St.SearchGooglePlace(J.S(req.JsonBody(), "query")))); } catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
                case "/api/admin/google-reviews/fetch":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    {
                        var g = St.RefreshGoogleReviews();
                        if (J.S(g, "lastError").Length > 0) res.Json(400, Err(J.S(g, "lastError")));
                        else res.Json(200, J.Obj("ok", true, "fetched", J.LL(g["items"]).Count, "rating", g["rating"], "count", g["count"]));
                    }
                    return;
                case "/api/admin/feedback":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    res.Json(200, J.Obj("items", Reverse(Files.TakeLast(St.ReadFeedback(), 100))));
                    return;
                case "/api/admin/feedback/hide":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    {
                        var b = req.JsonBody();
                        var list = St.ReadFeedback();
                        var f = list.Select(J.D).FirstOrDefault(x => x != null && J.S(x, "id") == J.S(b, "id") && J.Get(b, "id") != null);
                        if (f == null) { res.Json(404, Err("Bulunamadı.")); return; }
                        f["hidden"] = J.IsTrue(b, "hidden");
                        St.WriteFeedback(list);
                        res.Json(200, J.Obj("ok", true));
                    }
                    return;
                case "/api/admin/tv-extras":
                    if (!authed) { need(); return; }
                    if (GET) { res.Json(200, St.TvExtras); return; }
                    if (POST) { try { res.Json(200, St.WriteTvExtras(req.JsonBody())); } catch (Exception e) { res.Json(400, Err(e.Message)); } return; }
                    break;
                case "/api/admin/tv-music":
                    if (!authed) { need(); return; }
                    if (GET) { res.Json(200, St.TvMusic); return; }
                    if (POST) { try { St.WriteTvMusic(req.JsonBody()); res.Json(200, St.TvMusic); } catch (Exception e) { res.Json(400, Err(e.Message)); } return; }
                    break;
                case "/api/admin/tv-music/remove":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    Cfg.Update(c => { c.Remove("tvMusicYoutubeId"); c["tvMusicEnabled"] = false; });
                    res.Json(200, St.TvMusic);
                    return;
                case "/api/admin/site-settings":
                    if (!authed) { need(); return; }
                    if (GET)
                    {
                        var themes = Themes.ToDictionary(kv => kv.Key, kv => (object)J.Obj("label", kv.Value[0], "light", kv.Value[1]));
                        res.Json(200, J.Obj("siteSettings", St.SiteSettings, "database", St.DatabaseSettings, "themes", themes));
                        return;
                    }
                    if (POST)
                    {
                        try
                        {
                            var b = req.JsonBody();
                            var ss = St.WriteSiteSettings(J.DD(J.Get(b, "siteSettings")));
                            var db = St.WriteDatabaseSettings(J.DD(J.Get(b, "database")));
                            res.Json(200, J.Obj("ok", true, "siteSettings", ss, "database", db, "restartRequired", true));
                        }
                        catch (Exception e) { res.Json(400, Err(e.Message)); }
                        return;
                    }
                    break;
                case "/api/admin/orders":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    res.Json(200, J.Obj("orders", Reverse(ReadOrders().Where(o => J.S(J.D(o), "status") == "pending"))));
                    return;
                case "/api/admin/tables":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var sections = Samba.LiveTables();
                        var pendingOrders = ReadOrders().Select(J.DD).Where(o => J.S(o, "status") == "pending" && J.S(o, "type") == "table").ToList();
                        var pendingCalls = ReadCalls().Select(J.DD).Where(c => J.S(c, "status") == "pending").ToList();
                        foreach (var sec in sections.Select(J.DD)) foreach (var t in J.LL(sec["tables"]).Select(J.DD))
                        {
                            string name = J.S(t, "name");
                            t["hasOrder"] = pendingOrders.Any(o => J.S(o, "tableNumber") == name);
                            t["hasCall"] = pendingCalls.Any(c => J.S(c, "table") == name);
                        }
                        res.Json(200, J.Obj("sections", sections));
                    }
                    catch (Exception e) { res.Json(500, Err(e.Message)); }
                    return;
                case "/api/admin/orders/approve":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var b = req.JsonBody();
                        Dictionary<string, object> order; List<object> orders;
                        lock (_ordersLock) { orders = ReadOrders(); order = orders.Select(J.D).FirstOrDefault(o => o != null && J.S(o, "id") == J.S(b, "id") && J.S(o, "status") == "pending"); }
                        if (order == null) { res.Json(404, Err("Bekleyen sipariş bulunamadı.")); return; }
                        var result = Samba.CreateOrder(order);
                        lock (_ordersLock)
                        {
                            orders = ReadOrders();
                            var o2 = orders.Select(J.D).FirstOrDefault(o => o != null && J.S(o, "id") == J.S(order, "id"));
                            if (o2 != null) { o2["status"] = "approved"; o2["ticketNumber"] = result["ticketNumber"]; o2["sentAt"] = J.IsoNow(); order = o2; }
                            WriteOrders(orders);
                        }
                        var ev = new Dictionary<string, object>(order); ev["status"] = "approved";
                        Broadcast("new-order", ev);
                        PrintOrderToKitchen(order, result["ticketNumber"]);
                        res.Json(200, J.Obj("ok", true, "ticketNumber", result["ticketNumber"], "total", result["total"]));
                    }
                    catch (Exception e) { res.Json(500, Err(e.Message)); }
                    return;
                case "/api/admin/orders/reject":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var b = req.JsonBody();
                        lock (_ordersLock)
                        {
                            var orders = ReadOrders();
                            var o = orders.Select(J.D).FirstOrDefault(x => x != null && J.S(x, "id") == J.S(b, "id") && J.S(x, "status") == "pending");
                            if (o == null) { res.Json(404, Err("Bekleyen sipariş bulunamadı.")); return; }
                            o["status"] = "rejected"; o["rejectedAt"] = J.IsoNow();
                            WriteOrders(orders);
                        }
                        res.Json(200, J.Obj("ok", true));
                    }
                    catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
                case "/api/admin/orders/history":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    res.Json(200, J.Obj("orders", Reverse(ReadOrders())));
                    return;
                case "/api/admin/orders/delete-ticket":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var b = req.JsonBody();
                        var orders = ReadOrders();
                        var o = orders.Select(J.D).FirstOrDefault(x => x != null && J.S(x, "id") == J.S(b, "id"));
                        if (o == null || !J.Truthy(J.Get(o, "ticketNumber"))) { res.Json(404, Err("Gönderilmiş sipariş bulunamadı.")); return; }
                        Samba.DeleteTicketByNumber(o["ticketNumber"]);
                        lock (_ordersLock)
                        {
                            orders = ReadOrders();
                            var o2 = orders.Select(J.D).FirstOrDefault(x => x != null && J.S(x, "id") == J.S(b, "id"));
                            if (o2 != null) { o2["status"] = "deleted"; o2["deletedAt"] = J.IsoNow(); }
                            WriteOrders(orders);
                        }
                        res.Json(200, J.Obj("ok", true));
                    }
                    catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
                case "/api/admin/events":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    res.Status = 200;
                    res.SetHeader("Content-Type", "text/event-stream; charset=utf-8");
                    res.SetHeader("Cache-Control", "no-store");
                    res.SetHeader("X-Accel-Buffering", "no");
                    res.Handled = true;
                    if (req.IsTunnel)
                    {
                        // tunel cevabi tamponlar - akis tasiyamaz; tarayici 20 sn sonra yeniden baglanir
                        res.Write("retry: 20000\n: bağlandı\n\n");
                        return;
                    }
                    res.Streamer = s =>
                    {
                        var c = new SseClient { S = s };
                        var hello = Encoding.UTF8.GetBytes(": bağlandı\n\n");
                        lock (c.L) { s.Write(hello, 0, hello.Length); s.Flush(); }
                        lock (_sse) _sse.Add(c);
                        try
                        {
                            var ping = Encoding.UTF8.GetBytes(": ping\n\n");
                            while (!c.Dead)
                            {
                                Thread.Sleep(25000);
                                try { lock (c.L) { s.Write(ping, 0, ping.Length); s.Flush(); } } catch { c.Dead = true; }
                            }
                        }
                        finally { lock (_sse) _sse.Remove(c); }
                    };
                    return;
                case "/api/admin/menu":
                    if (!authed) { need(); return; }
                    try
                    {
                        var cats = Samba.LiveMenu(St.SambaposMenuId, null);
                        var site = MenuEditor.ParseSiteItems(Files.Read(P("index.html")));
                        var list = cats.Select(cat => (object)J.Obj("id", cat.Id, "name", cat.Name, "items", cat.Items.Select(item =>
                        {
                            var o = Samba.ItemJson(item);
                            string n = J.LowerTr(item.Name.Trim());
                            var si = site.FirstOrDefault(s => J.LowerTr(s.Name.Trim()) == n);
                            if (si != null) { o["lineIndex"] = si.LineIndex; o["description"] = si.Description; o["badges"] = si.Badges.Cast<object>().ToList(); o["subcat"] = si.Subcat; o["oldPrice"] = si.OldPrice; o["categoryIdRaw"] = si.CategoryIdRaw; }
                            o["imageUrl"] = FindProductImage(item.Name);
                            return (object)o;
                        }).ToList())).ToList();
                        res.Json(200, J.Obj("categories", list));
                    }
                    catch (Exception e) { res.Json(500, Err(e.Message)); }
                    return;
                case "/api/admin/menu-diff":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var cats = Samba.LiveMenu(St.SambaposMenuId, null);
                        var site = MenuEditor.ParseSiteItems(Files.Read(P("index.html")));
                        var seen = new HashSet<string>(); var flat = new List<Samba.Item>();
                        foreach (var c in cats) foreach (var i in c.Items) { string k = J.LowerTr(i.Name.Trim()); if (seen.Add(k)) flat.Add(i); }
                        Func<string, string> norm = s => J.LowerTr((s ?? "").Trim());
                        var siteBy = new Dictionary<string, MenuEditor.SiteItem>(); foreach (var s in site) siteBy[norm(s.Name)] = s;
                        var dbBy = new HashSet<string>(flat.Select(i => norm(i.Name)));
                        var matched = new List<object>(); var onlySamba = new List<object>();
                        foreach (var d in flat)
                        {
                            MenuEditor.SiteItem s; string sug = MenuEditor.PriceText(d.Price);
                            if (siteBy.TryGetValue(norm(d.Name), out s)) { if (s.PriceRawText.Trim() != sug) matched.Add(J.Obj("name", d.Name, "lineIndex", s.LineIndex, "sitePrice", s.PriceRawText, "dbPrice", sug, "differs", true)); }
                            else onlySamba.Add(J.Obj("name", d.Name, "categoryName", d.CategoryName, "dbPrice", sug));
                        }
                        var onlySite = site.Where(i => !dbBy.Contains(norm(i.Name))).Select(i => (object)J.Obj("name", i.Name, "priceRawText", i.PriceRawText)).ToList();
                        res.Json(200, J.Obj("matched", matched, "onlyInSambapos", onlySamba, "onlyOnSite", onlySite));
                    }
                    catch (Exception e) { res.Json(500, Err(e.Message)); }
                    return;
                case "/api/admin/apply-price":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var b = req.JsonBody(); var li = IntOrNull(J.Get(b, "lineIndex"));
                        if (!li.HasValue || !J.Truthy(J.Get(b, "newPriceText"))) { res.Json(400, Err("Eksik bilgi.")); return; }
                        MenuEditor.ApplyPriceUpdate(li.Value, J.Clip(J.S(b, "newPriceText"), 40));
                        res.Json(200, J.Obj("ok", true));
                    }
                    catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
                case "/api/admin/edit-item":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var b = req.JsonBody(); var li = IntOrNull(J.Get(b, "lineIndex"));
                        if (!li.HasValue) { res.Json(400, Err("Ürün satırı belirtilmedi.")); return; }
                        var badges = Badges(b);
                        MenuEditor.UpdateItem(li.Value, J.S(b, "name"), J.S(b, "price"), J.S(b, "description"), badges, badges != null,
                            J.S(b, "subcat"), J.Has(b, "subcat") && J.Get(b, "subcat") != null, J.S(b, "oldPrice"), J.Has(b, "oldPrice") && J.Get(b, "oldPrice") != null);
                        if (J.Truthy(J.Get(b, "imageDataUrl"))) SaveDataUrlImage(J.S(b, "name"), J.S(b, "imageDataUrl"));
                        res.Json(200, J.Obj("ok", true));
                    }
                    catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
                case "/api/admin/delete-item":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var li = IntOrNull(J.Get(req.JsonBody(), "lineIndex"));
                        if (!li.HasValue) { res.Json(400, Err("Ürün satırı belirtilmedi.")); return; }
                        MenuEditor.DeleteItem(li.Value);
                        res.Json(200, J.Obj("ok", true));
                    }
                    catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
                case "/api/admin/regenerate-menu":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var b = req.JsonBody();
                        var cats = Samba.LiveMenu(St.SambaposMenuId, null);
                        if (!J.Truthy(J.Get(b, "force")))
                        {
                            var cur = MenuEditor.ListCategoriesWithMeta(Files.Read(P("index.html"))).Where(c => J.Num(c, "itemCount") > 0).Select(c => J.S(c, "name")).ToList();
                            var newNames = new HashSet<string>(cats.Select(c => c.Name.Trim()));
                            var lost = cur.Where(n => !newNames.Contains(n.Trim())).ToList();
                            if (lost.Count > 0) { res.Json(409, J.Obj("error", "DİKKAT: Bu işlem şu kategorileri SİLECEK (SambaPOS'tan artık gelmiyorlar): " + string.Join(", ", lost) + ". Devam etmek için onaylayın.", "wouldBeLost", lost.Cast<object>().ToList())); return; }
                        }
                        var o = J.Obj("ok", true); J.Assign(o, MenuEditor.RegenerateFullMenu(cats));
                        res.Json(200, o);
                    }
                    catch (Exception e) { res.Json(500, Err(e.Message)); }
                    return;
                case "/api/admin/samba-menus":
                    if (!authed) { need(); return; }
                    if (GET) { try { res.Json(200, J.Obj("menus", Samba.LiveScreenMenus(), "selectedId", St.SambaposMenuId)); } catch (Exception e) { res.Json(500, Err(e.Message)); } return; }
                    if (POST) { try { St.SetId("sambaposMenuId", J.Get(req.JsonBody(), "menuId")); res.Json(200, J.Obj("ok", true, "selectedId", St.SambaposMenuId)); } catch (Exception e) { res.Json(400, Err(e.Message)); } return; }
                    break;
                case "/api/admin/categories":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    res.Json(200, J.Obj("categories", MenuEditor.ParseCategories(Files.Read(P("index.html"))).Cast<object>().ToList()));
                    return;
                case "/api/admin/upsell-rules":
                    if (!authed) { need(); return; }
                    if (GET) { res.Json(200, J.Obj("rules", Upsell.ReadRules())); return; }
                    if (POST) { try { res.Json(200, J.Obj("ok", true, "rule", Upsell.Upsert(req.JsonBody()))); } catch (Exception e) { res.Json(400, Err(e.Message)); } return; }
                    break;
                case "/api/admin/upsell-rules/delete":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try { Upsell.Delete(J.S(req.JsonBody(), "id")); res.Json(200, J.Obj("ok", true)); } catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
                case "/api/admin/upsell-stats":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    res.Json(200, J.Obj("stats", Upsell.StatsSummary()));
                    return;
                case "/api/admin/categories-full":
                    if (!GET) break;
                    if (!authed) { need(); return; }
                    try { res.Json(200, J.Obj("categories", MenuEditor.ListCategoriesWithMeta(Files.Read(P("index.html"))).Cast<object>().ToList())); } catch (Exception e) { res.Json(500, Err(e.Message)); }
                    return;
                case "/api/admin/category-rename":
                case "/api/admin/category-delete":
                case "/api/admin/category-active":
                case "/api/admin/category-reorder":
                case "/api/admin/category-create":
                case "/api/admin/item-reorder":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var b = req.JsonBody();
                        int dir = J.Num(b, "direction") < 0 ? -1 : 1;
                        switch (path)
                        {
                            case "/api/admin/category-rename": MenuEditor.RenameCategory(J.S(b, "name"), J.S(b, "newName")); break;
                            case "/api/admin/category-delete": MenuEditor.DeleteCategory(J.S(b, "name")); break;
                            case "/api/admin/category-active": MenuEditor.SetCategoryActive(J.S(b, "name"), J.IsTrue(b, "active")); break;
                            case "/api/admin/category-reorder": MenuEditor.ReorderCategory(J.S(b, "name"), dir); break;
                            case "/api/admin/category-create": MenuEditor.AddCategory(J.S(b, "name")); break;
                            case "/api/admin/item-reorder":
                                double li = J.Num(b, "lineIndex");
                                MenuEditor.ReorderItem(J.S(b, "categoryName"), J.Finite(li) ? (int)li : -1, dir); break;
                        }
                        res.Json(200, J.Obj("ok", true));
                    }
                    catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
                case "/api/admin/add-missing-items":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var cats = Samba.LiveMenu(St.SambaposMenuId, null);
                        string html = Files.Read(P("index.html"));
                        var site = MenuEditor.ParseSiteItems(html);
                        Func<string, string> norm = s => J.LowerTr((s ?? "").Trim());
                        var existing = new HashSet<string>(MenuEditor.ListCategoriesWithMeta(html).Select(c => norm(J.S(c, "name"))));
                        int added = 0; var failed = new List<object>();
                        foreach (var cat in cats)
                        {
                            var missing = cat.Items.Where(i => !site.Any(s => norm(s.Name) == norm(i.Name))).ToList();
                            if (missing.Count == 0) continue;
                            if (!existing.Contains(norm(cat.Name)))
                            {
                                try { MenuEditor.AddCategory(cat.Name); existing.Add(norm(cat.Name)); }
                                catch (Exception e) { failed.Add(J.Obj("name", cat.Name, "error", "Kategori oluşturulamadı: " + e.Message)); continue; }
                            }
                            foreach (var item in missing)
                            {
                                try { MenuEditor.AddItem(cat.Name, J.Clip(item.Name, 80), item.Price.ToString("0.00", J.Inv).Replace('.', ',') + " TL", "", null, new List<string>(), "", ""); added++; }
                                catch (Exception e) { failed.Add(J.Obj("name", item.Name, "error", e.Message)); }
                            }
                        }
                        res.Json(200, J.Obj("added", added, "failed", failed));
                    }
                    catch (Exception e) { res.Json(500, Err(e.Message)); }
                    return;
                case "/api/admin/add-item":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var b = req.JsonBody();
                        if (!J.Truthy(J.Get(b, "categoryIdRaw")) || !J.Truthy(J.Get(b, "name")) || !J.Truthy(J.Get(b, "price"))) { res.Json(400, Err("Kategori, ürün adı ve fiyat zorunlu.")); return; }
                        string img = null;
                        if (J.Truthy(J.Get(b, "imageDataUrl"))) img = SaveDataUrlImage(J.S(b, "name"), J.S(b, "imageDataUrl"));
                        MenuEditor.AddItem(J.S(b, "categoryIdRaw"), J.Clip(J.S(b, "name"), 80), J.Clip(J.S(b, "price"), 40), J.Clip(J.S(b, "description"), 200), img,
                            Badges(b) ?? new List<string>(), J.Clip(J.S(b, "subcat"), 60), J.Clip(J.S(b, "oldPrice"), 40));
                        res.Json(200, J.Obj("ok", true));
                    }
                    catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
                case "/api/admin/upload-image":
                    if (!POST) break;
                    if (!authed) { need(); return; }
                    try
                    {
                        var b = req.JsonBody(12 * 1024 * 1024);
                        if (!J.Truthy(J.Get(b, "itemName")) || !J.Truthy(J.Get(b, "dataUrl"))) { res.Json(400, Err("Eksik bilgi.")); return; }
                        res.Json(200, J.Obj("ok", true, "savedAs", SaveDataUrlImage(J.S(b, "itemName"), J.S(b, "dataUrl"))));
                    }
                    catch (Exception e) { res.Json(400, Err(e.Message)); }
                    return;
            }
        }
    }
}
