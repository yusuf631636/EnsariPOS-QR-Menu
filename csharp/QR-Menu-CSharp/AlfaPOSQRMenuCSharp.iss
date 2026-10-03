; AlfaPOS QR Menü - C# SÜRÜM (30.09.2026, kullanici istegi: "qrmenuyu C# diline cevir, garson gibi,
; lisansli, node bagimliligi kalmasin"). Kurulumda Windows'un KENDI csc.exe'si ile derlenir,
; "AlfaPOSQRMenuYerel" Windows servisi olarak kurulur. Node.js / NSSM / sqlcmd GEREKMEZ.
; AppId Node surumuyle AYNI: mevcut kurulumun uzerine kurulur, config.json / index.html / siparisler /
; urun resimleri korunur, ayni lisans (aktivasyon) anahtari kullanilir.
; Web sayfalari (menu, siparis, kiosk, TV, yonetim paneli) C:\Projeler\4-QR-Menu'den alinir.
#define AppName "AlfaPOS QR Menü"
#define AppVersion "2.0.0"
#define AppPublisher "AlfaPOS"
#define Web "C:\Projeler\4-QR-Menu"

[Setup]
AppId={{6C2E9F3A-1D5B-4E8C-9A2F-QRMENUYEREL1}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion} (C# sürüm)
AppPublisher={#AppPublisher}
AppPublisherURL=https://ornek-alanadi.com
DefaultDirName={code:VarsayilanKlasor}
DisableDirPage=no
UsePreviousAppDir=yes
DefaultGroupName=AlfaPOS QR Menü
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=AlfaPOSQRMenuCSharpSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
SetupIconFile=kaynak\alfapos.ico
UninstallDisplayIcon={app}\QRMenuSrv.exe
UninstallDisplayName={#AppName} (C# sürüm)
VersionInfoVersion={#AppVersion}.0
VersionInfoDescription={#AppName} (C#) Kurulum

[Languages]
Name: "tr"; MessagesFile: "compiler:Languages\Turkish.isl"

[Messages]
tr.WelcomeLabel2=Bu program AlfaPOS QR Menü'nün C# sürümünü kurar.%n%n• QR menü, masadan sipariş, paket servis, kiosk, TV menü ve yönetim paneli.%n• Node.js gerekmez; Windows servisi olarak çalışır, bilgisayar açılınca kendiliğinden başlar.%n• Eski QR Menü kuruluysa onun yerine geçer; menünüz, ayarlarınız ve siparişleriniz korunur.%n• Aynı lisans (aktivasyon) anahtarı kullanılır.

[Files]
; --- C# kaynak + hazir derlenmis yedek
Source: "kaynak\*.cs"; DestDir: "{app}\kur\kaynak"; Flags: ignoreversion
Source: "kaynak\alfapos.ico"; DestDir: "{app}\kur\kaynak"; Flags: ignoreversion
Source: "QRMenuSrv.exe"; DestDir: "{app}\kur"; DestName: "QRMenuSrv.prebuilt.exe"; Flags: ignoreversion
Source: "kur\QRMenu_Kurulum.ps1"; DestDir: "{app}\kur"; Flags: ignoreversion
Source: "kur\kaldir.ps1"; DestDir: "{app}\kur"; Flags: ignoreversion
Source: "kur\yeniden-baslat.bat"; DestDir: "{app}\kur"; Flags: ignoreversion
Source: "surum.txt"; DestDir: "{app}"; Flags: ignoreversion
; --- web sayfalari (index.html restoranin menusu: SADECE ilk kurulumda)
Source: "{#Web}\index.html"; DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#Web}\reviews-strip.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Web}\yeni.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Web}\siparis.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Web}\tv.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Web}\iletisim.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Web}\gizlilik-politikasi.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Web}\garson.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Web}\garson-web\*"; DestDir: "{app}\garson-web"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Web}\garson-manifest.webmanifest"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Web}\manifest.webmanifest"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Web}\admin\*"; DestDir: "{app}\admin"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Web}\config.example.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Web}\assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; eski Node surumunun program dosyalari (C# surumunde kullanilmiyor; veriler SILINMEZ)
Type: files; Name: "{app}\server.js"
Type: files; Name: "{app}\sql.js"
Type: files; Name: "{app}\sambapos.js"
Type: files; Name: "{app}\menu-editor.js"
Type: files; Name: "{app}\distance.js"
Type: files; Name: "{app}\license.js"
Type: files; Name: "{app}\tunnel.js"
Type: files; Name: "{app}\upsell.js"
Type: files; Name: "{app}\updater.js"
Type: files; Name: "{app}\admin-icons.js"
Type: files; Name: "{app}\nssm.exe"
Type: files; Name: "{app}\install-requirements.ps1"
Type: files; Name: "{app}\install-services.ps1"
Type: files; Name: "{app}\remove-services.ps1"
Type: files; Name: "{app}\Servisi-Yeniden-Kur.cmd"
Type: files; Name: "{app}\Servisi-Durdur.cmd"
Type: filesandordirs; Name: "{app}\node_modules"

[Tasks]
Name: "desktopicon"; Description: "Masaüstüne ""QR Menü Yönetim"" kısayolu oluştur"; GroupDescription: "Ek kısayollar:"

[Icons]
Name: "{group}\QR Menü Yönetim Paneli"; Filename: "http://localhost:4500/admin"
Name: "{group}\QR Menü Servisini Yeniden Başlat"; Filename: "{app}\kur\yeniden-baslat.bat"; WorkingDir: "{app}\kur"
Name: "{group}\QR Menü Kaldır"; Filename: "{uninstallexe}"
Name: "{autodesktop}\QR Menü Yönetim"; Filename: "http://localhost:4500/admin"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\kur\QRMenu_Kurulum.ps1"" -InstallDir ""{app}"" -Silent"; StatusMsg: "QR Menü servisi derleniyor ve kuruluyor..."; Flags: waituntilterminated runhidden
Filename: "http://localhost:4500/admin"; Description: "Yönetim panelini aç"; Flags: postinstall shellexec skipifsilent nowait

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\kur\kaldir.ps1"" -Silent"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveQrService"

[UninstallDelete]
Type: files; Name: "{app}\QRMenuSrv.exe"
Type: files; Name: "{app}\QRMenuSrv.exe.old"

[Code]
var
  DBPage: TInputQueryWizardPage;
  LicensePage: TInputQueryWizardPage;

{ POS programinin kurulu oldugu klasor (Program Ekle/Kaldir kaydi) - varsayilan: <POS>\QRMenu }
function PosKlasoruKok(Kok: Integer; Ad: String): String;
var
  Anahtarlar: TArrayOfString;
  I: Integer;
  Yol, Isim, Yer: String;
begin
  Result := '';
  Yer := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall';
  if RegGetSubkeyNames(Kok, Yer, Anahtarlar) then
    for I := 0 to GetArrayLength(Anahtarlar) - 1 do
      if RegQueryStringValue(Kok, Yer + '\' + Anahtarlar[I], 'DisplayName', Isim) and
         (Pos(Uppercase(Ad), Uppercase(Isim)) = 1) and (Pos('QR', Uppercase(Isim)) = 0) and
         RegQueryStringValue(Kok, Yer + '\' + Anahtarlar[I], 'InstallLocation', Yol) and
         (Trim(Yol) <> '') and DirExists(RemoveBackslashUnlessRoot(Yol)) then
      begin
        Result := RemoveBackslashUnlessRoot(Yol);
        Exit;
      end;
end;

function PosKlasoru(Ad: String): String;
begin
  Result := PosKlasoruKok(HKLM32, Ad);
  if (Result = '') and IsWin64 then Result := PosKlasoruKok(HKLM64, Ad);
end;

function VarsayilanKlasor(Param: String): String;
var
  P: String;
begin
  P := PosKlasoru('SambaPOS');
  if P = '' then P := PosKlasoru('AlfaPOS5');
  if (P = '') and DirExists(ExpandConstant('{commonpf32}\SambaPOS5')) then P := ExpandConstant('{commonpf32}\SambaPOS5');
  if (P = '') and DirExists(ExpandConstant('{commonpf32}\AlfaPOS5')) then P := ExpandConstant('{commonpf32}\AlfaPOS5');
  if P <> '' then Result := P + '\QRMenu'
  else Result := ExpandConstant('{autopf}\AlfaPOS\QRMenu');
end;

procedure InitializeWizard;
begin
  DBPage := CreateInputQueryPage(wpSelectDir,
    'Veritabanı Ayarları',
    'QR Menü restoranınızın SambaPOS/AlfaPOS veritabanına doğrudan bağlanır. Önce veritabanı bağlantısını kuralım, sonraki adımda lisansınızı etkinleştireceğiz.',
    'Alanları BOŞ bırakabilirsiniz - program C:\ProgramData\SambaPOS veya C:\ProgramData\AlfaPOS altındaki ayar dosyasından bağlantıyı OTOMATİK bulur.');
  DBPage.Add('SQL Server adresi  (boş = otomatik bul):', False);
  DBPage.Add('Veritabanı adı  (boş = otomatik bul):', False);
  DBPage.Add('SQL kullanıcı adı  (boş = otomatik bul / Windows kimliği):', False);
  DBPage.Add('SQL şifresi  (boş = otomatik bul):', True);

  LicensePage := CreateInputQueryPage(DBPage.ID,
    'Lisans ve Aktivasyon',
    'Restoranınızı AlfaPOS Bulut hesabınıza bağlayan aktivasyon anahtarını girin (diğer AlfaPOS ürünlerinde kullandığınız AYNI anahtar).',
    'Aktivasyon anahtarınızı AlfaPOS Bulut yönetim panelinden veya bayinizden temin edebilirsiniz.');
  LicensePage.Add('Bulut aktivasyon anahtarı:', False);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if ((PageID = DBPage.ID) or (PageID = LicensePage.ID)) and FileExists(ExpandConstant('{app}\config.json')) then
    Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = LicensePage.ID) and (Trim(LicensePage.Values[0]) = '') then
  begin
    MsgBox('Bulut aktivasyon anahtarı boş bırakılamaz - yönetim panelinden alın.', mbError, MB_OK);
    Result := False;
  end;
end;

{ calisan servis exe'yi kilitler - dosyalar kopyalanmadan once durdurulur (eski Node/NSSM surumu dahil) }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  rc: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop AlfaPOSQRMenuYerel', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM QRMenuSrv.exe', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Sleep(2500);
  Result := '';
end;

function JsonEscape(S: String): String;
begin
  StringChangeEx(S, '\', '\\', True);
  StringChangeEx(S, '"', '\"', True);
  Result := S;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigPath, JsonContent: String;
  Lines: TArrayOfString;
begin
  if CurStep = ssPostInstall then
  begin
    ConfigPath := ExpandConstant('{app}\config.json');
    if not FileExists(ConfigPath) then
    begin
      JsonContent :=
        '{' + #13#10 +
        '  "server": "' + JsonEscape(DBPage.Values[0]) + '",' + #13#10 +
        '  "database": "' + JsonEscape(DBPage.Values[1]) + '",' + #13#10 +
        '  "user": "' + JsonEscape(DBPage.Values[2]) + '",' + #13#10 +
        '  "password": "' + JsonEscape(DBPage.Values[3]) + '",' + #13#10 +
        '  "options": { "encrypt": false, "trustServerCertificate": true },' + #13#10 +
        '  "port": 4500,' + #13#10 +
        '  "activationKey": "' + JsonEscape(Trim(LicensePage.Values[0])) + '",' + #13#10 +
        '  "cloudServerUrl": "https://app.ornek-alanadi.com",' + #13#10 +
        '  "siteSettings": { "companyName": "Restoranınız" },' + #13#10 +
        '  "deliveryZones": [],' + #13#10 +
        '  "sambaposMenuId": null,' + #13#10 +
        '  "directOrderSend": false,' + #13#10 +
        '  "adminEmails": []' + #13#10 +
        '}';
      { UTF-8 (Turkce harfler bozulmasin - SaveStringToFile ANSI yazar) }
      Lines := [JsonContent];
      SaveStringsToUTF8File(ConfigPath, Lines, False);
    end;
  end;
end;
