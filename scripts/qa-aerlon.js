'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const home = fs.readFileSync('public/index.html', 'utf8');
const care = fs.readFileSync('public/customer-care.html', 'utf8');
const returns = fs.readFileSync('public/return-refund-policy.html', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS ' + passed + ': ' + name); }
  catch (error) { console.error('FAIL: ' + name + '\n' + error.message); process.exitCode = 1; }
}
function includesAll(content, values) {
  for (const value of values) assert.ok(content.includes(value), 'Missing: ' + value);
}

check('Mobile header, search and account/cart controls', () => {
  includesAll(home, ['site-wordmark', 'id="menuBtn"', 'id="mobileSearchBtn"', 'id="bagBtn"', 'mobile-promo', '@media(max-width:720px)']);
});
check('Navigation, editorial category cards and actual catalogue wiring', () => {
  includesAll(home, ['mobile-store-menu', 'mobile-menu-collections', 'data-menu-close', 'data-collection="men"', 'data-collection="women"', 'data-collection="jackets"', 'class="collection-photo"', 'function collectionMatches(p,key)', 'products = p.products']);
});
check('Footer is collapsible on mobile and retains owner-managed settings', () => {
  includesAll(home, ['function prepareFooterAccordions()', 'aria-expanded', 'mc-footer-link-list', 'function applyFooterColumns(columns)', "fetch('/api/storefront/footer'", 'data-footer-action="track"', 'footerNewsletterForm']);
  includesAll(server, ['async function getFooterSettings()', 'app.get("/api/storefront/footer"', 'app.put("/api/admin/storefront/footer"']);
});
check('Customer care, policy window, privacy and official WhatsApp are consistent', () => {
  includesAll(care, ['+91 96486 29929', 'https://wa.me/919648629929', '3 days after delivery', '/return-refund-policy.html', 'OTP']);
  includesAll(returns, ['+91 96486 29929', 'https://wa.me/919648629929', '3 days after delivery', 'subject to confirmation']);
  includesAll(home, ['/customer-care.html', '/return-refund-policy.html', '3-day request']);
});
check('Storefront inline JavaScript parses correctly', () => {
  const inlineScripts = [...home.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(source => source.trim());
  assert.ok(inlineScripts.length, 'Storefront inline JavaScript was not found');
  inlineScripts.forEach((source, index) => new vm.Script(source, { filename: 'public/index.html (inline script ' + (index + 1) + ')' }));
  assert.ok(home.includes('src="/aerlon-concierge.js"'), 'Concierge script is not loaded');
  const concierge = fs.readFileSync('public/aerlon-concierge.js', 'utf8');
  try { new vm.Script(concierge, { filename: 'public/aerlon-concierge.js' }); } catch (error) { throw new Error('Concierge script: ' + error.stack); }
  includesAll(concierge, ['Contact Customer Agent', 'wa.me/919648629929', 'ac-quick', 'ac-typing', 'Step-by-Step Guide', '/api/orders/track']);
});
console.log(passed + '/5 AERLON build checks passed.');
if (process.exitCode) process.exit(process.exitCode);
