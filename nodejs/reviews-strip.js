/* Musteri menusu yorum seridi (30.09.2026).
   index.html RESTORANIN VERISIDIR (menu duzenleyici urunleri o dosyaya yazar) - bu yuzden
   serit index.html'e YAZILMAZ; sunucu bu dosyayi sayfayi gonderirken ekler
   (server.js renderSiteHtml). Google (gercek yorumlar) + siparis sonrasi musteri
   degerlendirmeleri + panelden girilenler; sunucu 4 saatte bir farkli secki verir,
   burada 6 sn'de bir doner. Kiosk'ta yok (kiosk siparis.html'dir). */
(function () {
  if (window.__rvStrip) return; window.__rvStrip = 1;
  var base = location.hostname === 'menu.ornek-alanadi.com' ? '/' + (location.pathname.split('/').filter(Boolean)[0] || '') : '';
  var css = '.rv-strip{max-width:900px;margin:12px auto 0;padding:0 14px}' +
    '.rv-card{display:flex;align-items:center;gap:12px;background:var(--card,#fff);border-radius:14px;box-shadow:var(--shadow,0 6px 18px rgba(0,0,0,.08));padding:10px 12px;border:1px solid rgba(0,0,0,.05)}' +
    '.rv-score{flex:none;text-align:center;min-width:64px;padding-right:10px;border-right:1px solid rgba(0,0,0,.08)}' +
    '.rv-score b{display:block;font-size:22px;color:var(--text,#2a1c14);line-height:1}' +
    '.rv-score i{display:block;font-style:normal;color:var(--gold,#c9a227);font-size:12px;letter-spacing:1px;margin-top:3px}' +
    '.rv-score small{display:block;color:var(--muted,#8a7a68);font-size:10.5px;margin-top:2px}' +
    '.rv-body{flex:1;min-width:0;transition:opacity .35s}' +
    '.rv-body .t{font-size:13.5px;color:var(--text,#2a1c14);line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
    '.rv-body .n{font-size:11.5px;color:var(--muted,#8a7a68);margin-top:3px}' +
    '.rv-write{flex:none;font-size:12px;font-weight:700;color:var(--brand,#3498db);text-decoration:none;white-space:nowrap}';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function stars(n) { return new Array(Math.max(1, Math.min(5, Math.round(n || 5))) + 1).join('★'); }
  function start() {
    fetch(base + '/api/reviews').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.enabled || !d.items || !d.items.length) return;
      var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
      var box = document.createElement('div');
      box.className = 'rv-strip';
      box.innerHTML = '<div class="rv-card"><div class="rv-score"><b></b><i></i><small></small></div>' +
        '<div class="rv-body"><div class="t"></div><div class="n"></div></div>' +
        (d.writeReviewUrl ? '<a class="rv-write" target="_blank" rel="noopener" href="' + esc(d.writeReviewUrl) + '">Yorum yaz ›</a>' : '') + '</div>';
      /* yeni.html (asil QR menu): "Paket Servis / Yol Tarifi / Calisma Saatleri" kutularinin alti;
         eski index.html: hizli islem dugmelerinin alti */
      var yeni = document.querySelector('#home .status');
      var anchor = yeni || document.querySelector('.quick-actions') || document.querySelector('header');
      if (yeni) box.style.padding = '0';
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor.nextSibling); else document.body.insertBefore(box, document.body.firstChild);
      box.querySelector('.rv-score b').textContent = d.rating ? String(Math.round(d.rating * 10) / 10).replace('.', ',') : '★';
      box.querySelector('.rv-score i').textContent = stars(d.rating || 5);
      box.querySelector('.rv-score small').textContent = d.count ? d.count + (d.source === 'google' ? ' Google yorumu' : ' yorum') : 'Misafir yorumları';
      var body = box.querySelector('.rv-body'), i = 0;
      function show() {
        var r = d.items[i % d.items.length]; i++;
        body.style.opacity = 0;
        setTimeout(function () {
          body.querySelector('.t').textContent = '“' + r.text + '”';
          body.querySelector('.n').innerHTML = esc(stars(r.rating)) + ' · ' + esc(r.name || 'Misafirimiz') + (r.source === 'google' ? ' · Google' : '');
          body.style.opacity = 1;
        }, 350);
      }
      show();
      if (d.items.length > 1) setInterval(show, 6000);
    }).catch(function () { /* yorum yoksa serit hic eklenmez */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
