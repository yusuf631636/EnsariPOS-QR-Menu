using System;
using System.Collections.Generic;
using System.Data.SqlClient;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;

namespace QRMenu
{
    // ------------------------------------------------------------------ SQL (sql.js karsiligi - sqlcmd yerine SqlClient)
    public static class Db
    {
        static string _cs;
        public static string Source = "";

        public static void Reset() { _cs = null; }

        public static Dictionary<string, string> DetectConnection(out string foundIn)
        {
            var candidates = new[] { @"C:\ProgramData\SambaPOS\SambaPOS5\SambaSettings.txt", @"C:\ProgramData\AlfaPOS\AlfaPOS5\AlfaSettings.txt" };
            foreach (var f in candidates)
            {
                try
                {
                    if (!File.Exists(f)) continue;
                    var m = Regex.Match(File.ReadAllText(f), @"<ConnectionString>([^<]*)</ConnectionString>");
                    if (!m.Success || m.Groups[1].Value.Trim().Length == 0) continue;
                    var parts = ParseConn(System.Net.WebUtility.HtmlDecode(m.Groups[1].Value));
                    if (!parts.ContainsKey("server")) continue;
                    foundIn = f;
                    return parts;
                }
                catch { }
            }
            foundIn = null;
            return null;
        }

        public static Dictionary<string, string> ParseConn(string raw)
        {
            var o = new Dictionary<string, string>();
            foreach (var part in (raw ?? "").Split(';'))
            {
                int eq = part.IndexOf('=');
                if (eq < 0) continue;
                string k = part.Substring(0, eq).Trim().ToLowerInvariant(), v = part.Substring(eq + 1).Trim();
                if (k == "data source" || k == "server") o["server"] = v;
                else if (k == "initial catalog" || k == "database") o["database"] = v;
                else if (k == "user id" || k == "uid") o["user"] = v;
                else if (k == "password" || k == "pwd") o["password"] = v;
                else if (k == "integrated security" || k == "trusted_connection") o["integrated"] = v;
            }
            return o;
        }

        static string Env(string k) { var v = Environment.GetEnvironmentVariable(k); return string.IsNullOrEmpty(v) ? null : v; }

        public static string ConnectionString
        {
            get
            {
                if (_cs != null) return _cs;
                var c = Cfg.Read();
                Dictionary<string, string> det = null; string foundIn = null;
                if (string.IsNullOrEmpty(J.S(c, "server"))) { det = DetectConnection(out foundIn); if (det != null) Log.Write("SambaPOS bağlantısı otomatik bulundu (" + foundIn + ")"); }
                Func<string, string> dv = k => { string v; return det != null && det.TryGetValue(k, out v) && v.Length > 0 ? v : null; };
                Func<string, string> cv = k => { string v = J.S(c, k); return v.Length > 0 ? v : null; };
                string server = Env("SAMBAPOS_SQL_SERVER") ?? cv("server") ?? dv("server") ?? "localhost";
                string database = Env("SAMBAPOS_DB") ?? cv("database") ?? dv("database") ?? "SAMBAPOS5";
                string user = Env("SAMBAPOS_SQL_USER") ?? cv("user") ?? dv("user") ?? "";
                string password = Env("SAMBAPOS_SQL_PASSWORD") ?? cv("password") ?? dv("password") ?? "";
                var b = new SqlConnectionStringBuilder { DataSource = server, InitialCatalog = database, ConnectTimeout = 8, ApplicationName = "AlfaPOS QR Menu", Pooling = true };
                if (user.Length > 0 && password.Length > 0) { b.UserID = user; b.Password = password; }
                else b.IntegratedSecurity = true;
                var opts = J.D(J.Get(c, "options"));
                b.Encrypt = opts != null && J.IsTrue(opts, "encrypt");
                b.TrustServerCertificate = true;
                Source = server + "/" + database;
                _cs = b.ConnectionString;
                return _cs;
            }
        }

        // Tum sonuc kumelerinin satirlari (sqlcmd ciktisi gibi) - DBNull -> null
        // Test icin: veritabanina HIC dokunmadan sorgulari kaydeder (bkz. Program /sqltest)
        public static Func<string, List<object[]>> Mock;

        public static List<object[]> Query(string sql)
        {
            if (Mock != null) return Mock(sql);
            var rows = new List<object[]>();
            using (var con = new SqlConnection(ConnectionString))
            using (var cmd = new SqlCommand(sql, con))
            {
                cmd.CommandTimeout = 30;
                con.Open();
                using (var r = cmd.ExecuteReader())
                {
                    do
                    {
                        while (r.Read())
                        {
                            var row = new object[r.FieldCount];
                            r.GetValues(row);
                            for (int i = 0; i < row.Length; i++) if (row[i] is DBNull) row[i] = null;
                            rows.Add(row);
                        }
                    } while (r.NextResult());
                }
            }
            return rows;
        }

