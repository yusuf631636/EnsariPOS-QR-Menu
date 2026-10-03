# AlfaPOS QR Menü (C# sürüm) - otomatik guncelleme yayini.
# Kullanim: once surum.txt'yi artir (ve .iss AppVersion), sonra:  .\yayinla.ps1
# Cikti: C:\Projeler\1-Bulut\public\qrmenu-cs-update\version.json + f\<sha256>.bin
# (ham .bin - Cloudflare HTML'i yolda degistirebiliyor). Restoranlardaki C# servisi saatte bir bakar,
# SHA-256 dogrular, program dosyasi degistiyse kendini yeniden baslatir. index.html (restoranin menusu),
# config.json ve veri dosyalari ASLA gonderilmez.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$web = "C:\Projeler\4-QR-Menu"
$out = "C:\Projeler\1-Bulut\public\qrmenu-cs-update"
$version = ([IO.File]::ReadAllText("$PSScriptRoot\surum.txt")).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "surum.txt gecersiz: $version" }

& "$PSScriptRoot\derle.ps1" | Out-Null

$files = New-Object System.Collections.ArrayList
function Add([string]$rel, [string]$full) { [void]$files.Add(@{ rel = $rel; full = $full }) }
Add 'QRMenuSrv.exe' "$PSScriptRoot\QRMenuSrv.exe"
Add 'surum.txt' "$PSScriptRoot\surum.txt"
foreach ($f in 'yeni.html','siparis.html','tv.html','iletisim.html','gizlilik-politikasi.html','garson.html','reviews-strip.js','manifest.webmanifest','garson-manifest.webmanifest') { Add $f "$web\$f" }
Get-ChildItem "$web\admin" -File | ForEach-Object { Add ("admin/" + $_.Name) $_.FullName }
Get-ChildItem "$web\garson-web" -File | ForEach-Object { Add ("garson-web/" + $_.Name) $_.FullName }

$safe = '^(?:[a-zA-Z0-9_-]+/)?[a-zA-Z0-9_.-]+\.(?:html|css|json|webmanifest|js|png|txt|exe)$'
New-Item -ItemType Directory -Force "$out\f" | Out-Null
$list = @()
foreach ($f in $files) {
    if ($f.rel -notmatch $safe) { Write-Host "atlandi (guvenli yol degil): $($f.rel)" -ForegroundColor DarkGray; continue }
    $hash = (Get-FileHash $f.full -Algorithm SHA256).Hash.ToLowerInvariant()
    Copy-Item $f.full "$out\f\$hash.bin" -Force
    $list += '    { "path": "' + $f.rel + '", "sha256": "' + $hash + '" }'
}
$json = "{`n  ""version"": ""$version"",`n  ""publishedAt"": ""$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"",`n  ""files"": [`n" + ($list -join ",`n") + "`n  ]`n}"
[IO.File]::WriteAllText("$out\version.json", $json, (New-Object Text.UTF8Encoding($false)))
Write-Host "Yayinlandi: C# surum $version, $($list.Count) dosya -> $out" -ForegroundColor Green
