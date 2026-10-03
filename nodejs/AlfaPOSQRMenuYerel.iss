; AlfaPOS QR Menü - Inno Setup 6 ile kurulum programi uretir.
; C:\SambaPOS Menu\SambaPOS Menu (musterinin kendi calisan referans uygulamasi)
; genellestirilmis motorundan uretilmistir. Restoranin kendi bilgisayarinda
; calisan TAM bir web sunucusu (menu + siparis + admin paneli, port 4500,
; LAN'da dogrudan erisim) + BULUT TUNELI (19.09.2026 eklendi): app.ornek-alanadi.com/qrmenu
; ve menu.ornek-alanadi.com uzerinden, port yonlendirme/genel IP GEREKMEDEN uzaktan
; da erisilebilir (bkz. tunnel.js). Giris artik 2 adimli: once bulut
; e-posta/sifre, sonra SambaPOS PIN'i (Kurye/Patron ile ayni desen).
#define AppName "AlfaPOS QR Menü"
#define AppVersion "1.6.8"
#define AppPublisher "AlfaPOS"
#define AppExeName "AlfaPOSQRMenu"

[Setup]
; NOT (20.09.2026, kullanici karari: "yerel ismini cikart artik") - AppId AYNI
; kalir (mevcut kurulumlarin uzerine dogru guncellensin diye), sadece disariya
; gorunen isimler/dosya adlarindan "Yerel" kaldirildi - artik tamamen bulut
; tunelli calistigi icin "yerel" ifadesi yanlis izlenim veriyordu.
AppId={{6C2E9F3A-1D5B-4E8C-9A2F-QRMENUYEREL1}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
; 30.09.2026, kullanici istegi: "direk alfapos veya sambapos dosya konumuna kopyalayabiliyor
; muyuz ... veya yolu biz manuel gosterelim" - varsayilan klasor SambaPOS/AlfaPOS kurulum
; klasorunun ICINDEKI QRMenu (bkz. VarsayilanKlasor), klasor sayfasi HER ZAMAN gosterilir,
; istenirse Gozat ile baska yol secilir. Guncellemede onceki klasor aynen korunur.
DefaultDirName={code:VarsayilanKlasor}
DisableDirPage=no
UsePreviousAppDir=yes
OutputDir=dist
OutputBaseFilename=AlfaPOSQRMenuSetup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
SetupIconFile=assets\alfapos.ico
UninstallDisplayIcon={app}\assets\alfapos.ico

[Files]
Source: "server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "sql.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "sambapos.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "menu-editor.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "distance.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "license.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "tunnel.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "upsell.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "updater.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "node_modules\*"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
; index.html restoranin VERISIDIR (menu duzenleyici urunleri buraya yazar) - yeniden kurulumda EZILMEZ (30.09.2026)
Source: "index.html"; DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "reviews-strip.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "admin-icons.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "yeni.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "siparis.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "tv.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "iletisim.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "gizlilik-politikasi.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "garson.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "garson-web\*"; DestDir: "{app}\garson-web"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "garson-manifest.webmanifest"; DestDir: "{app}"; Flags: ignoreversion
Source: "manifest.webmanifest"; DestDir: "{app}"; Flags: ignoreversion
Source: "admin\*"; DestDir: "{app}\admin"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "nssm.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-requirements.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-services.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "remove-services.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "Servisi-Yeniden-Kur.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "Servisi-Durdur.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "config.example.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs

[Tasks]
Name: "desktopicon"; Description: "Masaüstüne kısayol oluştur"; GroupDescription: "Ek kısayollar:"

[Icons]
Name: "{group}\Servisi Yeniden Kur"; Filename: "{app}\Servisi-Yeniden-Kur.cmd"; WorkingDir: "{app}"
Name: "{group}\Servisi Durdur"; Filename: "{app}\Servisi-Durdur.cmd"; WorkingDir: "{app}"
Name: "{autodesktop}\QR Menü - Servisi Yeniden Kur"; Filename: "{app}\Servisi-Yeniden-Kur.cmd"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{autodesktop}\QR Menü - Servisi Durdur"; Filename: "{app}\Servisi-Durdur.cmd"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install-requirements.ps1"""; StatusMsg: "Gereksinimler kuruluyor (Node.js)..."; Flags: waituntilterminated runhidden
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install-services.ps1"""; StatusMsg: "Servis kuruluyor ve başlatılıyor..."; Flags: waituntilterminated
Filename: "http://localhost:4500/admin"; Description: "Yönetim panelini aç"; Flags: postinstall shellexec skipifsilent nowait

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\remove-services.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveServices"

[Code]
var
  DBPage: TInputQueryWizardPage;
  LicensePage: TInputQueryWizardPage;

{ POS programinin kurulu oldugu klasoru bulur: once Windows "Program Ekle/Kaldir"
  kaydi (32/64 bit), sonra bilinen klasorler. Bulunamazsa eski varsayilan. }
function PosKlasoru(Ad: String): String;
var
  Anahtarlar: TArrayOfString;
  I: Integer;
  Yol, Isim: String;
  Kok: String;
begin
  Result := '';
  Kok := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall';
  if RegGetSubkeyNames(HKLM32, Kok, Anahtarlar) then
    for I := 0 to GetArrayLength(Anahtarlar) - 1 do
      if RegQueryStringValue(HKLM32, Kok + '\' + Anahtarlar[I], 'DisplayName', Isim) and
         (Pos(Uppercase(Ad), Uppercase(Isim)) = 1) and
         (Pos('QR', Uppercase(Isim)) = 0) and
         RegQueryStringValue(HKLM32, Kok + '\' + Anahtarlar[I], 'InstallLocation', Yol) and
         (Trim(Yol) <> '') and DirExists(RemoveBackslashUnlessRoot(Yol)) then
      begin
        Result := RemoveBackslashUnlessRoot(Yol);
        Exit;
      end;
  if IsWin64 and RegGetSubkeyNames(HKLM64, Kok, Anahtarlar) then
    for I := 0 to GetArrayLength(Anahtarlar) - 1 do
      if RegQueryStringValue(HKLM64, Kok + '\' + Anahtarlar[I], 'DisplayName', Isim) and
         (Pos(Uppercase(Ad), Uppercase(Isim)) = 1) and
         (Pos('QR', Uppercase(Isim)) = 0) and
         RegQueryStringValue(HKLM64, Kok + '\' + Anahtarlar[I], 'InstallLocation', Yol) and
         (Trim(Yol) <> '') and DirExists(RemoveBackslashUnlessRoot(Yol)) then
      begin
        Result := RemoveBackslashUnlessRoot(Yol);
        Exit;
      end;
end;

function VarsayilanKlasor(Param: String): String;
var
  P: String;
begin
  P := PosKlasoru('SambaPOS');
  if P = '' then P := PosKlasoru('AlfaPOS5');
  if (P = '') and DirExists(ExpandConstant('{commonpf32}\SambaPOS5')) then P := ExpandConstant('{commonpf32}\SambaPOS5');
  if (P = '') and DirExists(ExpandConstant('{commonpf32}\AlfaPOS5')) then P := ExpandConstant('{commonpf32}\AlfaPOS5');
  if P <> '' then
    Result := P + '\QRMenu'
  else
    Result := ExpandConstant('{autopf}\AlfaPOS\QRMenu');
end;

procedure InitializeWizard;
begin
  { 28.09.2026, kullanici istegi: "anlatarak ilerlesin" - tek bir yoğun sayfaya
    sikistirmak yerine, once veritabani ayarlari, SONRA ayri bir sayfada
    lisans/aktivasyon - her adimda ne yapildigini/neden gerektigini anlatan
    aciklama metniyle, AlfaPOS ailesinin kurumsal olcekli bir urunu oldugu
    hissini veren tanitim cumlesiyle birlikte. }
  DBPage := CreateInputQueryPage(wpSelectDir,
    'Veritabanı Ayarları',
    'AlfaPOS QR Menü, AlfaPOS ailesinin bir parçası olarak restoranınızın SambaPOS/AlfaPOS ' +
    'veritabanına doğrudan bağlanan, menü - sipariş - mutfak - masa yönetimini gerçek zamanlı ' +
    'senkronize eden kurumsal ölçekli bir işletme yazılımıdır. Önce veritabanı bağlantısını ' +
    'kuralım, bir sonraki adımda bulut lisansınızı aktive edeceğiz.',
    'SQL Server alanlarını BOŞ bırakabilirsiniz - program açılışta ' +
    'C:\ProgramData\SambaPOS veya C:\ProgramData\AlfaPOS altındaki ayar dosyasından ' +
    'bağlantı bilgisini OTOMATİK bulmayı dener. Bulamazsa/yanlış giderse buradan ' +
    'elle girebilirsiniz.');
  DBPage.Add('SQL Server adresi  (boş = otomatik bul):', False);
  DBPage.Add('Veritabanı adı  (boş = otomatik bul):', False);
  DBPage.Add('SQL kullanıcı adı  (boş = otomatik bul / Windows kimliği):', False);
  DBPage.Add('SQL şifresi  (boş = otomatik bul):', True);

  LicensePage := CreateInputQueryPage(DBPage.ID,
    'Lisans ve Aktivasyon',
    'Veritabanı ayarları tamamlandı. Şimdi restoranınızı AlfaPOS Bulut hesabınıza bağlayacak ' +
    'aktivasyon anahtarını girin - bu anahtar; yönetim panelinizi (app.ornek-alanadi.com/qrmenu), ' +
    'müşteri menüsünü, kiosk ekranını ve TV menüsünü otomatik olarak restoranınıza bağlar.',
    'Aktivasyon anahtarınızı AlfaPOS Bulut yönetim panelinden veya bayinizden temin edebilirsiniz.');
  LicensePage.Add('Bulut aktivasyon anahtarı:', False);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (PageID = DBPage.ID) and FileExists(ExpandConstant('{app}\config.json')) then
    Result := True;
  if (PageID = LicensePage.ID) and FileExists(ExpandConstant('{app}\config.json')) then
    Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = LicensePage.ID then
  begin
    { SQL sunucu/veritabani BOS birakilabilir - sql.js acilista C:\ProgramData\
      SambaPOS veya C:\ProgramData\AlfaPOS altindaki ayar dosyasindan bunu
      OTOMATIK bulmayi dener (20.09.2026 - kullanici istegi: kurulumu
      kolaylastir). SADECE aktivasyon anahtari otomatik bulunamayacagi icin
      hala zorunlu. }
    if Trim(LicensePage.Values[0]) = '' then
    begin
      MsgBox('Bulut aktivasyon anahtarı boş bırakılamaz - yönetim panelinden alın.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function JsonEscape(S: String): String;
begin
  StringChangeEx(S, '\', '\\', True);
  StringChangeEx(S, '"', '\"', True);
  Result := S;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigPath: String;
  JsonContent: String;
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
        '  "options": {' + #13#10 +
        '    "encrypt": false,' + #13#10 +
        '    "trustServerCertificate": true' + #13#10 +
        '  },' + #13#10 +
        '  "port": 4500,' + #13#10 +
        '  "activationKey": "' + JsonEscape(Trim(LicensePage.Values[0])) + '",' + #13#10 +
        '  "cloudServerUrl": "https://app.ornek-alanadi.com",' + #13#10 +
        '  "siteSettings": { "companyName": "Restoranınız" },' + #13#10 +
        '  "deliveryZones": [],' + #13#10 +
        '  "sambaposMenuId": null,' + #13#10 +
        '  "directOrderSend": false,' + #13#10 +
        '  "adminEmails": []' + #13#10 +
        '}';
      SaveStringToFile(ConfigPath, JsonContent, False);
    end;
  end;
end;