        // sqlcmd degerleri kirpilmis metin olarak veriyordu - ayni
        public static string S(object o) { return o == null ? "" : Convert.ToString(o, CultureInfo.InvariantCulture).Trim(); }
        public static double N(object o)
        {
            if (o == null) return 0;
            try { return Convert.ToDouble(o, CultureInfo.InvariantCulture); } catch { return J.NumOr(S(o), 0); }
        }
        public static long I(object o) { return (long)N(o); }
        public static string Esc(object value)
        {
            string s = Regex.Replace(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "", @"[\x00-\x08\x0B\x0C\x0E-\x1F]", "");
            if (s.Length > 200) s = s.Substring(0, 200);
            return s.Replace("'", "''");
        }
        public static string Num(double d) { return J.NumStr(d); }
    }

    // ------------------------------------------------------------------ SambaPOS islemleri (sambapos.js karsiligi)
    public static class Samba
    {
        public class Portion { public string Id; public string Name; public double Price; }
        public class Item { public string Id; public string Name; public double Price; public List<Portion> Portions = new List<Portion>(); public string CategoryName; }
        public class Category { public string Id; public string Name; public List<Item> Items = new List<Item>(); }
        public class TagGroup { public long Id; public string Name; public long MinSelected, MaxSelected; public List<Dictionary<string, object>> Tags = new List<Dictionary<string, object>>(); }

        public static Dictionary<string, object> ItemJson(Item i)
        {
            return J.Obj("id", i.Id, "name", i.Name, "price", J.NumVal(i.Price),
                "portions", i.Portions.Select(p => (object)J.Obj("id", p.Id, "name", p.Name, "price", J.NumVal(p.Price))).ToList());
        }

        public static List<TagGroup> GetOrderTagGroups()
        {
            var groups = new List<TagGroup>();
            foreach (var g in Db.Query("SET NOCOUNT ON; SELECT Id, Name, ISNULL(MinSelectedItems,0), ISNULL(MaxSelectedItems,0) FROM OrderTagGroups WHERE ISNULL(Hidden,0) = 0 ORDER BY SortOrder, Id;"))
            {
                var tg = new TagGroup { Id = Db.I(g[0]), Name = Db.S(g[1]), MinSelected = Db.I(g[2]), MaxSelected = Db.I(g[3]) };
                foreach (var t in Db.Query("SET NOCOUNT ON; SELECT Id, Name, ISNULL(Price,0) FROM OrderTags WHERE OrderTagGroupId = " + tg.Id + " ORDER BY SortOrder, Id;"))
                    tg.Tags.Add(J.Obj("id", Db.I(t[0]), "name", Db.S(t[1]), "price", J.NumVal(Db.N(t[2]))));
                groups.Add(tg);
            }
            return groups;
        }
        public static Dictionary<string, object> TagGroupJson(TagGroup g)
        {
            return J.Obj("id", g.Id, "name", g.Name, "minSelected", g.MinSelected, "maxSelected", g.MaxSelected, "tags", g.Tags.Cast<object>().ToList());
        }

