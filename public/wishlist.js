const wishKey = 'aerlon_wishlist_v1';
const grid = document.getElementById('grid');
const statusLine = document.getElementById('status');
const retry = document.getElementById('retry');
let catalogue = [];
let account = false;
let remoteIds = new Set();

function deviceIds() {
  const saved = JSON.parse(localStorage.getItem(wishKey) ?? localStorage.getItem('modecraft_wishlist_v1') ?? '[]');
  return Array.isArray(saved) ? saved.map(String) : [];
}

async function request(path, method = 'GET') {
  const response = await fetch(path, {method, cache:'no-store', signal:AbortSignal.timeout(25000)});
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

async function removeProduct(product, button) {
  button.disabled = true;
  try {
    if (account) await request('/api/wishlist/' + encodeURIComponent(product.id), 'DELETE');
    remoteIds.delete(product.id);
    localStorage.setItem(wishKey, JSON.stringify(deviceIds().filter(id => id !== product.id)));
    render();
    (grid.querySelector('.heart') || document.querySelector('#empty a')).focus();
  } catch {
    statusLine.textContent = 'Could not remove this style. Please try again.';
    button.disabled = false;
  }
}

function render() {
  const saved = new Set([...deviceIds(), ...remoteIds]);
  const items = catalogue.filter(product => saved.has(product.id));
  grid.replaceChildren();
  for (const product of items) {
    const card = document.createElement('article');
    const link = document.createElement('a');
    link.href = '/?product=' + encodeURIComponent(product.id);
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    if (product.image) image.src = product.image;
    const name = document.createElement('h2');
    name.textContent = product.name;
    link.append(image, name, makePriceElement(product));
    const button = document.createElement('button');
    button.className = 'heart';
    button.textContent = '♥';
    button.setAttribute('aria-label', 'Remove ' + product.name + ' from wishlist');
    button.onclick = () => removeProduct(product, button);
    card.append(link, button);
    grid.append(card);
  }
  statusLine.textContent = items.length ? items.length + (items.length === 1 ? ' saved style' : ' saved styles') : 'Your wishlist is empty.';
  document.getElementById('empty').hidden = items.length > 0;
}

async function loadWishlist() {
  retry.hidden = true;
  try {
    document.body.classList.toggle('dark', JSON.parse(localStorage.getItem('aerlon_theme_v1') || 'null') === 'dark');
    const [data, session] = await Promise.all([request('/api/products'), request('/api/auth/me')]);
    account = Boolean(session.authenticated);
    const wishlist = account ? (await request('/api/wishlist')).wishlist : [];
    remoteIds = new Set(wishlist.map(product => String(product.id)));
    catalogue = catalogueProducts(data.products);
    render();
  } catch {
    statusLine.textContent = 'Your wishlist could not be loaded.';
    retry.hidden = false;
  }
}
retry.onclick = loadWishlist;
window.addEventListener('storage', event => { if (event.key === wishKey) loadWishlist(); });
window.addEventListener('pageshow', loadWishlist);
