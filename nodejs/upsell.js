/* Capraz Satis / Upsell kural motoru - kullanici istegi (22.09.2026): mevcut
   menuyu/siparis akisini BOZMADAN, musteriyi rahatsiz etmeden (agresif pop-up
   YOK) ortalama sepet tutarini artirmak. Basit, kural-tabanli (AI KULLANMAZ,
   maliyetsiz) bir sistem: yonetici hangi KATEGORI'ye hangi URUN(ler)in
   onerilecegini tanimlar, musteri o kategoriden bir sey sepete ekleyince
   INLINE (pop-up degil) bir "Yanina Ekle" karti gosterilir.

   orders.json/calls.json ile AYNI desen: duz JSON dosyasi, veritabani yok. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const RULES_PATH = path.join(ROOT, 'upsell-rules.json');
const STATS_PATH = path.join(ROOT, 'upsell-stats.json');

function readRules() {
  try { const r = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8')); return Array.isArray(r) ? r : []; } catch { return []; }
}
function writeRules(rules) { fs.writeFileSync(RULES_PATH, JSON.stringify(rules, null, 2), 'utf8'); }

function activeRulesForCustomer() {
  // Musteri tarafina SADECE gosterim icin gerekli alanlar gider - iç yönetim
  // detaylarını (min tutar vb. varsa ileride) sızdırmaya gerek yok.
  return readRules().filter(r => r.active).map(r => ({
    id: r.id, triggerCategory: r.triggerCategory, suggestItemNames: r.suggestItemNames,
    message: r.message, buttonLabel: r.buttonLabel, scaleWithQty: !!r.scaleWithQty,
  }));
}

function upsertRule(input) {
  const rules = readRules();
  const triggerCategory = String(input.triggerCategory || '').trim();
  const suggestItemNames = Array.isArray(input.suggestItemNames) ? input.suggestItemNames.map(s => String(s).trim()).filter(Boolean) : [];
  const message = String(input.message || '').trim().slice(0, 140);
  const buttonLabel = String(input.buttonLabel || 'Ekle').trim().slice(0, 30);
  if (!triggerCategory) throw new Error('Tetikleyici kategori zorunlu.');
  if (!suggestItemNames.length) throw new Error('En az bir önerilecek ürün girin.');
  if (!message) throw new Error('Öneri mesajı zorunlu.');

  const rule = {
    id: input.id || crypto.randomUUID(),
    active: input.active !== false,
    triggerCategory, suggestItemNames, message, buttonLabel,
    scaleWithQty: !!input.scaleWithQty,
  };
  const idx = rules.findIndex(r => r.id === rule.id);
  if (idx === -1) rules.push(rule); else rules[idx] = rule;
  writeRules(rules);
  return rule;
}
function deleteRule(id) {
  const rules = readRules().filter(r => r.id !== id);
  writeRules(rules);
}

function readStats() {
  try { const s = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')); return Array.isArray(s) ? s : []; } catch { return []; }
}
function writeStats(stats) { fs.writeFileSync(STATS_PATH, JSON.stringify(stats.slice(-20000), null, 2), 'utf8'); }

/* event: 'impression' (kart gosterildi) | 'click' (musteri "Ekle" dedi) | 'decline' (musteri kapadi) */
function logEvent(ruleId, event) {
  if (!['impression', 'click', 'decline'].includes(event)) return;
  const rules = readRules();
  if (!rules.some(r => r.id === ruleId)) return; // silinmis/gecersiz kural - sessizce yoksay
  const stats = readStats();
  stats.push({ ruleId, event, time: new Date().toISOString() });
  writeStats(stats);
}

function statsSummary() {
  const rules = readRules();
  const stats = readStats();
  return rules.map(r => {
    const forRule = stats.filter(s => s.ruleId === r.id);
    const impressions = forRule.filter(s => s.event === 'impression').length;
    const clicks = forRule.filter(s => s.event === 'click').length;
    const conversionRate = impressions ? Math.round((clicks / impressions) * 1000) / 10 : 0;
    return { id: r.id, triggerCategory: r.triggerCategory, suggestItemNames: r.suggestItemNames, active: r.active, impressions, clicks, conversionRate };
  });
}

module.exports = { readRules, activeRulesForCustomer, upsertRule, deleteRule, logEvent, statsSummary };