        public static List<Category> LiveMenu(long? screenMenuId, string priceTag)
        {
            string menuFilter = screenMenuId.HasValue ? "AND sc.ScreenMenuId = " + screenMenuId.Value : "";
            string priceExpr = priceTag != null
                ? @"COALESCE(
                    (SELECT TOP 1 Price FROM MenuItemPrices WHERE MenuItemPortionId = mpo.Id AND PriceTag = N'" + Db.Esc(priceTag) + @"'),
                    (SELECT TOP 1 Price FROM MenuItemPrices WHERE MenuItemPortionId = mpo.Id AND PriceTag IS NULL),
                    (SELECT TOP 1 Price FROM MenuItemPrices WHERE MenuItemPortionId = mpo.Id), 0)"
                : @"COALESCE(
                    (SELECT TOP 1 Price FROM MenuItemPrices WHERE MenuItemPortionId = mpo.Id AND PriceTag IS NULL),
                    (SELECT TOP 1 Price FROM MenuItemPrices WHERE MenuItemPortionId = mpo.Id), 0)";
            string q = @"SET NOCOUNT ON;
                SELECT sc.Id, sc.Name, sc.SortOrder, si.Id, COALESCE(NULLIF(si.Name,''), mi.Name), si.SortOrder, mpo.Id, mpo.Name, " + priceExpr + @"
                FROM ScreenMenuItems si
                JOIN ScreenMenuCategories sc ON sc.Id = si.ScreenMenuCategoryId
                JOIN MenuItems mi ON mi.Id = si.MenuItemId
                JOIN MenuItemPortions mpo ON mpo.MenuItemId = mi.Id
                WHERE 1=1 " + menuFilter + @"
                ORDER BY sc.SortOrder, sc.Id, si.SortOrder, si.Id, mpo.Id;";
            var cats = new List<Category>();
            var catById = new Dictionary<string, Category>();
            var itemByKey = new Dictionary<string, Item>();
            foreach (var r in Db.Query(q))
            {
                string catId = Db.S(r[0]), itemId = Db.S(r[3]);
                double price = Db.N(r[8]);
                Category cat;
                if (!catById.TryGetValue(catId, out cat)) { cat = new Category { Id = catId, Name = Db.S(r[1]) }; catById[catId] = cat; cats.Add(cat); }
                string key = catId + ":" + itemId;
                Item item;
                if (!itemByKey.TryGetValue(key, out item)) { item = new Item { Id = itemId, Name = Db.S(r[4]), Price = price, CategoryName = cat.Name }; itemByKey[key] = item; cat.Items.Add(item); }
                item.Portions.Add(new Portion { Id = Db.S(r[6]), Name = Db.S(r[7]), Price = price });
            }
            return cats;
        }

        public static List<object> LiveScreenMenus()
        {
            return Db.Query("SET NOCOUNT ON; SELECT Id, Name FROM ScreenMenus ORDER BY Id;").Select(r => (object)J.Obj("id", Db.I(r[0]), "name", Db.S(r[1]))).ToList();
        }

        public static Dictionary<string, object> TerminalConfigOptions()
        {
            Func<string, List<object>> names = sql => Db.Query(sql).Select(r => (object)Db.S(r[1])).ToList();
            return J.Obj(
                "terminals", names("SET NOCOUNT ON; SELECT Id, Name FROM Terminals ORDER BY Id;"),
                "departments", names("SET NOCOUNT ON; SELECT Id, Name FROM Departments ORDER BY Id;"),
                "ticketTypes", names("SET NOCOUNT ON; SELECT Id, Name FROM TicketTypes ORDER BY Id;"),
                "menus", names("SET NOCOUNT ON; SELECT Id, Name FROM ScreenMenus ORDER BY Id;"),
                "entityScreens", Db.Query("SET NOCOUNT ON; SELECT es.Id, es.Name, et.Name AS EntityTypeName FROM EntityScreens es LEFT JOIN EntityTypes et ON et.Id = es.EntityTypeId ORDER BY es.Id;")
                    .Select(r => (object)J.Obj("name", Db.S(r[1]), "entityType", r[2] == null ? null : Db.S(r[2]))).ToList(),
                "automationCommands", names("SET NOCOUNT ON; SELECT Id, Name FROM AutomationCommands ORDER BY Id;"));
        }

        static long MasaTypeId()
        {
            var r = Db.Query("SET NOCOUNT ON; SELECT TOP 1 Id FROM EntityTypes WHERE Name = N'Masalar';");
            return r.Count > 0 ? Db.I(r[0][0]) : 2;
        }

        public static List<object> LiveTables()
        {
            try
            {
                long typeId = MasaTypeId();
                var flat = Db.Query("SET NOCOUNT ON; SELECT Id, Name FROM Entities WHERE EntityTypeId = " + typeId + " ORDER BY Name;");
                var sections = new List<Dictionary<string, object>>();
                var bySection = new Dictionary<string, Dictionary<string, object>>();
                foreach (var t in flat)
                {
                    string name = Db.S(t[1]);
                    string first = (name.Length > 0 ? name.Substring(0, 1) : "?").ToUpper(J.Tr);
                    string section = Regex.IsMatch(first, "^[A-Z]$") ? first + " Blok" : "Masalar";
                    Dictionary<string, object> sec;
                    if (!bySection.TryGetValue(section, out sec)) { sec = J.Obj("name", section, "tables", new List<object>()); bySection[section] = sec; sections.Add(sec); }
                    ((List<object>)sec["tables"]).Add(J.Obj("id", Db.I(t[0]), "name", name));
                }
                return sections.Cast<object>().ToList();
            }
            catch (Exception ex) { Log.Write("Masa listesi hatası: " + ex.Message); return new List<object>(); }
        }

        public class Table { public long Id; public string Name; }
        public static Table FindTableByName(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            try
            {
                long typeId = MasaTypeId();
                string target = name.Trim();
                var all = Db.Query("SET NOCOUNT ON; SELECT Id, Name FROM Entities WHERE EntityTypeId = " + typeId + ";");
                var found = all.FirstOrDefault(t => Db.S(t[1]) == target);
                if (found == null)
                {
                    Func<string, string> norm = s => Regex.Replace(s, @"\s+", "").ToLower(J.Tr);
                    string tn = norm(target);
                    found = all.FirstOrDefault(t => norm(Db.S(t[1])) == tn);
                }
                return found == null ? null : new Table { Id = Db.I(found[0]), Name = Db.S(found[1]) };
            }
            catch (Exception ex) { Log.Write("Masa arama hatası: " + ex.Message); return null; }
        }

        public static long[] FindOpenTableTicket(long tableEntityId)
        {
            var r = Db.Query(@"SET NOCOUNT ON;
                SELECT TOP 1 t.Id, t.TicketNumber FROM Tickets t
                JOIN TicketEntities te ON te.Ticket_Id = t.Id
                WHERE te.EntityId = " + tableEntityId + @" AND te.EntityTypeId = 2 AND t.TicketTypeId = 1 AND t.IsClosed = 0
                ORDER BY t.Id DESC;");
            return r.Count > 0 ? new[] { Db.I(r[0][0]), Db.I(r[0][1]) } : null;
        }

        public class PrinterRouting { public Dictionary<string, string> ByCategory = new Dictionary<string, string>(); public string DefaultPrinter; }
        public static PrinterRouting GetKitchenPrinterRouting()
        {
            var pr = new PrinterRouting();
            try
            {
                foreach (var r in Db.Query(@"SET NOCOUNT ON;
                    SELECT pm.MenuItemGroupCode, p.ShareName FROM PrinterMaps pm JOIN Printers p ON p.Id = pm.PrinterId
                    WHERE pm.PrintJobId = (SELECT TOP 1 Id FROM PrintJobs WHERE Name = N'Siparişleri Mutfağa Yazdır') ORDER BY pm.Id;"))
                {
                    string code = r[0] == null ? "" : Db.S(r[0]), share = Db.S(r[1]);
                    if (code.Length == 0 || code == "NULL") { if (pr.DefaultPrinter == null) pr.DefaultPrinter = share; continue; }
                    if (!pr.ByCategory.ContainsKey(code)) pr.ByCategory[code] = share;
                }
            }
            catch (Exception ex) { Log.Write("Yazıcı yönlendirme okunamadı: " + ex.Message); }
            return pr;
        }

        public static Dictionary<string, object> GetTableOrderSummary(string tableName)
        {
            var table = FindTableByName(tableName);
            if (table == null) return null;
            var ticket = FindOpenTableTicket(table.Id);
            if (ticket == null) return null;
            var list = Db.Query("SET NOCOUNT ON; SELECT MenuItemName, PortionName, Price, Quantity FROM Orders WHERE TicketId = " + ticket[0] + " AND CalculatePrice = 1 ORDER BY Id;")
                .Select(i => J.Obj("name", Db.S(i[0]), "portion", Db.S(i[1]), "price", J.NumVal(Db.N(i[2])), "quantity", J.NumVal(Db.N(i[3])))).ToList();
            double total = list.Sum(i => J.Num(i["price"]) * J.Num(i["quantity"]));
            return J.Obj("ticketNumber", ticket[1], "items", list.Cast<object>().ToList(), "total", J.NumVal(total));
        }

        // ---------------------------------------------------------- PIN
        static readonly Regex AdminRoleRe = new Regex("admin|yonetici|patron|mudur|sahib|owner|manager|supervisor");
        static string NormRole(string s)
        {
            return (s ?? "").ToLower(J.Tr).Replace('ı', 'i').Replace('ö', 'o').Replace('ü', 'u').Replace('ş', 's').Replace('ç', 'c').Replace('ğ', 'g');
        }
        public class PinResult { public bool Found, IsAdmin; public string UserName, Role; }
        public static PinResult CheckPin(object pin)
        {
            try { return CheckPinOnce(pin); }
            catch { Thread.Sleep(1500); return CheckPinOnce(pin); }   // ara sira "Login timeout expired" - bir kez daha
        }
        static PinResult CheckPinOnce(object pinObj)
        {
            string pin = Regex.Replace(J.S(pinObj), @"\s+", "");
            if (!Regex.IsMatch(pin, @"^\d+$")) return new PinResult();
            var roles = Db.Query("SET NOCOUNT ON; SELECT Id, Name FROM UserRoles;");
            bool anyAdminNamed = roles.Any(r => AdminRoleRe.IsMatch(NormRole(Db.S(r[1]))));
            var users = Db.Query(@"SET NOCOUNT ON;
                SELECT TOP 10 u.Name, ISNULL(u.UserRole_Id, 0), ISNULL(r.Name, '')
                FROM Users u LEFT JOIN UserRoles r ON r.Id = u.UserRole_Id
                WHERE LTRIM(RTRIM(u.PinCode)) = N'" + Db.Esc(pin) + "';");
            if (users.Count == 0) return new PinResult();
            Func<object[], bool> isAdmin = u => anyAdminNamed ? AdminRoleRe.IsMatch(NormRole(Db.S(u[2]))) : Db.I(u[1]) == 1;
            var admin = users.FirstOrDefault(isAdmin);
            var sel = admin ?? users[0];
            return new PinResult { Found = true, IsAdmin = admin != null, UserName = Db.S(sel[0]), Role = Db.S(sel[2]) };
        }

        // ---------------------------------------------------------- Siparis
        static string NetDateNow() { return "/Date(" + J.NowMs() + "+0300)/"; }

        static long NextNumerator(string name)
        {
            var r = Db.Query("SET NOCOUNT ON; UPDATE Numerators SET Number = Number + 1 OUTPUT INSERTED.Number WHERE Name = N'" + Db.Esc(name) + "';");
            if (r.Count == 0) throw new Exception("Numaratör bulunamadı: " + name);
            return Db.I(r[0][0]);
        }

        static long _qrUserId;
        static long QrMenuUserId()
        {
            if (_qrUserId > 0) return _qrUserId;
            var f = Db.Query("SET NOCOUNT ON; SELECT TOP 1 Id FROM Users WHERE Name = N'QR Menü';");
            if (f.Count > 0) return _qrUserId = Db.I(f[0][0]);
            var role = Db.Query("SET NOCOUNT ON; SELECT TOP 1 Id FROM UserRoles WHERE LOWER(Name) LIKE N'%entegrasyon%' ORDER BY Id;");
            long roleId = role.Count > 0 ? Db.I(role[0][0]) : 1;
            var ins = Db.Query("SET NOCOUNT ON; INSERT INTO Users (Name, UserRole_Id, SevenShiftsEmployeeId) VALUES (N'QR Menü', " + roleId + ", 0); SELECT SCOPE_IDENTITY() AS id;");
            return _qrUserId = Db.I(ins[0][0]);
        }

        static long _custEntityTypeId;
        static long CustomerEntityTypeId()
        {
            if (_custEntityTypeId > 0) return _custEntityTypeId;
            var f = Db.Query("SET NOCOUNT ON; SELECT TOP 1 Id FROM EntityTypes WHERE Name = N'QR Menü' ORDER BY Id;");
            if (f.Count > 0) return _custEntityTypeId = Db.I(f[0][0]);
            var t = Db.Query("SET NOCOUNT ON; SELECT TOP 1 AccountTypeId, WarehouseTypeId, AccountNameTemplate, PrimaryFieldName FROM EntityTypes WHERE Name = N'Müşteriler' ORDER BY Id;");
            long acc = t.Count > 0 ? Db.I(t[0][0]) : 0, wh = t.Count > 0 ? Db.I(t[0][1]) : 0;
            string tpl = t.Count > 0 && Db.S(t[0][2]).Length > 0 ? Db.Esc(Db.S(t[0][2])) : "[Name]-[Telefon]";
            string pf = t.Count > 0 && Db.S(t[0][3]).Length > 0 ? Db.Esc(Db.S(t[0][3])) : "Adı";
            var ins = Db.Query("SET NOCOUNT ON; INSERT INTO EntityTypes (SortOrder, EntityName, AccountTypeId, WarehouseTypeId, AccountNameTemplate, PrimaryFieldName, Name) VALUES (0, N'Müşteri', " +
                acc + ", " + wh + ", N'" + tpl + "', N'" + pf + "', N'QR Menü'); SELECT SCOPE_IDENTITY() AS id;");
            _custEntityTypeId = Db.I(ins[0][0]);
            Log.Write("\"QR Menü\" varlık tipi otomatik oluşturuldu (Id: " + _custEntityTypeId + ")");
            return _custEntityTypeId;
        }
        static long? _custAccountTypeId;
        static long CustomerAccountTypeId()
        {
            if (_custAccountTypeId.HasValue) return _custAccountTypeId.Value;
            long et = CustomerEntityTypeId();
            var f = Db.Query("SET NOCOUNT ON; SELECT AccountTypeId FROM EntityTypes WHERE Id=" + et + ";");
            _custAccountTypeId = f.Count > 0 ? Db.I(f[0][0]) : 0;
            return _custAccountTypeId.Value;
        }
        static long[] FindCustomerEntity(string phoneDigits)
        {
            if (string.IsNullOrEmpty(phoneDigits)) return null;
            long et = CustomerEntityTypeId();
            var f = Db.Query("SET NOCOUNT ON; SELECT TOP 1 Id, COALESCE(AccountId,0) FROM Entities WHERE EntityTypeId=" + et + " AND Name=N'" + Db.Esc(phoneDigits) + "';");
            return f.Count > 0 ? new[] { Db.I(f[0][0]), Db.I(f[0][1]) } : null;
        }

        static string Q(string json) { return json.Replace("'", "''"); }

        // order: server tarafinda olusturulan siparis nesnesi (orders.json'daki sekil)
        public static Dictionary<string, object> CreateOrder(Dictionary<string, object> order)
        {
            var items = J.LL(J.Get(order, "items")).Select(J.DD).ToList();
            if (items.Count == 0) throw new Exception("Sepet boş.");
            string orderType = J.S(order, "type"); if (orderType.Length == 0) orderType = "delivery";
            string tableNumber = J.S(order, "tableNumber"), customerName = J.S(order, "customerName"), phone = J.S(order, "phone"),
                address = J.S(order, "address"), note = J.S(order, "note"), zone = J.S(order, "zone");
            long userId = QrMenuUserId();
            double total = items.Sum(i => J.Num(i, "price") * J.Num(i, "quantity"));
            string phoneDigits = Regex.Replace(phone, @"\D", "");
            string now = NetDateNow();

            long ticketId = 0, ticketNumber = 0; bool appended = false;
            Table tableEntity = null;
            if (orderType == "table" && tableNumber.Length > 0)
            {
                tableEntity = FindTableByName(tableNumber);
                if (tableEntity == null) throw new Exception("Masa \"" + tableNumber + "\" SambaPOS'ta bulunamadı. Lütfen /admin > Masalar sekmesinden güncel QR kodu kullanın.");
                var existing = FindOpenTableTicket(tableEntity.Id);
                if (existing != null) { ticketId = existing[0]; ticketNumber = existing[1]; appended = true; }
            }

            long orderNumber = NextNumerator("Sipariş Numaratörü");
            var lines = new System.Text.StringBuilder();
            foreach (var item in items)
            {
                string portionName = J.S(item, "portionName"); if (portionName.Length == 0) portionName = "Adet";
                string orderStates = Q(J.Str(new List<object> { J.Obj("D", now, "S", "Gönderildi", "SN", "Status", "SV", "", "U", userId) }));
                string orderUid = Crypto.Uuid();
                var tags = J.LL(J.Get(item, "tags")).Select(J.DD).ToList();
                string tagsJson = tags.Count > 0
                    ? Q(J.Str(tags.Select(t =>
                        {
                            var v = J.Obj("TN", J.S(t, "name"), "TV", J.S(t, "name"), "UI", userId, "OI", J.NumVal(J.Num(t, "groupId")), "OK", orderUid);
                            double pr = J.Num(t, "price");
                            if (J.Finite(pr) && pr != 0) { v["PR"] = J.NumVal(pr); v["AP"] = true; }
                            return (object)v;
                        }).ToList()))
                    : "[]";
                lines.Append(@"
                  INSERT INTO Orders (TicketId, WarehouseId, DepartmentId, TerminalId, MenuItemId, MenuItemName, PortionName, Price, Quantity,
                    PortionCount, Locked, CalculatePrice, DecreaseInventory, IncreaseInventory, OrderNumber, CreatingUserName,
                    CreatedDateTime, LastUpdateDateTime, AccountTransactionTypeId, DisablePortionSelection, OrderUid, Taxes, OrderTags, OrderStates)
                    VALUES (@ticketId, 1, 1, 1, " + Db.Num(J.Num(item, "menuItemId")) + ", N'" + Db.Esc(J.S(item, "name")) + "', N'" + Db.Esc(portionName) + "', " +
                    Db.Num(J.Num(item, "price")) + ", " + Db.Num(J.Num(item, "quantity")) + @",
                    1, 0, 1, 1, 0, " + orderNumber + @", N'QR Menü',
                    GETDATE(), GETDATE(), 3, 0, N'" + orderUid + "', N'[]', N'" + tagsJson + "', N'" + orderStates + "');");
            }

            if (appended)
            {
                Db.Query(@"SET NOCOUNT ON; SET XACT_ABORT ON;
                  BEGIN TRANSACTION;
                  DECLARE @ticketId INT = " + ticketId + @";
                  DECLARE @ver DATETIME = DATEADD(ms, -DATEPART(ms, GETDATE()), GETDATE());
                  UPDATE Tickets SET TotalAmount = TotalAmount + " + Db.Num(total) + ", TotalAmountPreTax = TotalAmountPreTax + " + Db.Num(total) + @",
                    RemainingAmount = RemainingAmount + " + Db.Num(total) + @", LastOrderDate = GETDATE(), LastUpdateTime = GETDATE(), TicketVersion = @ver
                    WHERE Id = @ticketId;
                  " + lines + @"
                  COMMIT TRANSACTION;");
                Log.Write("Mevcut açık adisyona eklendi: Masa " + tableEntity.Name + " (TicketId: " + ticketId + ", No: " + ticketNumber + ")");
            }
            else
            {
                ticketNumber = NextNumerator("Adisyon Numaratörü");
                int ticketTypeId = orderType == "table" ? 1 : orderType == "delivery" ? 2 : 3;
                var tagList = new List<object> {
                    J.Obj("TN", "Adres", "TT", 0, "TV", address), J.Obj("TN", "Telefon", "TT", 0, "TV", phone),
                    J.Obj("TN", "Müşteri Adı", "TT", 0, "TV", customerName), J.Obj("TN", "Bölge", "TT", 0, "TV", zone),
                    J.Obj("TN", "Sipariş Tipi", "TT", 0, "TV", orderType) };
                if (tableNumber.Length > 0) tagList.Add(J.Obj("TN", "Masa", "TT", 0, "TV", tableNumber));
                var states = new List<object> { J.Obj("D", now, "S", "QR Menü", "SN", "Kaynak", "SV", ""), J.Obj("D", now, "S", "Ödenmedi", "SN", "Durum", "SV", "") };
                if (orderType == "delivery") { states.Insert(0, J.Obj("D", now, "S", "Bekliyor", "SN", "Paket Durumu", "SV", "")); states.Insert(0, J.Obj("D", now, "S", "Paket", "SN", "Paket", "SV", "")); }
                else if (orderType == "pickup") { states.Insert(0, J.Obj("D", now, "S", "Bekliyor", "SN", "Paket Durumu", "SV", "")); states.Insert(0, J.Obj("D", now, "S", "Gel-Al", "SN", "Paket", "SV", "")); }
                string noteEsc = Db.Esc((customerName.Length > 0 ? customerName : "QR Müşteri") + " - " + (note.Length > 0 ? note : "Servis İstiyorum"));
                string tableSql = (orderType == "table" && tableEntity != null)
                    ? "INSERT INTO TicketEntities (Ticket_Id, EntityId, EntityTypeId, EntityName, EntityCustomData, AccountId, AccountTypeId) VALUES (@ticketId, " + tableEntity.Id + ", 2, N'" + Db.Esc(tableEntity.Name) + "', N'[]', 0, 0);"
                    : "";
                var res = Db.Query(@"SET NOCOUNT ON; SET XACT_ABORT ON;
                  BEGIN TRANSACTION;
                  DECLARE @docId INT, @ticketId INT;
                  DECLARE @ver DATETIME = DATEADD(ms, -DATEPART(ms, GETDATE()), GETDATE());
                  INSERT INTO AccountTransactionDocuments (Date, UserId, UserName, DocumentTypeId, Name)
                    VALUES (GETDATE(), " + userId + ", N'QR Menü', 0, N'Ticket Transaction [" + ticketNumber + @"]');
                  SET @docId = SCOPE_IDENTITY();
                  INSERT INTO Tickets (LastUpdateTime, TicketVersion, TicketNumber, Date, LastOrderDate, LastPaymentDate, PreOrder, IsClosed, IsLocked, IsOpened,
                    RemainingAmount, TotalAmount, TotalAmountPreTax, DepartmentId, TerminalId, TicketTypeId, Note,
                    LastModifiedUserName, CreatedUserName, TicketTags, TicketStates, LineSeparators, ExchangeRate, TaxIncluded, TransactionDocument_Id, TicketUid)
                    VALUES (GETDATE(), @ver, " + ticketNumber + @", GETDATE(), GETDATE(), GETDATE(), 0, 0, 0, 0,
                      " + Db.Num(total) + ", " + Db.Num(total) + ", " + Db.Num(total) + ", 1, 1, " + ticketTypeId + ", N'" + noteEsc + @"',
                      N'QR Menü', N'QR Menü', N'" + Q(J.Str(tagList)) + "', N'" + Q(J.Str(states)) + @"', N'[]', 1, 1, @docId, CONVERT(nvarchar(50), NEWID()));
                  SET @ticketId = SCOPE_IDENTITY();
                  " + tableSql + @"
                  " + lines + @"
                  COMMIT TRANSACTION;
                  SELECT @ticketId AS id;");
                ticketId = Db.I(res[0][0]);
                if (tableEntity != null) Log.Write("Masa bağlandı: " + tableEntity.Name + " (TicketId: " + ticketId + ", EntityId: " + tableEntity.Id + ")");
            }

            if (orderType != "table" && !appended)
            {
                try
                {
                    long custType = CustomerEntityTypeId(), custAcc = CustomerAccountTypeId();
                    var existing = FindCustomerEntity(phoneDigits);
                    string customData = Q(J.Str(new List<object> {
                        J.Obj("Name", "Müşteri Adı", "Value", customerName), J.Obj("Name", "Adres", "Value", address),
                        J.Obj("Name", "Bölge", "Value", zone), J.Obj("Name", "Not", "Value", note) }));
                    string entName = Db.Esc(phoneDigits.Length > 0 ? phoneDigits : (customerName.Length > 0 ? customerName : "Müşteri"));
                    if (existing == null)
                    {
                        string accountName = Db.Esc((customerName.Length > 0 ? customerName : (phoneDigits.Length > 0 ? phoneDigits : "Müşteri")) + "-" + phoneDigits);
                        var acc = Db.Query("SET NOCOUNT ON; INSERT INTO Accounts (AccountTypeId, ForeignCurrencyId, Name) VALUES (" + custAcc + ", 0, N'" + accountName + "'); SELECT SCOPE_IDENTITY() AS id;");
                        long accId = Db.I(acc[0][0]);
                        var ent = Db.Query("SET NOCOUNT ON; INSERT INTO Entities (EntityTypeId, LastUpdateTime, CustomData, AccountId, WarehouseId, Name) VALUES (" + custType +
                            ", GETDATE(), N'" + customData + "', " + accId + ", 0, N'" + entName + "'); SELECT SCOPE_IDENTITY() AS id;");
                        existing = new[] { Db.I(ent[0][0]), accId };
                        Log.Write("Yeni müşteri varlığı oluşturuldu (EntityId: " + existing[0] + ", AccountId: " + accId + ")");
                    }
                    Db.Query("SET NOCOUNT ON; INSERT INTO TicketEntities (Ticket_Id, EntityId, EntityTypeId, EntityName, EntityCustomData, AccountId, AccountTypeId) VALUES (" +
                        ticketId + ", " + existing[0] + ", " + custType + ", N'" + entName + "', N'" + customData + "', " + existing[1] + ", " + custAcc + ");");
                }
                catch (Exception ex) { Log.Write("Müşteri bağlama hatası: " + ex.Message); }
            }
            return J.Obj("ticketId", ticketId, "ticketNumber", ticketNumber, "total", J.NumVal(total), "type", orderType, "tableNumber", tableNumber, "appendedToExisting", appended);
        }

        public static int SyncClosedPaketDurumu()
        {
            const string OLD = "\"S\":\"Bekliyor\",\"SN\":\"Paket Durumu\"";
            const string NEW = "\"S\":\"Teslim Edildi\",\"SN\":\"Paket Durumu\"";
            var r = Db.Query(@"SET NOCOUNT ON;
                DECLARE @guncellenen TABLE (Id int);
                UPDATE Tickets SET TicketStates = REPLACE(TicketStates, N'" + OLD + "', N'" + NEW + @"')
                  OUTPUT INSERTED.Id INTO @guncellenen
                  WHERE CreatedUserName = N'QR Menü' AND IsClosed = 1 AND TicketStates LIKE N'%" + OLD + @"%';
                SELECT Id FROM @guncellenen;");
            if (r.Count > 0) Log.Write("Paket Durumu senkronize edildi: " + r.Count + " adisyon (" + string.Join(", ", r.Select(x => Db.S(x[0]))) + ")");
            return r.Count;
        }

        public static void DeleteTicketByNumber(object ticketNumber)
        {
            var f = Db.Query("SET NOCOUNT ON; SELECT TOP 1 Id, TransactionDocument_Id FROM Tickets WHERE TicketNumber = " + Db.Num(J.Num(ticketNumber)) + ";");
            if (f.Count == 0) throw new Exception("Adisyon No " + J.S(ticketNumber) + " SambaPOS'ta bulunamadı (zaten silinmiş olabilir).");
            long tid = Db.I(f[0][0]), doc = Db.I(f[0][1]);
            Db.Query("SET NOCOUNT ON; DELETE FROM Orders WHERE TicketId = " + tid + "; DELETE FROM TicketEntities WHERE Ticket_Id = " + tid +
                "; DELETE FROM Tickets WHERE Id = " + tid + ";" + (doc != 0 ? " DELETE FROM AccountTransactionDocuments WHERE Id = " + doc + ";" : ""));
        }
    }
}
