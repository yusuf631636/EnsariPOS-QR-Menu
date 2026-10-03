using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace QRMenu
{
    // index.html (musteri menusu) okuma/duzenleme - menu-editor.js'in birebir karsiligi.
    // Satir/desen bazli hedefli metin islemleri; sayfanin gorunumu/CSS/JS'i degismez.
    public static class MenuEditor
    {
        public static string IndexPath;

        static string ReadIndex() { return Files.Read(IndexPath); }
        static void WriteIndex(string html)
        {
            try { File.Copy(IndexPath, IndexPath + ".bak", true); } catch { }
            Files.Write(IndexPath, html);
        }

        static readonly Dictionary<string, string> Named = new Dictionary<string, string> {
            { "amp", "&" }, { "lt", "<" }, { "gt", ">" }, { "quot", "\"" }, { "uuml", "ü" }, { "Uuml", "Ü" }, { "ouml", "ö" }, { "Ouml", "Ö" }, { "ccedil", "ç" }, { "Ccedil", "Ç" }, { "scedil", "ş" } };
        public static string DecodeEntities(string s)
        {
            s = Regex.Replace(s ?? "", @"&#(\d+);", m => ((char)int.Parse(m.Groups[1].Value)).ToString());
            return Regex.Replace(s, @"&([a-zA-Z]+);", m => { string v; return Named.TryGetValue(m.Groups[1].Value, out v) ? v : m.Value; });
        }
        public static string EscHtml(string s) { return (s ?? "").Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;"); }
        public static string EscJs(string s) { return EscHtml(s).Replace("'", "&#39;"); }
        static string EscRe(string s) { return Regex.Escape(s ?? ""); }
        static string[] Lines(string html) { return html.Split('\n'); }

        public class SiteItem
        {
            public int LineIndex; public string CategoryIdRaw, CategoryName, Name, Description, PriceRawText, Subcat, OldPrice;
            public List<string> Badges = new List<string>();
        }

        public static List<SiteItem> ParseSiteItems(string html)
        {
            var items = new List<SiteItem>();
            var lines = Lines(html);
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i];
                if (!line.Contains("class=\"menu-item\"")) continue;
                var cat = Regex.Match(line, "^<div id=\"([^\"]+)\" class=\"menu-item\"");
                var name = Regex.Match(line, "<strong>([^<]*)</strong>");
                var price = Regex.Match(line, "class=\"price-tag\"[^>]*>([^<]*)</div>");
                if (!cat.Success || !name.Success || !price.Success) continue;
                var desc = Regex.Match(line, "<small>([^<]*)</small>");
                var badges = Regex.Match(line, "data-badges=\"([^\"]*)\"");
                var subcat = Regex.Match(line, "data-subcat=\"([^\"]*)\"");
                var oldp = Regex.Match(line, "data-oldprice=\"([^\"]*)\"");
                items.Add(new SiteItem
                {
                    LineIndex = i, CategoryIdRaw = cat.Groups[1].Value, CategoryName = DecodeEntities(cat.Groups[1].Value), Name = DecodeEntities(name.Groups[1].Value),
                    Description = desc.Success ? DecodeEntities(desc.Groups[1].Value).Trim() : "", PriceRawText = price.Groups[1].Value,
                    Badges = badges.Success ? DecodeEntities(badges.Groups[1].Value).Split(',').Where(b => b.Length > 0).ToList() : new List<string>(),
                    Subcat = subcat.Success ? DecodeEntities(subcat.Groups[1].Value) : "",
                    OldPrice = oldp.Success ? DecodeEntities(oldp.Groups[1].Value) : ""
                });
            }
            return items;
        }

        static string SetDataAttr(string line, string attr, string value, bool provided)
        {
            if (!provided) return line;
            string clean = (value ?? "").Trim();
            var re = new Regex("\\s" + attr + "=\"[^\"]*\"");
            if (re.IsMatch(line)) return clean.Length > 0 ? re.Replace(line, " " + attr + "=\"" + EscHtml(clean) + "\"", 1) : re.Replace(line, "", 1);
            if (clean.Length == 0) return line;
            return ReplaceFirst(line, "class=\"menu-item\"", "class=\"menu-item\" " + attr + "=\"" + EscHtml(clean) + "\"");
        }
        static string ReplaceFirst(string s, string find, string repl)
        {
            int i = s.IndexOf(find, StringComparison.Ordinal);
            return i < 0 ? s : s.Substring(0, i) + repl + s.Substring(i + find.Length);
        }

        public static List<Dictionary<string, object>> ParseCategories(string html)
        {
            var cats = new List<Dictionary<string, object>>();
            foreach (Match m in Regex.Matches(html, "<div id=\"([^\"]+)\" class=\"menu-section\">"))
                cats.Add(J.Obj("idRaw", m.Groups[1].Value, "name", DecodeEntities(m.Groups[1].Value)));
            return cats;
        }

        static List<string> GetRawSections(string html)
        {
            var m = Regex.Match(html, @"let rawSections = \[([^\]]*)\]");
            if (!m.Success) throw new Exception("rawSections dizisi bulunamadı (sayfa yapısı beklenenden farklı).");
            return m.Groups[1].Value.Split(',').Select(s => DecodeEntities(Regex.Replace(s.Trim(), "^'|'$", ""))).Where(s => s.Length > 0).ToList();
        }
        static string SetRawSections(string html, List<string> list)
        {
            string arr = "[" + string.Join(",", list.Select(n => "'" + EscJs(n) + "'")) + "]";
            var re = new Regex(@"let rawSections = \[[^\]]*\]");
            return re.Replace(html, m => "let rawSections = " + arr, 1);
        }
        static Regex ButtonRe(string name)
        {
            return new Regex("\\s*<button data-id=\"" + EscRe(EscHtml(name)) + "\" onclick=\"showCategory\\('" + EscRe(EscJs(name)) + "'\\)\">[^<]*</button>");
        }
        static string BuildButton(string name) { return "\n<button data-id=\"" + EscHtml(name) + "\" onclick=\"showCategory('" + EscJs(name) + "')\">" + EscHtml(name) + "</button>"; }

        static int[] SectionBounds(string html, string name)
        {
            string open = "<div id=\"" + EscHtml(name) + "\" class=\"menu-section\">";
            int start = html.IndexOf(open, StringComparison.Ordinal);
            if (start < 0) return null;
            int depth = 1, pos = start + open.Length;
            while (depth > 0)
            {
                int no = html.IndexOf("<div", pos, StringComparison.Ordinal);
                int nc = html.IndexOf("</div>", pos, StringComparison.Ordinal);
                if (nc < 0) return null;
                if (no >= 0 && no < nc) { depth++; pos = no + 4; }
                else { depth--; pos = nc + 6; }
            }
            return new[] { start, pos };
        }

        public static List<Dictionary<string, object>> ListCategoriesWithMeta(string html)
        {
            var active = new HashSet<string>(GetRawSections(html));
            return ParseCategories(html).Select(cat =>
            {
                string name = (string)cat["name"];
                var b = SectionBounds(html, name);
                int count = b != null ? Regex.Matches(html.Substring(b[0], b[1] - b[0]), "class=\"menu-item\"").Count : 0;
                return J.Obj("idRaw", cat["idRaw"], "name", name, "active", active.Contains(name), "itemCount", count);
            }).ToList();
        }

        public static void RenameCategory(string oldName, string newName)
        {
            string cleanNew = J.Clip((newName ?? "").Trim(), 80);
            if (cleanNew.Length == 0) throw new Exception("Yeni kategori adı boş olamaz.");
            string html = ReadIndex();
            var b = SectionBounds(html, oldName);
            if (b == null) throw new Exception("Kategori bulunamadı.");
            string section = html.Substring(b[0], b[1] - b[0]).Replace("id=\"" + EscHtml(oldName) + "\"", "id=\"" + EscHtml(cleanNew) + "\"");
            html = html.Substring(0, b[0]) + section + html.Substring(b[1]);
            var btn = ButtonRe(oldName);
            if (btn.IsMatch(html)) html = btn.Replace(html, m => BuildButton(cleanNew), 1);
            html = SetRawSections(html, GetRawSections(html).Select(n => n == oldName ? cleanNew : n).ToList());
            WriteIndex(html);
        }

        public static void DeleteCategory(string name)
        {
            string html = ReadIndex();
            var b = SectionBounds(html, name);
            if (b == null) throw new Exception("Kategori bulunamadı.");
            html = html.Substring(0, b[0]) + html.Substring(b[1]);
            html = ButtonRe(name).Replace(html, "", 1);
            html = SetRawSections(html, GetRawSections(html).Where(n => n != name).ToList());
            WriteIndex(html);
        }

        const string BtnMarker = "<div class=\"category-buttons\" id=\"category-buttons\">";

        public static void SetCategoryActive(string name, bool active)
        {
            string html = ReadIndex();
            if (SectionBounds(html, name) == null) throw new Exception("Kategori bulunamadı.");
            var list = GetRawSections(html);
            bool has = list.Contains(name);
            if (active && !has)
            {
                list.Add(name);
                if (!ButtonRe(name).IsMatch(html))
                {
                    int idx = html.IndexOf(BtnMarker, StringComparison.Ordinal);
                    if (idx >= 0) html = html.Substring(0, idx + BtnMarker.Length) + BuildButton(name) + html.Substring(idx + BtnMarker.Length);
                }
            }
            else if (!active && has) html = ButtonRe(name).Replace(html, "", 1);
            html = SetRawSections(html, active ? list : list.Where(n => n != name).ToList());
            WriteIndex(html);
        }

        public static void ReorderCategory(string name, int direction)
        {
            string html = ReadIndex();
            var list = GetRawSections(html);
            int i = list.IndexOf(name), j = i + direction;
            if (i == -1 || j < 0 || j >= list.Count) throw new Exception("Sıra değiştirilemedi (kategori en baştaysa yukarı, en sondaysa aşağı alınamaz).");
            string other = list[j];
            list[i] = other; list[j] = name;
            html = SetRawSections(html, list);
            var a = ButtonRe(name).Match(html); var bb = ButtonRe(other).Match(html);
            if (a.Success && bb.Success)
            {
                string A = a.Value, B = bb.Value;
                if (a.Index < bb.Index) html = ReplaceFirst(ReplaceFirst(ReplaceFirst(html, A, "\u0000"), B, A), "\u0000", B);
                else html = ReplaceFirst(ReplaceFirst(ReplaceFirst(html, B, "\u0000"), A, B), "\u0000", A);
            }
            var ba = SectionBounds(html, name); var bo = SectionBounds(html, other);
            if (ba != null && bo != null)
            {
                string sa = html.Substring(ba[0], ba[1] - ba[0]), so = html.Substring(bo[0], bo[1] - bo[0]);
                if (ba[0] < bo[0]) html = html.Substring(0, ba[0]) + so + html.Substring(ba[1], bo[0] - ba[1]) + sa + html.Substring(bo[1]);
                else html = html.Substring(0, bo[0]) + sa + html.Substring(bo[1], ba[0] - bo[1]) + so + html.Substring(ba[1]);
            }
            WriteIndex(html);
        }

        public static void AddCategory(string name)
        {
            string clean = J.Clip((name ?? "").Trim(), 80);
            if (clean.Length == 0) throw new Exception("Kategori adı boş olamaz.");
            string html = ReadIndex();
            if (GetRawSections(html).Contains(clean)) throw new Exception("Bu isimde kategori zaten var.");
            var list = GetRawSections(html); list.Add(clean);
            html = SetRawSections(html, list);
            int idx = html.IndexOf(BtnMarker, StringComparison.Ordinal);
            if (idx >= 0) html = html.Substring(0, idx + BtnMarker.Length) + BuildButton(clean) + html.Substring(idx + BtnMarker.Length);
            int d = html.IndexOf("<div class=\"drawer-overlay\"", StringComparison.Ordinal);
            if (d < 0) throw new Exception("Drawer bölgesi bulunamadı.");
            html = html.Substring(0, d) + "\n<div id=\"" + EscHtml(clean) + "\" class=\"menu-section\">\n</div>\n" + html.Substring(d);
            WriteIndex(html);
        }

        public static void ReorderItem(string categoryName, int lineIndex, int direction)
        {
            var lines = Lines(ReadIndex());
            if (lineIndex < 0 || lineIndex >= lines.Length || !lines[lineIndex].Contains("class=\"menu-item\"")) throw new Exception("Ürün satırı bulunamadı.");
            var re = new Regex("id=\"" + EscRe(EscHtml(categoryName)) + "\" class=\"menu-item\"");
            var idxs = Enumerable.Range(0, lines.Length).Where(i => re.IsMatch(lines[i])).ToList();
            int cur = idxs.IndexOf(lineIndex), np = cur + direction;
            if (cur == -1 || np < 0 || np >= idxs.Count) return;
            int other = idxs[np];
            string t = lines[lineIndex]; lines[lineIndex] = lines[other]; lines[other] = t;
            WriteIndex(string.Join("\n", lines));
        }

        public static void ApplyPriceUpdate(int lineIndex, string newPrice)
        {
            var lines = Lines(ReadIndex());
            if (lineIndex < 0 || lineIndex >= lines.Length || !lines[lineIndex].Contains("class=\"menu-item\"")) throw new Exception("Satır bulunamadı (dosya bu arada değişmiş olabilir, sayfayı yenileyin).");
            var pm = Regex.Match(lines[lineIndex], "class=\"price-tag\"[^>]*>([^<]*)</div>");
            if (!pm.Success) throw new Exception("Fiyat alanı bulunamadı.");
            string old = pm.Groups[1].Value;
            lines[lineIndex] = lines[lineIndex].Replace("'" + old + "'", "'" + newPrice + "'").Replace(">" + old + "<", ">" + newPrice + "<");
            WriteIndex(string.Join("\n", lines));
        }

        public static void UpdateItem(int lineIndex, string name, string price, string description, List<string> badges, bool badgesProvided,
            string subcat, bool subcatProvided, string oldPrice, bool oldPriceProvided)
        {
            string html = ReadIndex();
            var lines = Lines(html);
            if (lineIndex < 0 || lineIndex >= lines.Length || !lines[lineIndex].Contains("class=\"menu-item\"")) throw new Exception("Ürün satırı bulunamadı.");
            if (!ParseSiteItems(html).Any(i => i.LineIndex == lineIndex)) throw new Exception("Ürün satırı okunamadı.");
            string line = lines[lineIndex];
            string nName = J.Clip((name ?? "").Trim(), 80), nPrice = J.Clip((price ?? "").Trim(), 40), nDesc = J.Clip((description ?? "").Trim(), 200);
            if (nName.Length == 0 || nPrice.Length == 0) throw new Exception("Ürün adı ve fiyat zorunlu.");
            var img = Regex.Match(line, "<img src=\"([^\"]+)\"");
            string image = img.Success ? img.Groups[1].Value : "./" + EscHtml(nName) + ".jpg";
            string modal = "onclick=\"openModal('" + EscJs(nName) + "','" + EscJs(nDesc) + "','" + EscJs(nPrice) + "','" + image + "')\"";
            string next = new Regex("onclick=\"openModal\\([^\"]+\\)\"").Replace(line, m => modal, 1);
            next = new Regex(@"(<strong>)[\s\S]*?(</strong>)").Replace(next, m => m.Groups[1].Value + EscHtml(nName) + m.Groups[2].Value, 1);
            next = new Regex(@"(<small>)[\s\S]*?(</small>)").Replace(next, m => m.Groups[1].Value + EscHtml(nDesc) + m.Groups[2].Value, 1);
            next = new Regex("(class=\"price-tag\"[^>]*>)[^<]*(</div>)").Replace(next, m => m.Groups[1].Value + EscHtml(nPrice) + m.Groups[2].Value, 1);
            next = SetDataAttr(next, "data-badges", badges != null ? string.Join(",", badges.Where(b => !string.IsNullOrEmpty(b))) : null, badgesProvided);
            next = SetDataAttr(next, "data-subcat", subcat, subcatProvided);
            next = SetDataAttr(next, "data-oldprice", oldPrice, oldPriceProvided);
            lines[lineIndex] = next;
            WriteIndex(string.Join("\n", lines));
        }

        public static void DeleteItem(int lineIndex)
        {
            var lines = Lines(ReadIndex()).ToList();
            if (lineIndex < 0 || lineIndex >= lines.Count || !lines[lineIndex].Contains("class=\"menu-item\"")) throw new Exception("Ürün satırı bulunamadı.");
            lines.RemoveAt(lineIndex);
            WriteIndex(string.Join("\n", lines));
        }

        public static void AddItem(string categoryIdRaw, string name, string price, string description, string imageFileName, List<string> badges, string subcat, string oldPrice)
        {
            string html = ReadIndex();
            string marker = "<div id=\"" + categoryIdRaw + "\" class=\"menu-section\">";
            int idx = html.IndexOf(marker, StringComparison.Ordinal);
            if (idx < 0) throw new Exception("Kategori bulunamadı.");
            string img = !string.IsNullOrEmpty(imageFileName) ? "./" + EscHtml(imageFileName) : "./logo.jpg";
            var attrs = new List<string>();
            var bl = (badges ?? new List<string>()).Where(b => !string.IsNullOrEmpty(b)).ToList();
            if (bl.Count > 0) attrs.Add("data-badges=\"" + EscHtml(string.Join(",", bl)) + "\"");
            if (!string.IsNullOrEmpty(subcat)) attrs.Add("data-subcat=\"" + EscHtml(subcat.Trim()) + "\"");
            if (!string.IsNullOrEmpty(oldPrice)) attrs.Add("data-oldprice=\"" + EscHtml(oldPrice.Trim()) + "\"");
            string a = string.Join(" ", attrs);
            string line = "\n<div id=\"" + categoryIdRaw + "\" class=\"menu-item\"" + (a.Length > 0 ? " " + a : "") + " onclick=\"openModal('" + EscJs(name) + "','" + EscJs(description) + "','" + EscJs(price) + "','" + img +
                "')\"><div class=\"menu-content\"><div><img src=\"" + img + "\" onerror=\"this.remove()\"><div class=\"price-tag\">" + EscHtml(price) + "</div></div><div><strong>" + EscHtml(name) + "</strong><small>" + EscHtml(description) + "</small></div></div></div>";
            WriteIndex(html.Substring(0, idx + marker.Length) + line + html.Substring(idx + marker.Length));
        }

        public static string PriceText(double price) { return price.ToString("N2", J.Tr) + " TL"; }

        public static Dictionary<string, object> RegenerateFullMenu(List<Samba.Category> raw)
        {
            string html = ReadIndex();
            if (raw.Count == 0) throw new Exception("SambaPOS'ta gösterilecek kategori/ürün bulunamadı.");
            Func<string, string> clean = s => Regex.Replace(Regex.Replace(Regex.Replace(s ?? "", @"\\[rnt]", " "), @"[\r\n\t]+", " "), @"\s+", " ").Trim();
            var byName = new Dictionary<string, List<Samba.Item>>();
            var order = new List<string>();
            foreach (var c in raw)
            {
                string n = clean(c.Name);
                if (n.Length == 0) continue;
                if (!byName.ContainsKey(n)) { byName[n] = new List<Samba.Item>(); order.Add(n); }
                byName[n].AddRange(c.Items);
            }
            int bs = html.IndexOf(BtnMarker, StringComparison.Ordinal);
            if (bs < 0) throw new Exception("Kategori buton bölgesi bulunamadı (sayfa yapısı beklenenden farklı).");
            int bc = html.IndexOf("</div>", bs, StringComparison.Ordinal) + 6;
            string btnHtml = BtnMarker + "\n<button class=\"active\" data-id=\"anasayfa\" onclick=\"showCategory('anasayfa')\">Ana Sayfa</button>\n" +
                string.Join("\n", order.Select(n => "<button data-id=\"" + EscHtml(n) + "\" onclick=\"showCategory('" + EscJs(n) + "')\">" + EscHtml(n) + "</button>")) + "\n</div>";
            html = html.Substring(0, bs) + btnHtml + html.Substring(bc);

            int drawer = html.IndexOf("<div class=\"drawer-overlay\"", StringComparison.Ordinal);
            int ana = html.IndexOf("<div id=\"anasayfa\" class=\"menu-section active\">", StringComparison.Ordinal);
            int firstCat = ana >= 0 ? html.IndexOf("class=\"menu-section\">", ana, StringComparison.Ordinal) : -1;
            int firstDiv = firstCat >= 0 ? html.LastIndexOf("<div id=\"", firstCat, StringComparison.Ordinal) : -1;
            if (ana < 0 || firstDiv < 0 || drawer < 0) throw new Exception("Menü bölümleri bulunamadı (sayfa yapısı beklenenden farklı).");
            var sb = new StringBuilder();
            foreach (var n in order)
            {
                var items = byName[n].Select(item =>
                {
                    string pt = PriceText(item.Price), img = "./" + EscHtml(item.Name) + ".jpg";
                    return "<div id=\"" + EscHtml(n) + "\" class=\"menu-item\" onclick=\"openModal('" + EscJs(item.Name) + "','','" + pt + "','" + img + "')\"><div class=\"menu-content\"><div><img src=\"" + img +
                        "\" onerror=\"this.remove()\"><div class=\"price-tag\">" + pt + "</div></div><div><strong>" + EscHtml(item.Name) + "</strong><small></small></div></div></div>";
                });
                sb.Append("<div id=\"" + EscHtml(n) + "\" class=\"menu-section\">\n" + string.Join("\n", items) + "\n</div>");
            }
            html = html.Substring(0, firstDiv) + sb + "\n<!-- Drawer -->\n" + html.Substring(drawer);
            string arr = "['anasayfa'," + string.Join(",", order.Select(n => "'" + EscJs(n) + "'")) + "]";
            html = new Regex(@"let rawSections = \[[^\]]*\]").Replace(html, m => "let rawSections = " + arr, 1);
            WriteIndex(html);
            return J.Obj("categoryCount", order.Count, "itemCount", order.Sum(n => byName[n].Count));
        }
    }
}
