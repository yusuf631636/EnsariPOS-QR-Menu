using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace QRMenu
{
    // Gelistirici testi: QRMenuSrv.exe /sqltest:siparis.json
    // Siparisi SAHTE veritabaniyla "yazar" - SambaPOS'a hicbir sey gitmez; uretilen SQL komutlarini yazdirir
    // (Node surumunun urettigi SQL ile karsilastirmak icin).
    public static class SqlTest
    {
        public static void Run(string orderFile)
        {
            var log = new StringBuilder();
            Db.Mock = sql =>
            {
                log.Append("---SQL---\n").Append(sql.Trim()).Append('\n');
                Func<long, List<object[]>> one = v => new List<object[]> { new object[] { v } };
                if (sql.Contains("FROM Users WHERE Name = N'QR Menü'")) return one(5);
                if (sql.Contains("UPDATE Numerators")) return one(1000);
                if (sql.Contains("FROM EntityTypes WHERE Name = N'QR Menü'")) return one(7);
                if (sql.Contains("FROM EntityTypes WHERE Name = N'Masalar'")) return one(2);
                if (sql.Contains("SELECT AccountTypeId FROM EntityTypes WHERE Id")) return one(3);
                if (sql.Contains("SELECT Id, Name FROM Entities WHERE EntityTypeId = 2")) return new List<object[]> { new object[] { 11L, "B10" } };
                if (sql.Contains("INSERT INTO Accounts")) return one(50);
                if (sql.Contains("INSERT INTO Entities")) return one(60);
                if (sql.Contains("SELECT @ticketId AS id")) return one(500);
                if (sql.Contains("FROM Tickets t") && Environment.GetEnvironmentVariable("SQLTEST_OPEN") == "1") return new List<object[]> { new object[] { 400L, 77L } };
                return new List<object[]>();
            };
            var order = J.ParseObj(File.ReadAllText(orderFile, Encoding.UTF8));
            var result = Samba.CreateOrder(order);
            log.Append("---RESULT---\n").Append(J.Str(result)).Append('\n');
            var o = Console.OpenStandardOutput();
            var b = new UTF8Encoding(false).GetBytes(log.ToString());
            o.Write(b, 0, b.Length);
        }
    }
}
