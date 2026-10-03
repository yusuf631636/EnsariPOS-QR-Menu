# AlfaPOS QR Menü (Yerel) - NSSM servisini ve guvenlik duvari kuralini kaldirir
# (kaldirma/guncelleme oncesi).
$ErrorActionPreference = 'SilentlyContinue'
Set-Location $PSScriptRoot
$nssm = Join-Path $PSScriptRoot 'nssm.exe'
if (Get-Service -Name 'AlfaPOSQRMenuYerel' -ErrorAction SilentlyContinue) {
  & $nssm stop 'AlfaPOSQRMenuYerel' | Out-Null
  & $nssm remove 'AlfaPOSQRMenuYerel' confirm | Out-Null
  Write-Host 'AlfaPOSQRMenuYerel kaldirildi.' -ForegroundColor Yellow
}
Remove-NetFirewallRule -DisplayName 'AlfaPOS QR Menü (Yerel)' -ErrorAction SilentlyContinue
