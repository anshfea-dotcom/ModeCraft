const wishKey = 'aerlon_wishlist_v1';
const byId = id => document.getElementById(id);
const grid = byId('grid');
const statusLine = byId('status');
let catalogue = [];
let account = false;
let remoteIds = new Set();
let removing = false;

function deviceIds() {
  const raw = localStorage.getItem(wishKey) ?? localStorage.getItem('modecraft_wishlist_v1');
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch { return []; }
}

async function request(path, method = 'GET') {
  const response = await fetch(path, {method, cache:'no-store', signal:AbortSignal.timeout(25000)});
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

async function removeIds(ids) {
  if (removing) return;
  removing = true;
  grid.inert = true;
  byId('clear').disabled = true;
  try {
    for (const id of ids) {
      if (account) await request('/api/wishlist/' + encodeURIComponent(id), 'DELETE');
      localStorage.setItem(wishKey, JSON.stringify(deviceIds().filter(saved => saved !== id)));
      remoteIds.delete(id);
    }
    statusLine.textContent = '';
  } catch {
    statusLine.textContent = 'Some styles could not be removed. Please try again.';
  } finally {
    removing = false;
    grid.inert = false;
    byId('clear').disabled = false;
    render();
    (grid.querySelector('.remove') || document.querySelector('#empty a')).focus();
  }
}

function variantOptions(product) {
  const inventory = product.inventoryVariants || [];
  const configured = product.colors?.length ? product.colors : product.colours;
  const colors = configured?.length ? configured.map(c => typeof c === 'string' ? c : c.name || c.color || c.colour)
    : inventory.length ? [...new Set(inventory.map(v => v.color))] : ['Black','White','Grey','Charcoal','Navy Blue'];
  const options = [];
  for (const color of colors.filter(Boolean)) {
    const linked = product.colorVariants?.[color];
    const source = linked ? catalogue.find(p => p.id === String(linked)) : product;
    if (!source) continue;
    const stock = source.inventoryVariants || [];
    const sizeMap = source.sizesByColor || {};
    const key = Object.keys(sizeMap).find(k => k.toLowerCase() === color.toLowerCase());
    const sizes = stock.length ? stock.filter(v => String(v.color).toLowerCase() === color.toLowerCase() && Number(v.quantity) > 0).map(v => v.size)
      : sizeMap[key] || ['XS','S','M','L','XL','XXL','XXXL','Free Size','One Size'];
    for (const size of new Set(sizes)) options.push({color,size:String(size),source});
  }
  return options;
}

function createCard(product) {
  const card = byId('item').content.firstElementChild.cloneNode(true);
  const url = '/?product=' + encodeURIComponent(product.id);
  const photo = card.querySelector('.photo');
  const image = photo.querySelector('img');
  photo.href = url;
  photo.setAttribute('aria-label', 'View ' + product.name);
  const title = card.querySelector('h2 a');
  title.href = url;
  title.textContent = product.name;
  const select = card.querySelector('select');
  select.setAttribute('aria-label', 'Colour and size for ' + product.name);
  const options = variantOptions(product);
  const multipleColors = new Set(options.map(v => v.color)).size > 1;
  options.forEach(({color,size}, index) => select.add(new Option(multipleColors ? color + ' · ' + size : size, String(index))));
  const update = () => {
    const source = options[select.value]?.source || product;
    const src = source.image || product.image;
    if (src) image.src = src;
    card.querySelector('.pricing').replaceChildren(makePriceElement(source));
  };
  select.onchange = update;
  update();
  const buy = card.querySelector('.buy');
  if (!options.length) {
    select.closest('label').hidden = true;
    buy.textContent = 'Sold out';
    buy.disabled = true;
  }
  buy.onclick = () => {
    const {color,size} = options[select.value];
    try {
      sessionStorage.setItem('aerlon_wishlist_selection', JSON.stringify({id:product.id,color,size}));
      location.assign(url + '&panel=wishlist-bag');
    } catch { location.assign(url); }
  };
  card.querySelector('.remove').onclick = () => removeIds([product.id]);
  return card;
}

function render() {
  const ids = [...new Set([...deviceIds(), ...remoteIds])];
  const items = ids.map(id => catalogue.find(p => p.id === id)).filter(Boolean);
  grid.replaceChildren(...items.map(createCard));
  const count = items.length;
  const noun = count === 1 ? 'Item' : 'Items';
  byId('count').textContent = count + ' Saved ' + noun;
  byId('badge').textContent = count;
  byId('badge').hidden = !count;
  byId('summaryCount').textContent = count + ' ' + noun + ' in Wishlist';
  document.querySelector('.summary').hidden = !count;
  byId('empty').hidden = !!count;
  byId('clear').hidden = !count;
  byId('clear').onclick = () => {
    if (window.confirm('Remove all saved items from your wishlist?')) removeIds(ids);
  };
}

async function loadWishlist() {
  byId('retry').hidden = true;
  try {
    const [data, session] = await Promise.all([request('/api/products'), request('/api/auth/me')]);
    account = Boolean(session.authenticated);
    const wishlist = account ? (await request('/api/wishlist')).wishlist : [];
    remoteIds = new Set(wishlist.map(p => String(p.id)));
    catalogue = catalogueProducts(data.products);
    statusLine.textContent = '';
    render();
  } catch {
    statusLine.textContent = 'Your wishlist could not be loaded.';
    byId('retry').hidden = false;
  }
}
byId('retry').onclick = loadWishlist;
window.addEventListener('storage', event => { if (event.key === wishKey) loadWishlist(); });
window.addEventListener('pageshow', loadWishlist);
