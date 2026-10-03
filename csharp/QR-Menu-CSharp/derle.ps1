# AlfaPOS QR Menü (C#) - Windows'un kendi csc.exe'si ile derler (kurulumdaki ayni komut).
# Cikti: QRMenuSrv.exe (bu klasorde). Node.js / NSSM / sqlcmd GEREKMEZ.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (!(Test-Path $csc)) { $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
$src = Get-ChildItem kaynak\*.cs | ForEach-Object { $_.FullName }
$ico = Join-Path $PSScriptRoot 'kaynak\alfapos.ico'
$args2 = @('/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/out:QRMenuSrv.exe',
    '/reference:System.ServiceProcess.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Data.dll',
    '/reference:System.Core.dll', '/reference:System.Drawing.dll')
if (Test-Path $ico) { $args2 += "/win32icon:$ico" }
& $csc $args2 $src
if ($LASTEXITCODE -ne 0) { throw "Derleme hatasi" }
Get-Item QRMenuSrv.exe | Select-Object Name, Length, LastWriteTime
