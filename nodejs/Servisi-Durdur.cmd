@echo off
REM Servisi-Yeniden-Kur.cmd ile AYNI oz-yukseltme deseni.
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0remove-services.ps1\"'"
