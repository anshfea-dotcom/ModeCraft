(() => {
  'use strict';
  const mount = document.currentScript;
  const home = mount.hasAttribute('data-storefront');
  const template = document.createElement('template');
  template.innerHTML = `<header class="nav" id="storeHeader"><div class="navin">
<a class="brand site-wordmark" href="/#home" aria-label="AERLON home">AERLON<span>.</span></a>
<div class="navactions"><a class="aerlon-camera-link" href="/visual-search.html" aria-label="Search by image" title="Visual Search — search by image"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 7.5h4l1.7-2.5h5.6l1.7 2.5h4v11h-17z"/><circle cx="12" cy="13" r="3.4"/></svg></a><button class="iconbtn menu-trigger" id="menuBtn" title="Open menu" aria-label="Open menu" aria-expanded="false"><span class="hamburger-lines" aria-hidden="true"><i></i><i></i><i></i></span><span class="menu-trigger-label">MENU</span></button><button class="mobile-search-button" id="mobileSearchBtn" type="button" aria-label="Search products" title="Search products"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.8" cy="10.8" r="6.5"/><path d="m16 16 5 5"/></svg></button><button class="bag-icon-button" id="bagBtn" type="button" aria-label="Open shopping bag, 0 items" title="Shopping bag"><svg class="bag-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5.5 8.5h13l1 12h-15l1-12Z"/><path d="M9 9V6.5a3 3 0 0 1 6 0V9"/></svg><span class="bag-count" id="count">0</span></button></div>
</div><form class="aerlon-header-search" id="aerlonHeaderSearch" role="search"><label class="aerlon-header-search-field"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input id="aerlonHeaderSearchInput" type="search" autocomplete="off" placeholder="Search styles, collections and more…" aria-label="Search AERLON products"></label><button type="submit" aria-label="Submit product search">Search →</button></form></header>`;
  const header = template.content.firstElementChild;
  const styles = document.createElement('link');
  styles.rel = 'stylesheet';
  styles.href = '/store-header.css';
  if (home) {
    document.head.append(styles);
    mount.replaceWith(header);
  } else {
    const host = document.createElement('div');
    host.style.cssText = 'display:block;position:sticky;top:0;z-index:15';
    const shadow = host.attachShadow({mode:'open'});
    shadow.append(styles, header);
    mount.replaceWith(host);
    const navigate = panel => location.assign('/?panel=' + panel);
    header.querySelector('#menuBtn').onclick = () => navigate('menu');
    header.querySelector('#bagBtn').onclick = () => navigate('bag');
    const input = header.querySelector('input');
    header.querySelector('#mobileSearchBtn').onclick = () => input.focus();
    header.querySelector('form').onsubmit = event => {
      event.preventDefault();
      location.assign('/?q=' + encodeURIComponent(input.value.trim()) + '#shop');
    };
    function updateCount() {
      let count = 0;
      try {
        const cart = JSON.parse(localStorage.getItem('aerlon_cart_v1') || '[]');
        count = cart.reduce((total, item) => total + (Number(item?.quantity) || 0), 0);
      } catch { /* Keep the empty bag accessible if storage is unavailable. */ }
      header.querySelector('#count').textContent = count;
      header.querySelector('#bagBtn').setAttribute('aria-label', 'Open shopping bag, ' + count + (count === 1 ? ' item' : ' items'));
    }
    updateCount();
    window.addEventListener('pageshow', updateCount);
    window.addEventListener('storage', updateCount);
    fetch('/api/storefront/header').then(response => response.ok ? response.json() : {}).then(data => {
      if (data.header) applyBrand(data.header);
    }).catch(() => {});
  }
  function applyBrand(settings) {
    const brand = header.querySelector('.brand');
    if (settings.brandText?.trim()) {
      const name = settings.brandText.trim();
      brand.textContent = name;
      brand.setAttribute('aria-label', name + ' home');
      brand.title = name;
    }
    if (/^https:\/\//i.test(settings.logoUrl?.trim() || '')) {
      const logo = document.createElement('img');
      logo.src = settings.logoUrl.trim();
      logo.alt = settings.brandText || 'AERLON';
      brand.replaceChildren(logo);
    }
  }
  header.addEventListener('store-brand', event => applyBrand(event.detail));
  const measure = () => document.documentElement.style.setProperty('--store-header-height', Math.ceil(header.getBoundingClientRect().height) + 'px');
  measure();
  if (window.ResizeObserver) new ResizeObserver(measure).observe(header);
  window.addEventListener('resize', measure);
})();
