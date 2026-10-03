@echo off
REM Cift tiklaninca dogrudan calisabilsin diye kendini yonetici olarak
REM yukseltir (Windows guvenligi geregi TEK bir UAC onayi istenir, bu
REM atlanamaz/otomatiklestirilemez - ama kullanici sag tik/"Yonetici olarak
REM calistir" YAPMAK ZORUNDA KALMAZ, sadece UAC penceresinde Evet'e basar).
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0install-services.ps1\"'"
