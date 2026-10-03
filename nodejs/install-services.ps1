# AlfaPOS QR Menü (Yerel) - NSSM ile TEK Windows servisi kurar. QRMenuAjan'dan
# FARKI: bu bir web sunucusu (varsayilan port 4500) - dis dunyadan (musteri
# telefonlarindan) erisilebilmesi icin Windows Guvenlik Duvari kurali da eklenir
# (QRMenuAjan/KuryeBulutAjan sadece disa istek attigi icin bu adima gerek yoktu).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Bu script Yonetici olarak calistirilmalidir (Windows servisi kurmak icin gerekli). Kurulum programi (setup.exe) bunu otomatik yukseltilmis olarak calistirir.' }

$nssm = Join-Path $PSScriptRoot 'nssm.exe'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'node.exe bulunamadi. install-requirements.ps1 calistirin.' }
$nodeExe = $nodeCmd.Source

if (-not (Test-Path (Join-Path $PSScriptRoot 'config.json'))) {
  throw 'config.json bulunamadi. Kurulum sihirbazi bunu olusturmus olmali - eksikse config.example.json''i kopyalayip elle doldurun.'
}

$port = 4500
try {
  $cfg = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
  if ($cfg.port) { $port = [int]$cfg.port }
} catch { Write-Warning "config.json okunamadi, varsayilan port 4500 kullanilacak." }

$name = 'AlfaPOSQRMenuYerel'
$runtimeDir = Join-Path $env:ProgramData 'AlfaPOS\QRMenuYerel'
$logDir = Join-Path $runtimeDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
  Write-Host "$name zaten kurulu, durdurup guncelleniyor..." -ForegroundColor Yellow
  & $nssm stop $name 2>&1 | Out-Null
  & $nssm remove $name confirm 2>&1 | Out-Null
}
& $nssm install $name $nodeExe 2>&1 | Out-Null
# AppParameters dogrudan registry'ye yazilir - QRMenuAjan/install-services.ps1'deki
# ayni gerekce (boslukli kurulum yollarinda NSSM CLI'sinin tirnakli string
# aktarma davranisi guvenilmez sekilde bozuluyor).
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$name\Parameters" -Name AppParameters -Value "`"$PSScriptRoot\server.js`""
& $nssm set $name AppDirectory $PSScriptRoot 2>&1 | Out-Null
& $nssm set $name AppStdout (Join-Path $logDir 'server.log') 2>&1 | Out-Null
& $nssm set $name AppStderr (Join-Path $logDir 'server.err.log') 2>&1 | Out-Null
& $nssm set $name Start SERVICE_AUTO_START 2>&1 | Out-Null
& $nssm set $name AppExit Default Restart 2>&1 | Out-Null
& $nssm set $name AppThrottle 15000 2>&1 | Out-Null

try {
  Remove-NetFirewallRule -DisplayName 'AlfaPOS QR Menü (Yerel)' -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName 'AlfaPOS QR Menü (Yerel)' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
} catch {
  Write-Warning "Güvenlik duvarı kuralı eklenemedi (port $port) - müşteri telefonları menüye erişemeyebilir, elle izin vermeniz gerekebilir: $($_.Exception.Message)"
}

& $nssm start $name 2>&1 | Out-Null
Start-Sleep -Seconds 3
$service = Get-Service -Name $name -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne 'Running') {
  & $nssm stop $name 2>&1 | Out-Null
  Start-Sleep -Seconds 1
  & $nssm start $name 2>&1 | Out-Null
  Start-Sleep -Seconds 3
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
}

Write-Host ''
if ($service -and $service.Status -eq 'Running') {
  Write-Host "$name çalışıyor (port $port)." -ForegroundColor Green
  Write-Host 'Kurulum tamamlandı. Bilgisayar yeniden başlasa bile hizmet otomatik çalışacak.' -ForegroundColor Green
} else {
  Write-Warning "$name başlatılamadı (durum: $(if ($service) { $service.Status } else { 'kurulmadı' })). $logDir altındaki .err.log dosyasına bakın."
}
Start-Sleep -Seconds 3
