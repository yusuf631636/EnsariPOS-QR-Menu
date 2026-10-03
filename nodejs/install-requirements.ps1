# QR Menü Ajani gereksinimlerini kontrol eder ve eksikse kurar.
# Hangi bilgisayara kurulursa kurulsun calisir. cloudflared/tunel GEREKMEZ -
# ajan sadece disa dogru HTTP istekleri yapar.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
Write-Host 'QR Menü Ajani gereksinimleri kontrol ediliyor...' -ForegroundColor Cyan

function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
}

function Install-WingetPackage($id, $name, $manualUrl) {
  if (Get-Command $name -ErrorAction SilentlyContinue) { Write-Host "$name zaten kurulu." -ForegroundColor DarkGray; return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Write-Warning "$name bulunamadi ve winget yok. Elle kurulum: $manualUrl"; return }
  Write-Host "$name kuruluyor (winget)..." -ForegroundColor Yellow
  try { winget install --id $id --exact --accept-package-agreements --accept-source-agreements --silent }
  catch { Write-Warning "$name kurulumu basarisiz (winget): $($_.Exception.Message)" }
  Refresh-Path
}
function Install-NodeDirect {
  if (Get-Command node -ErrorAction SilentlyContinue) { return }
  Write-Host 'Node.js dogrudan nodejs.org uzerinden kuruluyor...' -ForegroundColor Yellow
  $msiPath = Join-Path $env:TEMP 'node-lts-x64.msi'
  try {
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 20
    $lts = $index | Where-Object { $_.lts -ne $false } | Select-Object -First 1
    if (-not $lts) { throw 'nodejs.org dist listesinde LTS surumu bulunamadi.' }
    $url = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi"
    Invoke-WebRequest -Uri $url -OutFile $msiPath -TimeoutSec 120
    $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /quiet /norestart ADDLOCAL=ALL" -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw "msiexec cikis kodu $($proc.ExitCode)" }
  } catch {
    Write-Warning "Node.js dogrudan kurulumu basarisiz: $($_.Exception.Message)"
  } finally {
    Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
  }
  Refresh-Path
}

Install-WingetPackage 'OpenJS.NodeJS.LTS' 'node' 'https://nodejs.org/'
Install-NodeDirect
if (-not (Get-Command sqlcmd -ErrorAction SilentlyContinue)) {
  Install-WingetPackage 'Microsoft.Sqlcmd' 'sqlcmd' 'https://aka.ms/sqlcmd'
}

# Node.js olmadan ajan hic calismaz - sessizce gecmek yerine acikca uyariyoruz
# (C:\kurye takip / C:\ensari kurulumlarinda yasanan sessiz-basarisizlik hatasi).
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "Node.js otomatik kurulamadi (internet baglantisi olmayabilir veya winget bu bilgisayarda yok)." + [Environment]::NewLine + [Environment]::NewLine +
    "Ajan bu bilgisayarda CALISMAYACAK. Lutfen https://nodejs.org adresinden Node.js LTS'i elle kurup kurulumu tekrar calistirin.",
    'QR Menü Ajanı - Gereksinim eksik', 'OK', 'Warning'
  ) | Out-Null
  Write-Warning 'node.exe bulunamadi - kurulum YARIM kaldi.'
  exit 1
}

Write-Host 'Gereksinim kontrolu tamamlandi.' -ForegroundColor Green
exit 0
