'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const html = fs.readFileSync('public/index.html', 'utf8');
const home = [html, ...['css', 'js'].map(ext => fs.readFileSync('public/assets/' + ext + '/storefront.' + ext, 'utf8'))].join('\n');
const care = fs.readFileSync('public/customer-care.html', 'utf8');
const returns = fs.readFileSync('public/return-refund-policy.html', 'utf8');
const server = ['storefront', 'customers'].map(name => fs.readFileSync('services/store/' + name + '.js', 'utf8')).join('\n');
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS ' + passed + ': ' + name); }
  catch (error) { console.error('FAIL: ' + name + '\n' + error.message); process.exitCode = 1; }
}
function includesAll(content, values) {
  for (const value of values) assert.ok(content.includes(value), 'Missing: ' + value);
}

check('Mobile header, search and account/cart controls', () => {
  const header = fs.readFileSync('public/assets/js/store-header.js', 'utf8');
  new vm.Script(header);
  includesAll(header, ['site-wordmark','id="menuBtn"','id="mobileSearchBtn"','id="bagBtn"']);
  includesAll(home, ['data-storefront src="/store-header.js"','mobile-promo','@media(max-width:720px)']);
  for (const name of fs.readdirSync('public').filter(name => name.endsWith('.html') && name !== 'admin.html')) {
    const page = fs.readFileSync('public/' + name, 'utf8');
    assert.equal((page.match(/src="\/store-header\.js"/g) || []).length, 1, name + ' needs one shared storefront header');
  }
});
check('Navigation, editorial category cards and actual catalogue wiring', () => {
  includesAll(home, ['mobile-store-menu', 'mobile-menu-collections', 'data-menu-close', 'data-collection="men"', 'data-collection="women"', 'data-collection="jackets"', 'class="collection-photo"', 'function collectionMatches(p,key)', 'products = catalogueProducts(p.products)']);
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
check('Page JavaScript and linked storefront assets load from their assigned directories', () => {
  for (const file of fs.readdirSync('public/assets/js')) {
    const path = 'public/assets/js/' + file;
    new vm.Script(fs.readFileSync(path, 'utf8'), { filename: path });
  }
  includesAll(html, ['href="/assets/css/storefront.css"', 'src="/assets/js/storefront.js"']);
  assert.ok(home.includes('src="/aerlon-concierge.js"'), 'Concierge script is not loaded');
  const concierge = fs.readFileSync('public/assets/js/aerlon-concierge.js', 'utf8');
  try { new vm.Script(concierge, { filename: 'public/assets/js/aerlon-concierge.js' }); } catch (error) { throw new Error('Concierge script: ' + error.stack); }
  includesAll(concierge, ['Contact Customer Agent', 'wa.me/919648629929', 'ac-quick', 'ac-typing', 'Step-by-Step Guide', '/api/orders/track']);
});
check('AERLON account V2 responsive pages and reset lifecycle', () => {
  const pages = [];
  require('../services/store/account-pages')({ get(url, handler) {
    handler({}, { type() { return this; }, send(html) { pages.push(html); } });
  } });
  assert.equal(pages.length, 3);
  const authCSS = fs.readFileSync('public/assets/css/account-pages.css', 'utf8');
  const authJS = fs.readFileSync('public/assets/js/account-pages.js', 'utf8');
  new vm.Script(authJS, { filename: 'public/assets/js/account-pages.js' });
  pages.forEach((page, index) => {
    includesAll(page, ['href="/account-pages.css"', 'src="/account-pages.js"', 'id="loginForm"', 'id="signupForm"', 'id="requestResetForm"', 'id="newPasswordForm"', 'name="referrer" content="no-referrer"']);
    assert.ok(!page.includes('Contact support'), 'Contact support callout should not appear in account designs ' + index);
    const ids = [...page.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, 'Duplicate form field IDs');
  });
  includesAll(authCSS, ['@media(max-width:720px)', 'grid-template-columns:minmax(340px,44%)', '[hidden]{display:none!important}']);
  includesAll(authJS, ['/api/auth/login', '/api/auth/signup', '/api/auth/forgot-password', '/api/auth/reset-password', 'location.assign(shopUrl())']);
  includesAll(server, ['resetUrl.pathname = "/reset-password.html"', 'resetUrl.searchParams.set("token", rawToken)']);
  assert.ok(!home.includes('<div class="mobile-promo"><span>THE AERLON EDIT'), 'Old mobile promotional banner must be removed');
  includesAll(home, ['#announcementStrip[hidden]{display:none}', "location.assign('/login.html')"]);
  assert.doesNotMatch(home, /(?:\.announce|#announcementStrip)\s*\{\s*display:\s*none/);
});
check('Bag and menu links run once across refresh and history traversal', () => {
  const source = home.slice(home.indexOf('function takeStorefrontPanel()'), home.indexOf('async function init()'));
  assert.ok(source.includes('function resetTransientPanels()'));
  for (const panel of ['bag', 'menu', 'search', 'wishlist-bag']) {
    for (const type of ['navigate', 'reload', 'back_forward']) {
      const location = { href: 'https://aerlon.in/?q=linen&panel=' + panel + '&product=shirt#shop' };
      const state = { previous: 'collection' };
      let replacements = 0;
      const history = { state, replaceState(value, title, path) {
        assert.equal(value, state);
        location.href = new URL(path, location.href).href;
        replacements++;
      }};
      const calls = [];
      const context = vm.createContext({ URL, location, history,
        performance: { getEntriesByType: () => [{type}] },
        showBag: open => calls.push(open),
        closeModal: id => calls.push(id),
        byId: () => ({setAttribute: (name, value) => calls.push([name, value].join('='))})
      });
      vm.runInContext(source, context);
      assert.equal(vm.runInContext('pendingStorefrontPanel?.panel', context), type === 'navigate' ? panel : undefined);
      const clean = new URL(location.href);
      assert.equal(clean.searchParams.has('panel'), false);
      assert.equal(clean.searchParams.get('q'), 'linen');
      assert.equal(clean.searchParams.get('product'), panel === 'wishlist-bag' ? null : 'shirt');
      assert.equal(clean.hash, '#shop');
      assert.equal(vm.runInContext('takeStorefrontPanel()', context), null);
      assert.equal(replacements, 1);
      vm.runInContext('resetTransientPanels(); resetTransientPanels()', context);
      assert.equal(vm.runInContext('pendingStorefrontPanel', context), null);
      assert.deepEqual(calls, [false,'settingsModal','aria-expanded=false',false,'settingsModal','aria-expanded=false']);
    }
  }
});
async function checkAdminExpiry() {
  const source = fs.readFileSync('services/store/session-policy.js', 'utf8');
  const issuedAt = 1_000_000;
  let now = issuedAt;
  class TestDate extends Date { static now() { return now; } }
  const module = { exports: {} };
  vm.runInNewContext(source, { module, Date: TestDate });
  const remainingSession = module.exports.remainingSession;
  const minute = 60_000;
  const idle = 30 * minute;
  const absolute = 8 * 60 * minute;

  function fakePool(initialActivity = null) {
    let lastActivity = initialActivity;
    return { async query(sql, [sid, issued, idleMs, absoluteMs]) {
      assert.equal(sid, 'test-session-id');
      assert.equal(issued.getTime(), issuedAt);
      assert.equal(idleMs, idle);
      assert.equal(absoluteMs, absolute);
      assert.ok(sql.includes('expire > NOW()'), 'Only unexpired stored sessions may be renewed');
      const deadline = Math.min(issuedAt + absolute, (lastActivity ?? issuedAt) + idle);
      if (now >= deadline) return { rows: [] };
      if (sql.startsWith('UPDATE')) lastActivity = Math.max(lastActivity ?? issuedAt, now);
      return { rows: [{ remaining: Math.min(issuedAt + absolute, (lastActivity ?? issuedAt) + idle) - now }] };
    } };
  }

  for (const role of ['owner', 'staff']) {
    const req = { sessionID: 'test-session-id', session: { admin: { role, issuedAt } } };
    const pool = fakePool();
    now = issuedAt;
    assert.equal(await remainingSession(pool, req, 'admin', false), idle);
    now = issuedAt + 29 * minute;
    assert.equal(await remainingSession(pool, req, 'admin', false), minute);
    assert.equal(await remainingSession(pool, req, 'admin', true), idle);
    now = issuedAt + 58 * minute;
    assert.equal(await remainingSession(pool, req, 'admin', false), minute);
    assert.equal(await remainingSession(pool, req, 'admin', true), idle);
    for (let elapsed = 80 * minute; elapsed < absolute; elapsed += 20 * minute) {
      now = issuedAt + elapsed;
      assert.equal(await remainingSession(pool, req, 'admin', true), Math.min(idle, absolute - elapsed));
    }
    now = issuedAt + absolute;
    assert.equal(await remainingSession(pool, req, 'admin', true), 0);
    const idlePool = fakePool();
    now = issuedAt + idle;
    assert.equal(await remainingSession(idlePool, req, 'admin', true), 0, 'Idle sessions must not revive');
  }
  now = issuedAt;
  assert.equal(await remainingSession(fakePool(), { session: { admin: {} } }, 'admin', true), 0);
  assert.equal(await remainingSession(fakePool(), { session: { admin: { issuedAt: issuedAt + 1 } } }, 'admin', true), 0);
}
checkAdminExpiry().then(() => {
  passed++;
  console.log('PASS ' + passed + ': Admin idle sliding expiry, eight-hour maximum and no revival');
  console.log(passed + '/8 AERLON build checks passed.');
}).catch(error => {
  console.error('FAIL: admin session policy', error);
  process.exitCode = 1;
});
