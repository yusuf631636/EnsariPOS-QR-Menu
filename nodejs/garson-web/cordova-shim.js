/* Web-tarayıcı uyumluluk katmanı (20.09.2026, kullanıcı isteği: "apk'daki
   özellikleri garson'a koysan iPhone da girebilir") - bu dosya, orijinal
   Cordova/Android uygulamasının kullandığı native köprüleri (device,
   navigator.notification, cordova.getAppVersion) düz bir web sayfasında
   TAKLIT eder, böylece index.html/ticket.html/Config.html vb. dosyalar
   HİÇ DEĞİŞTİRİLMEDEN (aynı kod) hem APK'da hem tarayıcıda çalışır.
   Bu dosya cordova.js'İN YERİNE yüklenir (cordova.js artık kullanılmıyor). */
(function () {
    "use strict";

    // device.uuid - tarayıcıda kalıcı, rastgele bir kimlik üretir.
    var DEVICE_ID_KEY = 'web_device_uuid';
    var uuid = localStorage.getItem(DEVICE_ID_KEY);
    if (!uuid) {
        uuid = 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(DEVICE_ID_KEY, uuid);
    }
    window.device = { uuid: uuid, platform: 'Web', version: navigator.userAgent, model: 'Browser' };

    // navigator.notification.* - Cordova'nın dialogs eklentisinin yerini
    // tarayıcının kendi alert/confirm'ü alır.
    window.navigator.notification = window.navigator.notification || {
        alert: function (message, callback, title) {
            window.alert((title ? title + '\n\n' : '') + (message || ''));
            if (callback) callback();
        },
        confirm: function (message, callback, title, buttonLabels) {
            var ok = window.confirm((title ? title + '\n\n' : '') + (message || ''));
            if (callback) callback(ok ? 1 : 2);
        },
        beep: function () { /* sessiz - index.html kendi WebAudio beep'ini kullanıyor */ },
        vibrate: function (ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 200); } catch (e) { /* desteklenmiyor */ } }
    };

    // cordova.getAppVersion.getVersionNumber
    window.cordova = window.cordova || {};
    window.cordova.getAppVersion = window.cordova.getAppVersion || {
        getVersionNumber: function (callback) { callback('web'); }
    };

    // Uygulama kodu "deviceready" olayını bekliyor - tarayıcıda bu olay hiç
    // ateşlenmez, burada sayfa yüklenir yüklenmez BİZ ateşliyoruz.
    function fireDeviceReady() {
        document.dispatchEvent(new Event('deviceready'));
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(fireDeviceReady, 0);
    } else {
        document.addEventListener('DOMContentLoaded', fireDeviceReady);
    }
})();
