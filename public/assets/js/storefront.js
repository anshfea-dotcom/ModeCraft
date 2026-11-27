const $=s=>document.querySelector(s);
let products=[],cart=[];
let checkoutScriptPromise;
function loadOnlineCheckout() {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (checkoutScriptPromise) return checkoutScriptPromise;
  checkoutScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(fail, 15000);
    function fail() {
      clearTimeout(timeout);
      script.onload = script.onerror = null;
      script.remove();
      checkoutScriptPromise = null;
      reject(new Error('Online payment could not load. Please try again.'));
    }
    script.onload = () => {
      if (!window.Razorpay) return fail();
      clearTimeout(timeout);
      resolve(window.Razorpay);
    };
    script.onerror = fail;
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    document.head.append(script);
  });
  return checkoutScriptPromise;
}
let appliedCoupon=null;
// Show only an offer explicitly configured on the product by the admin panel.
function productOfferLabel(p){
  if(!p||p.offerEnabled===false||p.discountEnabled===false)return "";
  const raw=p.offerText??p.offerLabel??p.discountLabel??p.offer??p.discountText;
  if(raw&&typeof raw==="object"){
    if(raw.enabled===false||raw.active===false)return "";
    const label=raw.label??raw.text??raw.title;
    if(label!=null&&String(label).trim())return String(label).trim();
    const value=Number(raw.value??raw.amount??raw.percent??raw.discount);
    const type=String(raw.type??raw.discountType??"").toLowerCase();
    if(Number.isFinite(value)&&value>0){if(type.includes("percent")||type==="percentage"||raw.percent!=null)return `${value}% OFF`;if(type.includes("flat")||type.includes("fixed")||type.includes("amount"))return `₹${value} OFF`;}
    return "";
  }
  if(typeof raw==="string"&&raw.trim())return raw.trim();
  const percent=Number(p.offerPercent??p.discountPercent??p.discountPercentage);
  if(Number.isFinite(percent)&&percent>0)return `${percent}% OFF`;
  const type=String(p.discountType??p.offerType??"").toLowerCase();
  const value=Number(p.discountValue??p.offerAmount??(typeof p.discount==="number"?p.discount:NaN));
  if(Number.isFinite(value)&&value>0&&(type.includes("percent")||type==="percentage"))return `${value}% OFF`;
  if(Number.isFinite(value)&&value>0&&(type.includes("flat")||type.includes("fixed")||type.includes("amount")))return `₹${value} OFF`;
  return "";
}
function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),4000)}
async function api(url,body,timeoutMs=25000,methodOverride=null){const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),timeoutMs);try{const hasBody=body!==undefined&&body!==null;const r=await fetch(url,{method:methodOverride||(hasBody?"POST":"GET"),credentials:"same-origin",cache:"no-store",headers:hasBody?{"Content-Type":"application/json"}:{},body:hasBody?JSON.stringify(body):undefined,signal:controller.signal});observeCustomerSession(r);const data=await r.json().catch(()=>({error:"Unexpected server response"}));if(!r.ok)throw new Error(data.error||"Request failed");return data}catch(error){if(error&&error.name==="AbortError")throw new Error("The store server is taking too long to respond. Please retry in a moment.");throw error}finally{clearTimeout(timeout)}}
// Panel links are one-time actions. Consume them before the catalogue request starts.
function takeStorefrontPanel() {
  const url = new URL(location.href);
  const panel = url.searchParams.get('panel');
  if (!['bag', 'menu', 'search', 'wishlist-bag'].includes(panel)) return null;
  const product = panel === 'wishlist-bag' ? url.searchParams.get('product') : null;
  url.searchParams.delete('panel');
  if (panel === 'wishlist-bag') url.searchParams.delete('product');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  const navigation = performance.getEntriesByType?.('navigation')[0]?.type;
  if (navigation === 'reload' || navigation === 'back_forward') return null;
  return {panel, product};
}
let pendingStorefrontPanel = takeStorefrontPanel();
function resetTransientPanels() {
  pendingStorefrontPanel = null;
  showBag(false);
  closeModal('settingsModal');
  byId('menuBtn').setAttribute('aria-expanded', 'false');
}
async function init(){
  const root=$("#products");
  root.innerHTML='<p class="muted" role="status">Loading collection… If the store server is waking up, this may take a moment.</p>';
  try {
    // Load products independently so a payment-config error cannot hide the collection.
    let p;
    try {
      p = await api("/api/products");
    } catch (apiError) {
      // A local file preview has no same-origin API. On the live site, surface
      // API failures instead of silently presenting an empty catalogue as if
      // there were genuinely no products in the store.
      console.warn("AERLON products API unavailable.", apiError);
      if (location.protocol === "file:") p = { products: [] };
      else throw apiError;
    }
    if (!p || !Array.isArray(p.products)) {
      throw new Error("Products API returned an unexpected response.");
    }
    // Normalize database/admin product records before rendering. Older records may
    // use title/productName, string prices, or optional image/category fields.
    products = catalogueProducts(p.products);
    // Only real active products from the store API are rendered. Never fabricate catalog items.
    // Reconcile the persisted bag only after the catalogue has loaded. This prevents
    // the badge showing old items while the bag itself appears empty during page startup.
    const validProductIds = new Set(products.map(product => String(product.id)));
    cart = cart.filter(item => validProductIds.has(String(item.id)));
    safeWrite('aerlon_cart_v1', cart);

    dismissIntro();
    renderProducts();
    renderCart();
    renderRecent();
    renderWish();
    const query = new URLSearchParams(location.search).get('q');
    if (query !== null) {
      byId('search').value = query;
      byId('search').dispatchEvent(new Event('input', {bubbles:true}));
    }
    const action = pendingStorefrontPanel;
    pendingStorefrontPanel = null;
    const panel = action?.panel;
    const deepLinkedProduct = action?.product || new URLSearchParams(location.search).get('product');
    if (deepLinkedProduct && products.some(item => String(item.id) === String(deepLinkedProduct))) openProduct(deepLinkedProduct);
    if (panel === 'bag') showBag(true);
    if (panel === 'menu') byId('menuBtn').click();
    if (panel === 'search') { byId('shop').scrollIntoView(); byId('search').focus(); }
    if (panel === 'wishlist-bag' && selectedProduct?.id === deepLinkedProduct) {
      const selection = JSON.parse(sessionStorage.getItem('aerlon_wishlist_selection') || 'null');
      sessionStorage.removeItem('aerlon_wishlist_selection');
      if (selection?.id === deepLinkedProduct) {
        const color = Array.from(byId('detailColourSwatches').children).find(button => button.title === selection.color && !button.disabled);
        color?.click();
        const size = Array.from(byId('detailSizeOptions').querySelectorAll('.size-option')).find(button => button.textContent === selection.size);
        if (color && size) {
          size.click();
          if (!byId('detailAdd').disabled) byId('detailAdd').click();
        }
      }
    }
  } catch (e) {
    console.error("AERLON products API/render error:", e);
    const message = String(e?.message || "Unknown error");

    // Build the error state from DOM nodes instead of querying an element
    // immediately after replacing innerHTML. This avoids a null textContent
    // error if the markup changes or a browser extension modifies the page.
    if (root) {
      const state = document.createElement("div");
      state.className = "empty";
      const title = document.createElement("strong");
      title.textContent = "We couldn’t load the collection.";
      const detail = document.createElement("p");
      detail.id = "productsErrorDetail";
      detail.textContent = message;
      const retry = document.createElement("button");
      retry.className = "add";
      retry.id = "retryProducts";
      retry.type = "button";
      retry.textContent = "TRY AGAIN";
      retry.addEventListener("click", init);
      state.append(title, detail, retry);
      root.replaceChildren(state);
    }
    return;
  }

}
function renderProducts(){
  const root=$("#products");
  const tools=document.querySelector("#shop .tools");
  if(activeCollection==="sneakers"){
    if(tools)tools.style.display="none";
    root.innerHTML='<section class="sneaker-coming-simple" aria-label="Sneakers coming soon"><span class="sneaker-coming-mark">A.</span><p class="sneaker-coming-label">THE NEXT DROP</p><h3> sneakers <span>coming soon.</span></h3><p>We’re working on something fresh. Stay tuned.</p></section>';
    return;
  }
  if(tools)tools.style.display="";
  const q=($("#search")?.value||"").toLowerCase();
  const categorySelect=$("#category");
  const previousCategory=categorySelect?.value||"All categories";
  if(categorySelect){const categories=[...new Set(products.filter(p=>!isPreviewOnlyProduct(p)&&!p.isColorVariantChild).map(p=>String(p.category||"New Arrivals").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));categorySelect.replaceChildren(new Option('All Categories','All categories'));categories.forEach(category=>categorySelect.add(new Option(category,category)));if([...categorySelect.options].some(o=>o.value.toLowerCase()===previousCategory.toLowerCase()))categorySelect.value=[...categorySelect.options].find(o=>o.value.toLowerCase()===previousCategory.toLowerCase()).value;else categorySelect.value='All categories';}
  const cat=categorySelect?.value||"All categories";
  const sort=$("#sort")?.value||"featured";
  // Never show demo/preview-only products in the customer-facing catalog.
  let list=products.filter(p=>!isPreviewOnlyProduct(p)
    &&!p.isColorVariantChild
    &&collectionMatches(p,activeCollection)
    &&String(p.name||"").toLowerCase().includes(q)
    &&(cat.toLowerCase()==="all categories"||String(p.category||"New Arrivals").trim().toLowerCase()===cat.trim().toLowerCase()));
  if(sort==="low")list.sort((a,b)=>effectivePrice(a)-effectivePrice(b));
  if(sort==="high")list.sort((a,b)=>effectivePrice(b)-effectivePrice(a));
  root.replaceChildren();
  if(!list.length){root.innerHTML='<p class="empty">No products found. Try another search.</p>';return;}
  list.forEach(p=>{
    const card=document.createElement("article");
    card.className="card product-card-clickable";
    card.tabIndex=0;
    card.setAttribute("role","button");
    card.setAttribute("aria-label",`Open ${p.name} product details`);
    card.addEventListener("click",event=>{if(!event.target.closest("button,a"))openProduct(p.id)});
    card.addEventListener("keydown",event=>{
      if(event.target===card&&(event.key==="Enter"||event.key===" ")){event.preventDefault();openProduct(p.id);}
    });
    const pic=document.createElement("div");pic.className="pic";
    const img=document.createElement("img");img.src=(productImages(p)[0]||p.image||"");img.alt=p.name||"AERLON product";img.loading="lazy";img.onerror=()=>{img.style.display="none";pic.classList.add("image-unavailable");};
    pic.append(img,productHeart(p));
    const info=document.createElement("div");info.className="pinfo";
    const h=document.createElement("h3");h.textContent=p.name||"Product";
    const price=makePriceElement(p,"price product-card-price");
    info.append(h,price);
    const offerLabel=productOfferLabel(p);
    if(offerLabel){const offer=document.createElement("span");offer.className="product-offer-badge";offer.textContent=offerLabel;offer.setAttribute("aria-label","Offer: "+offerLabel);pic.append(offer);}
    card.append(pic,info);root.append(card);
  });
}
function isPreviewOnlyProduct(p){
  if(!p||typeof p!=="object")return true;
  const status=String(p.status||p.visibility||p.productStatus||"").trim().toLowerCase();
  return p.demo===true||p.previewOnly===true||p.isPreview===true||p.preview_only===true
    ||status==="preview"||status==="preview only"||status==="draft preview";
}
let activeCollection="all";
const collectionMeta={jackets:{title:"Jackets Collection",eyebrow:"LAYER UP IN STYLE",copy:"Versatile outerwear and everyday layers designed to finish your fit with confidence.",mark:"J."},men:{title:"Men’s Collection",eyebrow:"THE EVERYDAY EDIT",copy:"Modern menswear made for everyday confidence. Discover elevated essentials and easy-to-wear favourites.",mark:"M."},women:{title:"Women’s Collection",eyebrow:"YOUR STYLE, YOUR RULES",copy:"Versatile pieces, confident silhouettes and everyday styles made to feel like you.",mark:"W."},sneakers:{title:"Sneaker Collection",eyebrow:"STEP INTO SOMETHING NEW",copy:"Finish your fit with fresh everyday sneakers and street-ready footwear.",mark:"S."}};
function collectionMatches(p,key){
  if(key==="all")return true;
  const rawAudience=String(p.audience||p.gender||p.department||"").trim().toLowerCase().replace(/[’']/g,"").replace(/[._-]+/g," ").replace(/\s+/g," ");
  const audience=rawAudience.replace(/\s/g,"");
  const type=String(p.productType||p.category||p.type||"").toLowerCase();
  const text=[p.name,type,p.tags,p.collection].flatMap(v=>Array.isArray(v)?v:[v||""]).join(" ").toLowerCase();
  const menAudience=new Set(["men","mens","man","male","boy","boys","menswear"]);
  const womenAudience=new Set(["women","womens","woman","female","girl","girls","womenswear","ladies","lady"]);
  const unisexAudience=new Set(["unisex","all","allgender","all genders","menandwomen","womenandmen"]);
  if(key==="men")return menAudience.has(audience)||unisexAudience.has(audience)||(!menAudience.has(audience)&&!womenAudience.has(audience)&&/\b(men|mens|man|male|boy|boys|menswear)\b/.test(text));
  if(key==="women")return womenAudience.has(audience)||unisexAudience.has(audience)||(!menAudience.has(audience)&&!womenAudience.has(audience)&&/\b(women|womens|woman|female|girl|girls|womenswear|ladies|lady)\b/.test(text));
  if(key==="jackets")return /\b(jacket|jackets|outerwear|windbreaker|bomber)\b/.test(type+" "+text);
  return /sneaker|trainer|footwear|shoe|shoes|kick/.test(type+" "+text);
}
function initialiseLookbook() {
  const track = document.querySelector('.lookbook-track');
  const play = document.querySelector('[data-look="play"]');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let playing = !motion.matches;
  let timer;
  function move(step) {
    const width = track.clientWidth;
    if (!width) return;
    const count = track.children.length;
    const next = (Math.round(track.scrollLeft / width) + step + count) % count;
    track.scrollTo({left: next * width, behavior: motion.matches ? 'instant' : 'smooth'});
  }
  function sync() {
    clearInterval(timer);
    play.textContent = playing ? 'Ⅱ' : '▷';
    play.setAttribute('aria-label', playing ? 'Pause slideshow' : 'Play slideshow');
    if (playing && !document.hidden) timer = setInterval(() => move(1), 5500);
  }
  function pause() { playing = false; sync(); }
  document.querySelectorAll('[data-look]').forEach(button => button.addEventListener('click', () => {
    if (button === play) { playing = !playing; sync(); }
    else { pause(); move(button.dataset.look === 'next' ? 1 : -1); }
  }));
  track.addEventListener('pointerdown', pause);
  track.addEventListener('focus', pause);
  motion.addEventListener('change', () => { if (motion.matches) pause(); });
  document.addEventListener('visibilitychange', sync);
  sync();
}
initialiseLookbook();
function setCollectionFromHash(){const key=location.hash.toLowerCase().replace(/^#/ ,"");activeCollection=["men","women","sneakers","jackets"].includes(key)?key:"all";document.body.classList.toggle("collection-page",activeCollection!=="all");document.querySelectorAll("[data-collection]").forEach(a=>{a.classList.toggle("active",a.dataset.collection===activeCollection);if(a.tagName==="BUTTON")a.setAttribute("aria-pressed",String(a.dataset.collection===activeCollection));});const heading=document.querySelector("#shop .heading h2"),sub=document.querySelector("#shop .heading .muted");if(activeCollection!=="all"){heading.textContent=collectionMeta[activeCollection].title;sub.textContent="CURATED FOR YOU."}else{heading.textContent="Shop the collection";sub.textContent="FIND YOUR FIT."}if(typeof renderProducts==="function")renderProducts();}
document.querySelectorAll(".collection-box[data-collection]").forEach(button=>button.addEventListener("click",()=>{const key=button.dataset.collection;location.hash=activeCollection===key?"shop":key;}));
window.addEventListener("hashchange",setCollectionFromHash);
function clearAppliedCoupon(message="Cart changed. Please re-apply your coupon."){
  if(!appliedCoupon)return;
  appliedCoupon=null;
  const input=$("#couponInput"),msg=$("#couponMessage"),totals=$("#couponTotals");
  if(input)input.value="";
  if(msg)msg.textContent=message;
  if(totals)totals.style.display="none";
  updateCheckoutSummary();
}
function updateCheckoutSummary(){
  const subtotal=total();
  const discount=appliedCoupon?Number(appliedCoupon.discount)||0:0;
  const finalTotal=Math.max(0,subtotal-discount);
  const summary=$("#checkoutSummary");
  if(summary)summary.textContent=appliedCoupon
    ? "Subtotal: "+money(subtotal)+". Coupon "+appliedCoupon.code+" saves "+money(discount)+". Estimated total: "+money(finalTotal)+". Shipping fees, if any, must be confirmed."
    : "Order subtotal: "+money(subtotal)+". Shipping fees, if any, must be confirmed.";
  const checkoutSubtotal=$("#checkoutSubtotal"),checkoutDiscount=$("#checkoutDiscount"),checkoutDiscountRow=$("#checkoutDiscountRow"),checkoutGrand=$("#checkoutGrandTotal");
  if(checkoutSubtotal)checkoutSubtotal.textContent=money(subtotal);
  if(checkoutDiscount)checkoutDiscount.textContent="−"+money(discount);
  if(checkoutDiscountRow)checkoutDiscountRow.hidden=!discount;
  if(checkoutGrand)checkoutGrand.textContent=money(finalTotal);
  $("#removeCoupon").hidden = !appliedCoupon;
  if (!$("#placeOrder").disabled) $("#placeOrder").textContent = "Place order · " + money(finalTotal);
  const totals=$("#couponTotals");
  if(totals){
    totals.style.display=appliedCoupon?"block":"none";
    $("#couponSubtotal").textContent=money(subtotal);
    $("#couponDiscount").textContent="−"+money(discount);
    $("#couponTotal").textContent=money(finalTotal);
  }
}
async function applyCoupon(){
  const input=$("#couponInput"),msg=$("#couponMessage"),btn=$("#applyCouponBtn");
  const code=(input?.value||"").trim().toUpperCase();
  if(!cart.length){if(msg)msg.textContent="Add a product to your bag before applying a coupon.";return}
  if(!code){if(msg)msg.textContent="Enter a coupon code first.";return}
  if(btn){btn.disabled=true;btn.textContent="CHECKING…"}
  try{
    const result=await api("/api/coupons/validate", { couponCode: code, items: payload().items });
    if(!result||result.ok===false||!result.code)throw new Error(result?.error||"This coupon could not be applied.");
    const discount=Number(result.discount);
    if(!Number.isFinite(discount)||discount<0)throw new Error("The server returned an invalid discount.");
    appliedCoupon={code:String(result.code).toUpperCase(),discount:Math.min(total(),discount)};
    if(input)input.value=appliedCoupon.code;
    if(msg)msg.textContent=result.message||"Coupon applied successfully.";
    updateCheckoutSummary();
    toast("Coupon "+appliedCoupon.code+" applied.");
  }catch(err){
    appliedCoupon=null;
    if(msg)msg.textContent=err.message||"Could not validate this coupon.";
    const totals=$("#couponTotals");if(totals)totals.style.display="none";
    updateCheckoutSummary();
  }finally{if(btn){btn.disabled=false;btn.textContent="APPLY"}}
}
$("#applyCouponBtn").addEventListener("click",applyCoupon);
$("#couponInput").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();applyCoupon()}});
function cartKey(item){return [item.id,item.color||'',item.size||''].join('::')}
function add(id,color='',size=''){const key=cartKey({id,color,size});const i=cart.find(x=>cartKey(x)===key);if(i&&i.quantity>=10){toast('Maximum 10 units per product variant.');return}clearAppliedCoupon();if(i)i.quantity++;else cart.push({id,color,size,quantity:1});renderCart();toast("Added to your bag")}
function change(key,d){const i=cart.find(x=>cartKey(x)===key);if(!i)return;if(d>0&&i.quantity>=10){toast('Maximum 10 units per product variant.');return}clearAppliedCoupon();i.quantity+=d;if(i.quantity<1)cart=cart.filter(x=>cartKey(x)!==key);renderCart()}
function renderCart(){const itemCount=cart.reduce((n,i)=>n+i.quantity,0);$("#count").textContent=itemCount;$("#bagBtn").setAttribute("aria-label",`Open shopping bag, ${itemCount} item${itemCount===1?"":"s"}`);const root=$("#cartItems");root.replaceChildren();if(!cart.length){const p=document.createElement("p");p.className="muted";p.textContent="Your bag is empty. Explore the collection.";root.append(p)}cart.forEach(i=>{const p=products.find(x=>x.id===i.id);if(!p)return;const key=cartKey(i),row=document.createElement("div");row.className="cartrow";const img=document.createElement("img");img.src=p.image;img.alt=p.name;const details=document.createElement("div"),title=document.createElement("strong");title.textContent=p.name;const price=document.createElement("p");price.textContent=money(effectivePrice(p)*i.quantity);const variant=document.createElement("p");variant.className="muted";variant.textContent=[i.color,i.size].filter(Boolean).join(" · ");const qty=document.createElement("div");qty.className="qty";const minus=document.createElement("button");minus.textContent="−";minus.onclick=()=>change(key,-1);const num=document.createElement("span");num.textContent=i.quantity;const plus=document.createElement("button");plus.textContent="+";plus.onclick=()=>change(key,1);const remove=document.createElement("button");remove.className="remove";remove.textContent="Remove";remove.onclick=()=>{clearAppliedCoupon();cart=cart.filter(x=>cartKey(x)!==key);renderCart()};qty.append(minus,num,plus);details.append(title,variant,price,qty,remove);row.append(img,details);root.append(row)});$("#subtotal").textContent=money(total())}
function total(){return cart.reduce((s,i)=>s+effectivePrice(products.find(p=>p.id===i.id)||{})*i.quantity,0)}
function showBag(show){$("#drawer").classList.toggle("show",show);$("#shade").classList.toggle("show",show)}
function showCheckout(show){if(show){refreshCheckoutMethods();renderCheckoutItems();updateCheckoutSummary()}$("#checkout").classList.toggle("show",show)}
function renderCheckoutItems(){const root=$("#checkoutItems");if(!root)return;root.replaceChildren();let count=0;for(const item of cart){const p=products.find(x=>String(x.id)===String(item.id));if(!p)continue;count+=Number(item.quantity)||0;const row=document.createElement('div');row.className='checkout-line-item';const img=document.createElement('img');img.src=productImages(p)[0]||p.image||'';img.alt=p.name||'Product';img.loading='lazy';img.onerror=()=>{img.style.visibility='hidden'};const copy=document.createElement('div');copy.className='checkout-line-copy';const title=document.createElement('strong');title.textContent=p.name||'Product';const variant=document.createElement('small');variant.textContent=[item.color,item.size,'Qty '+(Number(item.quantity)||1)].filter(Boolean).join(' · ');copy.append(title,variant);const price=document.createElement('strong');price.className='checkout-line-price';price.textContent=money(effectivePrice(p)*(Number(item.quantity)||1));row.append(img,copy,price);root.append(row)}if(!count){const empty=document.createElement('p');empty.className='muted';empty.textContent='Your bag is empty. Return to the collection to add products.';root.append(empty)}const countEl=$("#checkoutItemCount");if(countEl)countEl.textContent=count+' item'+(count===1?'':'s');const sub=$("#checkoutSubtotal"),discount=$("#checkoutDiscount"),discountRow=$("#checkoutDiscountRow"),grand=$("#checkoutGrandTotal");if(sub)sub.textContent=money(total());const saving=appliedCoupon?Number(appliedCoupon.discount)||0:0;if(discount)discount.textContent='−'+money(saving);if(discountRow)discountRow.hidden=!saving;if(grand)grand.textContent=money(Math.max(0,total()-saving))}
function payload(){return{customer:{name:$("#name").value.trim(),email:$("#email").value.trim(),phone:$("#phone").value.trim(),address:$("#address").value.trim(),house:$("#house").value.trim(),state:$("#state").value.trim(),landmark:$("#landmark").value.trim(),addressType:$("#addressType").value,city:$("#city").value.trim(),postalCode:$("#pin").value.trim()},items:cart.map(i=>({id:i.id,quantity:i.quantity,color:i.color||'',size:i.size||''})),couponCode:appliedCoupon?.code||""}}
$("#bagBtn").onclick=()=>showBag(true);$("#closeBag").onclick=()=>showBag(false);$("#shade").onclick=()=>showBag(false);$("#checkoutBtn").onclick=()=>{if(!cart.length)return toast("Your bag is empty");updateCheckoutSummary();showBag(false);showCheckout(true)};$("#closeCheckout").onclick=()=>showCheckout(false);
$("#search").oninput=renderProducts;$("#category").onchange=renderProducts;$("#sort").onchange=renderProducts;$("#year").textContent=new Date().getFullYear();
// Extra storefront features: wishlist/recently viewed/theme are stored on this device.
// Upgrade browser data saved before the storefront rename.
try {
  for (const suffix of ['cart', 'wishlist', 'recent', 'theme', 'recent_orders', 'session']) {
    const oldKey = `modecraft_${suffix}_v1`;
    const newKey = `aerlon_${suffix}_v1`;
    const saved = localStorage.getItem(oldKey);
    if (saved === null) continue;
    if (localStorage.getItem(newKey) === null) localStorage.setItem(newKey, saved);
    localStorage.removeItem(oldKey);
  }
} catch { /* Storage may be disabled in private browsing. */ }
const STORE={wish:'aerlon_wishlist_v1',recent:'aerlon_recent_v1',theme:'aerlon_theme_v1',orders:'aerlon_recent_orders_v1'};
let selectedProduct=null,selectedColorProduct=null,authMode='login';
const safeRead=(key,fallback=[])=>{try{const raw=localStorage.getItem(key);if(raw===null)return fallback;const value=JSON.parse(raw);if(Array.isArray(fallback))return Array.isArray(value)?value:fallback;if(fallback===null)return value&&typeof value==='object'?value:fallback;return typeof value===typeof fallback?value:fallback}catch{return fallback}};
const safeWrite=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));return true}catch(error){console.warn('AERLON could not save local preference:',error.message);return false}};
const safeRemove=key=>{try{localStorage.removeItem(key)}catch(error){console.warn('AERLON could not clear local preference:',error.message)}};
function byId(id){return document.getElementById(id)}
function openModal(id){const modal=byId(id);if(id==='productModal'){const nav=document.querySelector('.nav');const navBottom=nav?Math.max(0,Math.ceil(nav.getBoundingClientRect().bottom)):0;modal.style.setProperty('--product-modal-top',navBottom+'px');modal.classList.add('product-modal-below-header')}modal.classList.add('show')}
function closeModal(id){byId(id).classList.remove('show');if(id==='productModal')byId(id).classList.remove('product-modal-below-header')}
function showOrderSuccess(orderId,message,paymentLabel){
  byId('successOrderId').textContent=orderId||'Reference unavailable';
  byId('orderSuccessMessage').textContent=message||'Your order has been accepted by the store.';
  byId('successPaymentNote').textContent=(paymentLabel==='ONLINE'?'Payment verification was completed by the store.':'Your order has been placed successfully. Keep this reference handy to check the latest status.');
  openModal('orderSuccessModal');
}
function showLoginSuccess(isSignup){
  byId('loginSuccessTitle').textContent=isSignup?'Your account is ready.':'You’re signed in.';
  byId('loginSuccessMessage').textContent=isSignup?'Welcome to AERLON. Your account was created successfully.':'Welcome back. You can now continue exploring your saved styles and orders.';
  openModal('loginSuccessModal');
}
function renderTrackResult(result,orderId){
  const root=byId('trackResult');root.replaceChildren();
  const order=result?.order||result||{};
  const rawStatus=order.orderStatus||order.status||result?.orderStatus||result?.status||'received';
  const normalized=String(rawStatus).toLowerCase().replaceAll('_',' ');
  const statusLabel=String(rawStatus).replaceAll('_',' ');
  const steps=['Order placed','Confirmed','Processing','Shipped','Delivered'];
  const stageMap={received:0,confirmed:1,processing:2,shipped:3,delivered:4};
  const active=Object.prototype.hasOwnProperty.call(stageMap,String(rawStatus).toLowerCase())?stageMap[String(rawStatus).toLowerCase()]:0;const paymentPending=String(order.paymentStatus||'').toLowerCase()==='pending'&&String(order.paymentMethod||'').toLowerCase().includes('online');
  const card=document.createElement('section');card.className='track-result-card';
  const head=document.createElement('div');head.className='track-result-head';
  const eyebrow=document.createElement('div');eyebrow.className='track-result-eyebrow';eyebrow.textContent='TRACKING RESULT';
  const row=document.createElement('div');row.className='track-result-title';
  const title=document.createElement('h3');title.textContent=orderId||order.orderId||order.id||'Your order';
  const pill=document.createElement('span');pill.className='track-status-pill';pill.textContent=statusLabel;
  if(normalized==='cancelled'){pill.style.background='#fff0ed';pill.style.color='#873c2e'}
  row.append(title,pill);head.append(eyebrow,row);
  const body=document.createElement('div');body.className='track-result-body';
  const meta=document.createElement('div');meta.className='track-order-meta';
  const payment=document.createElement('span');payment.textContent='Payment: '+String(order.paymentStatus||'pending').replaceAll('_',' ');
  const method=document.createElement('span');method.textContent='Method: '+String(order.paymentMethod||'—');
  const placed=document.createElement('span');placed.textContent='Placed: '+(order.createdAt?new Date(order.createdAt).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}):'—');
  meta.append(payment,method,placed);body.append(meta);
  const timeline=document.createElement('div');timeline.className='track-timeline';
  steps.forEach((label,i)=>{const step=document.createElement('div');step.className='track-step'+(i<=active&&normalized!=='cancelled'?' done':'');const dot=document.createElement('div');dot.className='track-step-dot';dot.textContent=i<=active&&normalized!=='cancelled'?'✓':String(i+1);const text=document.createElement('div');text.textContent=label;step.append(dot,text);timeline.append(step)});
  body.append(timeline);
  if(normalized==='cancelled'){const cancel=document.createElement('div');cancel.className='track-message';cancel.textContent='This order has been cancelled. Contact customer support if you need help.';body.append(cancel)}else if(paymentPending){const pending=document.createElement('div');pending.className='track-message';pending.textContent='Online payment is still pending verification. Your order will move forward after the payment is confirmed. Do not make another payment unless the store confirms the first attempt failed.';body.append(pending)}
  const items=Array.isArray(order.items)?order.items:[];
  if(items.length){const section=document.createElement('div');section.className='track-items';const h=document.createElement('h4');h.textContent='Items in this order';section.append(h);items.forEach(item=>{const line=document.createElement('div');line.className='track-item-line';const name=document.createElement('span');name.textContent=(item.name||item.productName||'Product')+' × '+(Number(item.quantity)||1);const variant=document.createElement('small');variant.textContent=[item.color,item.size].filter(Boolean).join(' · ');line.append(name,variant);section.append(line)});body.append(section)}
  const history=Array.isArray(order.statusHistory)?order.statusHistory:[];
  if(history.length){const section=document.createElement('div');section.className='track-history';const h=document.createElement('h4');h.textContent='Latest status updates';section.append(h);history.slice(-5).reverse().forEach(entry=>{const line=document.createElement('div');line.className='track-history-row';const label=document.createElement('strong');label.textContent=String(entry.status||'Updated').replaceAll('_',' ');const when=document.createElement('small');when.textContent=entry.at?new Date(entry.at).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'';line.append(label,when);if(entry.reason){const reason=document.createElement('p');reason.textContent=entry.reason;line.append(reason)}section.append(line)});body.append(section)}
  const note=document.createElement('div');note.className='track-message';note.textContent='Status shown here is read from the latest order record. Refresh to check for new updates.';body.append(note);
  const refresh=document.createElement('button');refresh.type='button';refresh.className='btn track-refresh';refresh.textContent='↻ Refresh status';refresh.addEventListener('click',async()=>{refresh.disabled=true;refresh.textContent='Checking…';try{const id=encodeURIComponent(byId('trackOrderId').value.trim()),phone=encodeURIComponent(byId('trackPhone').value.trim());const latest=await api('/api/orders/track?orderId='+id+'&phone='+phone);renderTrackResult(latest,byId('trackOrderId').value.trim())}catch(err){toast('Could not refresh status: '+err.message,true)}finally{const b=root.querySelector('.track-refresh');if(b){b.disabled=false;b.textContent='↻ Refresh status'}}});body.append(refresh);
  card.append(head,body);root.append(card);
}

const aerlonImageCache=new Map();
function aerlonPreloadImages(urls){urls.filter(Boolean).forEach(src=>{if(aerlonImageCache.has(src))return;const img=new Image();img.decoding='async';img.src=src;aerlonImageCache.set(src,img);if(aerlonImageCache.size>80)aerlonImageCache.delete(aerlonImageCache.keys().next().value)})}
function aerlonSetGalleryImage(img,src){if(!src)return;img.decoding='async';img.style.opacity='.35';img.style.visibility='visible';const cached=aerlonImageCache.get(src);if(cached?.complete&&cached.naturalWidth){img.src=src;img.style.opacity='1';return}const loader=cached||new Image();if(!cached){loader.decoding='async';loader.src=src;aerlonImageCache.set(src,loader)}img.src=src;loader.addEventListener('load',()=>{if(img.getAttribute('src')===src){img.style.opacity='1';img.style.visibility='visible'}},{once:true});loader.addEventListener('error',()=>{if(img.getAttribute('src')===src){img.style.visibility='hidden'}},{once:true})}
function productImages(p){let arr=Array.isArray(p.images)?[...p.images]:[];if(p.image&&!arr.includes(p.image))arr.unshift(p.image);return [...new Set(arr.filter(Boolean))]}
function isWished(id){return safeRead(STORE.wish,[]).some(x=>String(x)===String(id))}
async function saveAndOpenWishlist(id, button) {
  button.disabled = true;
  try {
    const saved = safeRead(STORE.wish, []).map(String);
    if (currentCustomer?.id) await api('/api/wishlist/' + encodeURIComponent(id), {});
    if (!saved.includes(String(id)) && !safeWrite(STORE.wish, [...saved, String(id)]) && !currentCustomer?.id) {
      throw new Error('Device storage is unavailable.');
    }
    location.assign('/wishlist.html');
  } catch {
    button.disabled = false;
    toast('Could not save this style. Please try again.', true);
  }
}
function productHeart(product) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'product-heart';
  button.classList.toggle('is-saved', isWished(product.id));
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.1 5.3a5 5 0 0 0-7 0L12 6.4l-1.1-1.1a5 5 0 0 0-7 7L12 20.5l8.1-8.2a5 5 0 0 0 0-7Z"/></svg>';
  button.setAttribute('aria-label', 'Save ' + product.name + ' and open wishlist');
  button.onclick = event => {
    event.stopPropagation();
    saveAndOpenWishlist(product.id, button);
  };
  return button;
}
window.addEventListener('pagehide', resetTransientPanels);
window.addEventListener('popstate', resetTransientPanels);
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    resetTransientPanels();
    renderProducts(); renderRecent(); renderWish(); byId('detailWish').disabled = false;
  }
});
function rememberProduct(id){let a=safeRead(STORE.recent,[]).filter(x=>String(x)!==String(id));a.unshift(id);safeWrite(STORE.recent,a.slice(0,8));renderRecent()}
function renderMiniGrid(rootId,items){const root=byId(rootId);if(!root)return;root.replaceChildren();if(!items.length){root.innerHTML='<p class="muted">Nothing to show yet.</p>';return}items.forEach(p=>{const card=document.createElement('article');card.className='card';const pic=document.createElement('div');pic.className='pic';const img=document.createElement('img');img.src=(productImages(p)[0]||'');img.alt=p.name;img.loading='lazy';pic.append(img);pic.onclick=()=>openProduct(p.id);const info=document.createElement('div');info.className='pinfo';const h=document.createElement('h3');h.textContent=p.name;const price=makePriceElement(p,"price");const row=document.createElement('div');row.style.display='flex';row.style.gap='8px';const view=document.createElement('button');view.className='add';view.textContent='VIEW';view.onclick=()=>openProduct(p.id);pic.append(productHeart(p));row.append(view);info.append(h,price,row);card.append(pic,info);root.append(card)})}
function renderWish(){
const w=safeRead(STORE.wish,[]),items=w.map(id=>products.find(p=>String(p.id)===String(id))).filter(Boolean);
const menuCount=byId('menuWishCount');if(menuCount)menuCount.textContent=String(items.length);
const countNode=byId('wishCount');if(countNode)countNode.textContent=String(items.length);
}
function renderRecent(){const ids=[...new Set(safeRead(STORE.recent,[]).map(String))],items=ids.map(id=>products.find(p=>String(p.id)===String(id))).filter(Boolean);renderMiniGrid('recentProducts',items)}
let activeProductReviews=[];let activeProductReviewSummary={};
function renderProductReviews(productId){
  const root=byId('reviewList');if(!root)return;root.replaceChildren();
  const reviews=activeProductReviews.slice();
  const controls=document.createElement('div');controls.className='review-controls';
  const rating=document.createElement('select');rating.setAttribute('aria-label','Filter reviews by rating');
  [['all','All ratings'],['5','5 stars'],['4','4 stars'],['3','3 stars'],['2','2 stars'],['1','1 star']].forEach(([v,l])=>{const o=document.createElement('option');o.value=v;o.textContent=l;rating.append(o)});
  const sort=document.createElement('select');sort.setAttribute('aria-label','Sort reviews');[['newest','Newest first'],['highest','Highest rating'],['lowest','Lowest rating']].forEach(([v,l])=>{const o=document.createElement('option');o.value=v;o.textContent=l;sort.append(o)});
  const summary=document.createElement('p');summary.className='review-summary-line';const count=Number(activeProductReviewSummary.count)||reviews.length;const avg=Number(activeProductReviewSummary.average)||(reviews.length?reviews.reduce((a,r)=>a+(Number(r.rating)||0),0)/reviews.length:0);summary.textContent=count?`${avg.toFixed(1)} / 5 · ${count} customer review${count===1?'':'s'}`:'No customer ratings yet';root.append(summary,controls);controls.append(rating,sort);
  const list=document.createElement('div');root.append(list);
  const draw=()=>{list.replaceChildren();let shown=reviews.filter(r=>rating.value==='all'||Number(r.rating)===Number(rating.value));shown.sort((a,b)=>sort.value==='highest'?(Number(b.rating)||0)-(Number(a.rating)||0):sort.value==='lowest'?(Number(a.rating)||0)-(Number(b.rating)||0):new Date(b.createdAt||0)-new Date(a.createdAt||0));if(!shown.length){const empty=document.createElement('p');empty.textContent=count?'No reviews match this filter.':'Be the first to review this product.';list.append(empty);return}shown.forEach(r=>{const d=document.createElement('div');d.className='reviewitem';const strong=document.createElement('strong');strong.textContent=(r.customerName||'Customer')+' · '+('★'.repeat(Math.max(1,Math.min(5,Number(r.rating)||5))));const para=document.createElement('p');para.textContent=r.comment||'';if(r.title){const title=document.createElement('b');title.textContent=r.title+' — ';para.prepend(title)}d.append(strong);if(r.verifiedPurchase){const verified=document.createElement('span');verified.className='verified-purchase';verified.textContent='Verified purchase';d.append(verified)}if(r.createdAt){const date=document.createElement('small');date.className='muted';date.textContent=new Date(r.createdAt).toLocaleDateString('en-IN');d.append(date)}d.append(para);list.append(d)})};rating.addEventListener('change',draw);sort.addEventListener('change',draw);draw();
}
async function loadProductReviews(productId){
  const root=byId('reviewList');root.textContent='Loading customer reviews…';
  try{const result=await api('/api/products/'+encodeURIComponent(productId)+'/reviews');if(!selectedProduct||String(selectedProduct.id)!==String(productId))return;activeProductReviews=Array.isArray(result.reviews)?result.reviews:[];activeProductReviewSummary=result.summary||{};renderProductReviews(productId)}
  catch(err){if(selectedProduct&&String(selectedProduct.id)===String(productId))root.textContent='Could not load reviews: '+err.message}
}
function renderRelatedProducts(product){
  const section=byId('relatedProductsSection'),root=byId('relatedProductsGrid');if(!section||!root)return;
  const category=String(product.category||'').trim().toLowerCase();
  const related=products.filter(p=>String(p.id)!==String(product.id)&&!isPreviewOnlyProduct(p)&&(!category||String(p.category||'').trim().toLowerCase()===category)).slice(0,10);
  root.replaceChildren();if(!related.length){section.hidden=true;return}
  related.forEach(p=>{
    const card=document.createElement('article');card.className='card related-product-card';card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label','View '+(p.name||'product'));card.addEventListener('click',()=>openProduct(p.id));card.addEventListener('keydown',e=>{if(e.target===card&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openProduct(p.id)}});
    const pic=document.createElement('div');pic.className='pic';const img=document.createElement('img');img.src=productImages(p)[0]||'';img.alt=p.name||'Related product';img.loading='lazy';pic.append(img,productHeart(p));
    const info=document.createElement('div');info.className='pinfo';const name=document.createElement('h3');name.textContent=p.name||'AERLON product';const price=makePriceElement(p,'price');info.append(name,price);card.append(pic,info);root.append(card);
  });section.hidden=false;
  const prev=byId('relatedPrev'),next=byId('relatedNext');if(prev&&!prev.dataset.bound){prev.dataset.bound='1';prev.addEventListener('click',()=>root.scrollBy({left:-root.clientWidth*.8,behavior:'smooth'}))}if(next&&!next.dataset.bound){next.dataset.bound='1';next.addEventListener('click',()=>root.scrollBy({left:root.clientWidth*.8,behavior:'smooth'}))}
}

function updateProductSEO(product){
  if(!product)return;
  const name=String(product.name||'AERLON product');
  document.title=name+' | AERLON';
  const description=String(product.description||product.shortDescription||'Shop '+name+' at AERLON.').replace(/\s+/g,' ').slice(0,155);
  const meta=document.querySelector('meta[name="description"]');if(meta)meta.content=description;
  const ogTitle=document.querySelector('meta[property="og:title"]');if(ogTitle)ogTitle.content=name+' | AERLON';
  const ogDescription=document.querySelector('meta[property="og:description"]');if(ogDescription)ogDescription.content=description;
  let schema=byId('aerlonProductSchema');if(!schema){schema=document.createElement('script');schema.type='application/ld+json';schema.id='aerlonProductSchema';document.head.append(schema)}
  const image=productImages(product)[0];const price=Number(product.salePrice||product.price||0);const variants=Array.isArray(product.inventoryVariants)?product.inventoryVariants:[];const availability=variants.length&&!variants.some(v=>Number(v.quantity)>0)?'https://schema.org/OutOfStock':'https://schema.org/InStock';const productUrl=new URL(location.pathname,location.origin);productUrl.searchParams.set('product',String(product.id));
  schema.textContent=JSON.stringify({'@context':'https://schema.org','@type':'Product',name,description,image:image?[image]:undefined,sku:String(product.sku||product.id),brand:{'@type':'Brand',name:'AERLON'},offers:price>0?{'@type':'Offer',priceCurrency:'INR',price:price.toFixed(2),availability,url:productUrl.toString()}:undefined});
}
function openProduct(id){const p=products.find(x=>String(x.id)===String(id));if(!p||isPreviewOnlyProduct(p))return;resetInteractiveRating();selectedProduct=p;selectedColorProduct=p;rememberProduct(id);updateProductSEO(p);const palette=[['Black','#171717'],['White','#ffffff'],['Grey','#858585'],['Charcoal','#454545'],['Navy Blue','#172c50'],['Blue','#355c91'],['Sky Blue','#83b9df'],['Red','#c63737'],['Maroon','#711d32'],['Pink','#e6a4b4'],['Purple','#7751a8'],['Lavender','#c5b2e2'],['Green','#35734a'],['Olive','#777744'],['Mint Green','#a8d5bd'],['Yellow','#f0d34f'],['Mustard','#c69b25'],['Orange','#e57b36'],['Beige','#d8c2a4'],['Cream','#f1e6ce'],['Brown','#795548'],['Tan','#bd9168'],['Khaki','#b8aa79'],['Teal','#208c8c'],['Turquoise','#43c6c6'],['Coral','#f08080'],['Wine','#722f37'],['Multicolour','#a58b69'],['Other','#b8b0a5']];const colorRaw=Array.isArray(p.colors)&&p.colors.length?p.colors:(Array.isArray(p.colours)&&p.colours.length?p.colours:[]);const allInventory=Array.isArray(p.inventoryVariants)?p.inventoryVariants:[];const configuredColorNames=colorRaw.map(c=>typeof c==='string'?c:(c.name||c.color||c.colour||'' )).filter(Boolean);const inventory=allInventory.filter(v=>Number(v.quantity)>0&&(!configuredColorNames.length||configuredColorNames.some(c=>String(c).toLowerCase()===String(v.color).toLowerCase())));const inventoryManaged=allInventory.length>0;let colors=colorRaw.length?colorRaw.map(c=>typeof c==='string'?c:(c.name||c.color||c.colour||'Other')):inventory.length?[...new Set(inventory.map(v=>v.color))]:palette.slice(0,5).map(x=>x[0]);const sizeOptions=byId('detailSizeOptions'),swatches=byId('detailColourSwatches');byId('detailSize').value='';byId('detailColour').value='';function sizesFor(color){const activeInventory=Array.isArray(activeColorProduct.inventoryVariants)?activeColorProduct.inventoryVariants:[];if(activeInventory.length)return [...new Set(activeInventory.filter(v=>Number(v.quantity)>0&&String(v.color).toLowerCase()===String(color).toLowerCase()).map(v=>v.size))];const sizeMap=activeColorProduct.sizesByColor||{};const sizeKey=Object.keys(sizeMap).find(k=>String(k).toLowerCase()===String(color).toLowerCase());const configured=Array.isArray(sizeMap[sizeKey])?sizeMap[sizeKey]:null;if(configured)return configured;return ['XS','S','M','L','XL','XXL','XXXL','Free Size','One Size'];}function renderSizes(color){
  sizeOptions.replaceChildren();byId('detailSize').value='';byId('detailAdd').disabled=false;byId('detailBuyNow').disabled=false;
  const activeInventory=Array.isArray(activeColorProduct.inventoryVariants)?activeColorProduct.inventoryVariants:[];
  const configuredVariants=activeInventory.filter(v=>String(v.color).toLowerCase()===String(color).toLowerCase());
  const notifyForSize=async(size,button)=>{if(!currentCustomer){toast('Please sign in to get a back-in-stock email.');location.assign('/login.html');return}button.disabled=true;try{const result=await api('/api/products/'+encodeURIComponent(activeColorProduct.id||p.id)+'/stock-notifications',{color,size});toast(result.message||'You’ll be notified when it is back in stock.')}catch(err){toast(err.message||'Could not save notification request.',true)}finally{button.disabled=false}};
  if(configuredVariants.length){
    const alertButton=document.createElement('button');alertButton.type='button';alertButton.className='add';alertButton.textContent='NOTIFY ME WHEN AVAILABLE';alertButton.style.marginTop='10px';alertButton.hidden=true;
    configuredVariants.forEach(variant=>{const size=String(variant.size||'');if(!size)return;const inStock=Number(variant.quantity)>0;const button=document.createElement('button');button.type='button';button.className='size-option'+(inStock?'':' sold-out');button.textContent=inStock?size:size+' · SOLD OUT';button.setAttribute('aria-pressed','false');button.setAttribute('aria-label',inStock?size:size+' sold out');button.onclick=()=>{sizeOptions.querySelectorAll('.size-option').forEach(x=>x.setAttribute('aria-pressed','false'));button.setAttribute('aria-pressed','true');byId('detailSize').value=size;byId('detailAdd').disabled=!inStock;byId('detailBuyNow').disabled=!inStock;alertButton.hidden=inStock;};sizeOptions.append(button)});
    alertButton.onclick=()=>notifyForSize(byId('detailSize').value,alertButton);sizeOptions.append(alertButton);
    const firstAvailable=configuredVariants.find(v=>Number(v.quantity)>0);if(firstAvailable){const button=[...sizeOptions.querySelectorAll('.size-option')].find(x=>x.textContent===String(firstAvailable.size));if(button)button.click()}else{const first=[...sizeOptions.querySelectorAll('.size-option')][0];if(first)first.click();const msg=document.createElement('p');msg.className='muted';msg.textContent='This colour is currently sold out. Select a size to request an email when it returns.';sizeOptions.prepend(msg)}
    return;
  }
  const sizes=sizesFor(color);
  if(!sizes.length){const msg=document.createElement('p');msg.className='muted';msg.textContent='No sizes are configured for this colour.';sizeOptions.append(msg);return}
  sizes.forEach(size=>{const button=document.createElement('button');button.type='button';button.className='size-option';button.textContent=size;button.setAttribute('aria-pressed','false');button.onclick=()=>{sizeOptions.querySelectorAll('.size-option').forEach(x=>x.setAttribute('aria-pressed','false'));button.setAttribute('aria-pressed','true');byId('detailSize').value=size;byId('detailAdd').disabled=false;byId('detailBuyNow').disabled=false};sizeOptions.append(button)});
}
byId('detailTitle').textContent=p.name;byId('detailCategory').textContent=p.category||'AERLON';const detailPrice=byId('detailPrice');detailPrice.replaceChildren(makePriceElement(p,'price detail-price-display'));const detailOffer=byId('detailOffer');detailOffer.textContent=productOfferLabel(p);detailOffer.hidden=!detailOffer.textContent;byId('detailDescription').textContent=p.description||p.shortDescription||'A considered everyday essential. Check product details and sizing before ordering.';let activeColorProduct=p;let imgs=productImages(p);let activeImageIndex=0;const detailImage=byId('detailImage'),detailHero=detailImage.closest('.detailhero');function showProductImage(index){if(!imgs.length){detailImage.removeAttribute('src');byId('detailThumbs').replaceChildren();return}activeImageIndex=((index%imgs.length)+imgs.length)%imgs.length;if(detailHero)detailHero.dataset.imageIndex=String(activeImageIndex);detailImage.style.opacity='.35';aerlonSetGalleryImage(detailImage,imgs[activeImageIndex]);detailImage.alt=(p.name||'Product')+' image '+(activeImageIndex+1)+' of '+imgs.length;const dots=byId('detailThumbs');dots.querySelectorAll('button').forEach((dot,i)=>{dot.classList.toggle('active',i===activeImageIndex);dot.setAttribute('aria-current',String(i===activeImageIndex));dot.setAttribute('aria-label','Show image '+(i+1)+' of '+imgs.length)});const counter=byId('detailImageCounter');if(counter)counter.textContent=imgs.length>1?`${activeImageIndex+1} / ${imgs.length}`:''}detailImage.onerror=()=>{detailImage.style.visibility='hidden';};detailImage.onload=()=>{detailImage.style.visibility='visible';detailImage.style.opacity='1'};detailImage.style.visibility='visible';const dotsRoot=byId('detailThumbs');function renderColorGallery(){imgs=productImages(activeColorProduct);activeImageIndex=0;aerlonPreloadImages(imgs);dotsRoot.replaceChildren();imgs.forEach((src,i)=>{const b=document.createElement('button');b.type='button';b.className='slider-dot';b.setAttribute('aria-label','Show image '+(i+1)+' of '+imgs.length);b.onclick=()=>showProductImage(i);dotsRoot.append(b)});showProductImage(0);const counter=byId('detailImageCounter');if(counter)counter.textContent=imgs.length>1?`1 / ${imgs.length}`:'';}renderColorGallery();if(detailHero&&!detailHero.dataset.sliderBound){detailHero.dataset.sliderBound='true';let touchStartX=0,touchStartY=0;detailHero.addEventListener('touchstart',e=>{const t=e.changedTouches[0];touchStartX=t.clientX;touchStartY=t.clientY},{passive:true});detailHero.addEventListener('touchend',e=>{const liveImages=selectedColorProduct?productImages(selectedColorProduct):[];if(!liveImages.length)return;const t=e.changedTouches[0],dx=t.clientX-touchStartX,dy=t.clientY-touchStartY;if(Math.abs(dx)>40&&Math.abs(dx)>Math.abs(dy)){const current=Number(detailHero.dataset.imageIndex||0);const next=dx<0?current+1:current-1;detailHero.dataset.imageIndex=String(((next%liveImages.length)+liveImages.length)%liveImages.length);if(selectedProduct){const image=byId('detailImage');aerlonSetGalleryImage(image,liveImages[((next%liveImages.length)+liveImages.length)%liveImages.length]);image.alt=(selectedProduct.name||'Product')+' image '+((((next%liveImages.length)+liveImages.length)%liveImages.length)+1)+' of '+liveImages.length;byId('detailThumbs').querySelectorAll('button').forEach((dot,i)=>{dot.classList.toggle('active',i===(((next%liveImages.length)+liveImages.length)%liveImages.length));dot.setAttribute('aria-current',String(i===(((next%liveImages.length)+liveImages.length)%liveImages.length)))});const counter=byId('detailImageCounter');if(counter)counter.textContent=liveImages.length>1?`${(((next%liveImages.length)+liveImages.length)%liveImages.length)+1} / ${liveImages.length}`:''}}},{passive:true});detailHero.addEventListener('keydown',e=>{if(!selectedProduct||!['ArrowRight','ArrowLeft'].includes(e.key))return;e.preventDefault();const live=productImages(selectedColorProduct||selectedProduct);if(!live.length)return;const current=Number(detailHero.dataset.imageIndex||0),next=e.key==='ArrowRight'?current+1:current-1,idx=((next%live.length)+live.length)%live.length;detailHero.dataset.imageIndex=String(idx);aerlonSetGalleryImage(byId('detailImage'),live[idx]);byId('detailImage').alt=(selectedProduct.name||'Product')+' image '+(idx+1)+' of '+live.length;byId('detailThumbs').querySelectorAll('button').forEach((dot,i)=>{dot.classList.toggle('active',i===idx);dot.setAttribute('aria-current',String(i===idx))});const counter=byId('detailImageCounter');if(counter)counter.textContent=live.length>1?`${idx+1} / ${live.length}`:''});detailHero.tabIndex=0;detailHero.setAttribute('aria-label','Product image carousel. Swipe or use left and right arrow keys to change images.')}const sliderCounter=byId('detailImageCounter');if(sliderCounter)sliderCounter.textContent=imgs.length>1?`1 / ${imgs.length}`:'';swatches.replaceChildren();let initialColorSet=false;colors.forEach((name,i)=>{const match=palette.find(x=>x[0].toLowerCase()===String(name).toLowerCase()),hex=match?match[1]:'#b8b0a5',b=document.createElement('button');b.type='button';b.className='colour-swatch';b.style.backgroundColor=hex;b.style.setProperty('--swatch-check',hex.toLowerCase()==='#ffffff'?'#171717':'#fff');b.setAttribute('aria-label','Select colour '+name);b.title=name;b.setAttribute('aria-pressed','false');const linkedId=p.colorVariants&&p.colorVariants[name]?String(p.colorVariants[name]):'';const linkedProduct=linkedId?products.find(x=>String(x.id)===linkedId):null;const familyKey=x=>[String(x?.category||'').trim().toLowerCase(),String(x?.productType||x?.category||'').trim().toLowerCase()].join('::');const validLinkedProduct=!linkedId||(linkedProduct&&familyKey(linkedProduct)===familyKey(p));if(linkedId&&!validLinkedProduct){b.disabled=true;b.title=name+' — linked product is unavailable or belongs to another product type';b.setAttribute('aria-label',name+' unavailable');}b.onclick=()=>{if(b.disabled)return;swatches.querySelectorAll('.colour-swatch').forEach(x=>x.setAttribute('aria-pressed','false'));b.setAttribute('aria-pressed','true');byId('detailColour').value=name;const linkedId=p.colorVariants&&p.colorVariants[name]?String(p.colorVariants[name]):'';activeColorProduct=linkedId&&validLinkedProduct?linkedProduct:p;selectedColorProduct=activeColorProduct;renderColorGallery();const activePrice=byId('detailPrice');activePrice.replaceChildren(makePriceElement(activeColorProduct,'price detail-price-display'));const activeOffer=byId('detailOffer');activeOffer.textContent=productOfferLabel(activeColorProduct);activeOffer.hidden=!activeOffer.textContent;renderSizes(name)};swatches.append(b);if(!b.disabled&&!initialColorSet){initialColorSet=true;b.click()}});byId('detailWish').textContent=isWished(id)?'♥ WISHLISTED':'♡ WISHLIST';const rr=byId('reviewList');rr.textContent='Loading customer reviews…';openModal('productModal');if(byId('sizeGuidePanel'))byId('sizeGuidePanel').hidden=true;if(byId('sizeGuideToggle'))byId('sizeGuideToggle').textContent='SIZE GUIDE';if(byId('deliveryDropdown'))byId('deliveryDropdown').open=false;if(byId('deliveryPin'))byId('deliveryPin').value='';if(byId('deliveryEstimate'))byId('deliveryEstimate').textContent='Estimated delivery is confirmed after address and courier serviceability checks.';renderRelatedProducts(p);resetInteractiveRating();loadProductReviews(p.id)}

byId('sizeGuideToggle')?.addEventListener('click',()=>{const panel=byId('sizeGuidePanel');panel.hidden=!panel.hidden;byId('sizeGuideToggle').textContent=panel.hidden?'SIZE GUIDE':'HIDE SIZE GUIDE'});
byId('shareProductBtn')?.addEventListener('click',async()=>{if(!selectedProduct)return;const url=new URL(location.href);url.searchParams.set('product',String(selectedProduct.id));const data={title:selectedProduct.name||'AERLON product',text:'Discover this AERLON product.',url:url.toString()};try{if(navigator.share)await navigator.share(data);else if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(data.url);toast('Product link copied.')}else{const field=document.createElement('textarea');field.value=data.url;document.body.append(field);field.select();document.execCommand('copy');field.remove();toast('Product link copied.')}}catch(err){if(err.name!=='AbortError')toast('Could not share this product link.',true)}});
// Rating is empty by default; clicked stars fill gold up to the selected value.
function resetInteractiveRating(){
  const select=byId('reviewRating');if(select)select.value='';
  byId('interactiveStars')?.querySelectorAll('button[data-rating]').forEach(star=>{star.classList.remove('active');star.textContent='☆';star.setAttribute('aria-checked','false')});
  const caption=document.querySelector('.rating-caption');if(caption)caption.textContent='Tap a star';
}
byId('interactiveStars')?.querySelectorAll('button[data-rating]').forEach(btn=>btn.addEventListener('click',()=>{
  const value=Number(btn.dataset.rating);byId('reviewRating').value=String(value);
  byId('interactiveStars').querySelectorAll('button').forEach(star=>{const active=Number(star.dataset.rating)<=value;star.classList.toggle('active',active);star.textContent=active?'★':'☆';star.setAttribute('aria-checked',String(Number(star.dataset.rating)===value))});
  const caption=document.querySelector('.rating-caption');if(caption)caption.textContent=['','Poor','Fair','Good','Very good','Excellent'][value];
}));
// Tap the product photo to open a full-screen zoom view; return keeps the product modal intact.
const zoomOverlay=byId('imageZoomOverlay'),zoomImage=byId('zoomedProductImage');
byId('detailImage')?.addEventListener('click',()=>{if(!byId('detailImage').src)return;zoomImage.src=byId('detailImage').src;zoomImage.alt=byId('detailImage').alt+' — enlarged';zoomOverlay.hidden=false;document.body.classList.add('image-zoom-open')});
function closeImageZoom(){if(zoomOverlay){zoomOverlay.hidden=true;zoomImage.removeAttribute('src');document.body.classList.remove('image-zoom-open')}}
byId('zoomBackBtn')?.addEventListener('click',closeImageZoom);byId('zoomCloseBtn')?.addEventListener('click',closeImageZoom);zoomOverlay?.addEventListener('click',e=>{if(e.target===zoomOverlay)closeImageZoom()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&zoomOverlay&&!zoomOverlay.hidden)closeImageZoom()});
byId('deliveryPin')?.addEventListener('input',e=>{e.target.value=e.target.value.replace(/\D/g,'').slice(0,6)});
byId('deliveryPin')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();byId('checkDeliveryBtn')?.click()}});
byId('checkDeliveryBtn')?.addEventListener('click',()=>{const pin=byId('deliveryPin').value.trim(),out=byId('deliveryEstimate');if(!/^\d{6}$/.test(pin)){out.textContent='Please enter all 6 digits of your Indian PIN code (for example, 273001).';byId('deliveryPin').focus();return}const from=new Date();let days=5;while(days>0){from.setDate(from.getDate()+1);if(from.getDay()!==0)days--}const to=new Date(from);let remaining=3;while(remaining>0){to.setDate(to.getDate()+1);if(to.getDay()!==0)remaining--}const fmt=d=>d.toLocaleDateString('en-IN',{day:'numeric',month:'short'});out.textContent=`Indicative delivery window: ${fmt(from)}–${fmt(to)}. This is an estimate only; PIN serviceability and final ETA are confirmed before dispatch.`});
byId('detailAdd').onclick=()=>{if(!selectedProduct)return;const color=byId('detailColour').value,size=byId('detailSize').value;if(!color||!size)return toast('Please select a colour and an available size.');add((selectedColorProduct||selectedProduct).id,color,size);closeModal('productModal');showBag(true)};
byId('detailBuyNow').onclick=()=>{if(!selectedProduct)return;const color=byId('detailColour').value,size=byId('detailSize').value;if(!color||!size)return toast('Please select a colour and an available size.');add((selectedColorProduct||selectedProduct).id,color,size);closeModal('productModal');showBag(false);updateCheckoutSummary();showCheckout(true)};
byId('detailWish').onclick = event => { if (selectedProduct) saveAndOpenWishlist(selectedProduct.id, event.currentTarget); };

byId('menuBtn').onclick=()=>{
  const opening=!byId('settingsModal').classList.contains('show');
  if(opening)openModal('settingsModal');else closeModal('settingsModal');
  byId('menuBtn').setAttribute('aria-expanded',String(opening));
};
byId('mobileSearchBtn')?.addEventListener('click',()=>{
  byId('aerlonHeaderSearchInput')?.focus();
});
document.querySelectorAll('[data-menu-close]').forEach(link=>link.addEventListener('click',()=>{
  closeModal('settingsModal');
  byId('menuBtn').setAttribute('aria-expanded','false');
  if(/^#(men|women|jackets|sneakers)$/.test(link.getAttribute('href')||'')){
    requestAnimationFrame(()=>byId('shop')?.scrollIntoView({behavior:'smooth',block:'start'}));
  }
}));
byId('settingsModal')?.addEventListener('click',event=>{
  if(event.target===byId('settingsModal')){
    closeModal('settingsModal');
    byId('menuBtn').setAttribute('aria-expanded','false');
  }
});byId('profileMenuBtn').onclick=()=>{closeModal('settingsModal');byId('menuBtn').setAttribute('aria-expanded','false');if(currentCustomer){openModal('accountModal');updateAuthUI()}else{location.assign('/login.html')}};byId('trackMenuBtn').onclick=()=>{closeModal('settingsModal');byId('menuBtn').setAttribute('aria-expanded','false');openModal('trackModal')};

document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{closeModal(b.dataset.close);if(b.dataset.close==='settingsModal')byId('menuBtn').setAttribute('aria-expanded','false')});
document.querySelectorAll('[data-auth]').forEach(b=>b.onclick=()=>{authMode=b.dataset.auth;document.querySelectorAll('[data-auth]').forEach(x=>x.classList.toggle('active',x===b));const signup=authMode==='signup',forgot=authMode==='forgot';byId('accountTitle').textContent=forgot?'Reset your password':signup?'Create your account':'Welcome back';byId('authName').hidden=!signup;byId('authNameLabel').hidden=!signup;byId('authName').required=signup;byId('authPhone').hidden=!signup;byId('authPhoneLabel').hidden=!signup;byId('authPhone').required=signup;byId('authPassword').hidden=forgot;byId('authPasswordLabel').hidden=forgot;byId('authPassword').required=!forgot;byId('authPassword').autocomplete=signup?'new-password':'current-password';byId('authSubmit').textContent=forgot?'SEND RESET LINK':signup?'CREATE ACCOUNT':'LOGIN';byId('authNote').textContent='This form needs matching server-side authentication routes; no password is stored in this browser.'});
let currentCustomer=null;
let customerExpiryTimer;
let lastCustomerActivity = 0;

function clearCustomerIdentity() {
  clearTimeout(customerExpiryTimer);
  currentCustomer = null;
  safeRemove('aerlon_session_v1');
  byId('recentOrdersList').textContent = '';
  updateAuthUI();
}

async function checkCustomerExpiry() {
  if (!currentCustomer) return;
  try {
    const session = await api('/api/auth/me');
    if (!session.authenticated) clearCustomerIdentity();
  } catch {
    clearCustomerIdentity();
  }
}

function observeCustomerSession(response) {
  const remaining = Number(response.headers.get('X-Customer-Remaining-Ms'));
  if (remaining > 0) {
    clearTimeout(customerExpiryTimer);
    customerExpiryTimer = setTimeout(checkCustomerExpiry, remaining + 20);
  } else if (response.status === 401 && currentCustomer) {
    clearCustomerIdentity();
  }
}

function customerActivity(event) {
  if (!currentCustomer || document.hidden || !event.isTrusted || Date.now() - lastCustomerActivity < 15000) return;
  lastCustomerActivity = Date.now();
  api('/api/auth/activity', {}).catch(() => {});
}
for (const event of ['pointerdown', 'keydown', 'wheel', 'touchmove']) {
  document.addEventListener(event, customerActivity, { passive: true });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkCustomerExpiry();
});
async function syncWishlistWithAccount(){
  if(!currentCustomer?.id)return;
  const localIds=[...new Set(safeRead(STORE.wish,[]).map(String))];
  for(const id of localIds){
    try{await api('/api/wishlist/'+encodeURIComponent(id),{});}catch(error){
      if(error.message&&error.message.toLowerCase().includes('sign in'))return;
      // A product may have been removed from the live catalogue; ignore that stale ID.
    }
  }
  try{
    const result=await api('/api/wishlist');
    const serverIds=Array.isArray(result.wishlist)?result.wishlist.map(p=>String(p.id)).filter(Boolean):[];
    safeWrite(STORE.wish,[...new Set([...serverIds,...localIds])]);
    renderWish();renderProducts();
  }catch(error){console.warn('Could not load account wishlist:',error.message)}
}
function updateAuthUI(){const session=currentCustomer;byId('accountState').textContent=session?'Signed in as '+(session.email||session.phone||session.name||'customer')+'.':'Login or create an account to access your profile and order history.';byId('logoutBtn').hidden=!currentCustomer;byId('authForm').hidden=!!currentCustomer}
async function refreshCustomerSession(){try{const r=await api('/api/auth/me');currentCustomer=r.authenticated?r.user:null;if(currentCustomer){safeWrite('aerlon_session_v1',currentCustomer);await syncWishlistWithAccount()}else safeRemove('aerlon_session_v1')}catch(e){currentCustomer=null}updateAuthUI()}
const resetTokenFromUrl=new URLSearchParams(location.search).get('token')||'';
if(resetTokenFromUrl){
  authMode='reset';
  document.querySelector('.tabs').hidden=true;
  byId('accountTitle').textContent='Create a new password';
  byId('authEmail').hidden=true;byId('authEmail').required=false;
  byId('authName').hidden=true;byId('authNameLabel').hidden=true;byId('authName').required=false;
  byId('authPhone').hidden=true;byId('authPhoneLabel').hidden=true;byId('authPhone').required=false;
  byId('authPassword').hidden=false;byId('authPassword').required=true;byId('authPassword').value='';byId('authPassword').autocomplete='new-password';
  byId('authPasswordLabel').hidden=false;byId('authPassword').placeholder='New password (at least 8 characters)';
  byId('authSubmit').textContent='UPDATE PASSWORD';
  byId('authNote').textContent='Choose a new password with at least 8 characters. This reset link expires after 30 minutes.';
  openModal('accountModal');
}
byId('authForm').addEventListener('submit',async e=>{e.preventDefault();const btn=byId('authSubmit');btn.disabled=true;try{const payload={name:byId('authName').value.trim(),email:byId('authEmail').value.trim(),phone:byId('authPhone').value.trim(),password:byId('authPassword').value};let endpoint;if(authMode==='reset'){payload.token=resetTokenFromUrl;endpoint='/api/auth/reset-password'}else endpoint=authMode==='signup'?'/api/auth/signup':authMode==='forgot'?'/api/auth/forgot-password':'/api/auth/login';const result=await api(endpoint,payload);if(authMode==='forgot'){toast(result.message||'If the account exists, reset instructions will be sent.');return}if(authMode==='reset'){history.replaceState({},document.title,location.pathname+location.hash);byId('authPassword').value='';closeModal('accountModal');document.querySelector('.tabs').hidden=false;byId('authEmail').hidden=false;byId('authEmail').required=true;byId('authPassword').placeholder='Password';authMode='login';toast(result.message||'Password updated. You can now sign in.');return}if(result.user){currentCustomer=result.user;safeWrite('aerlon_session_v1',result.user);await syncWishlistWithAccount();byId('authPassword').value='';updateAuthUI();closeModal('accountModal');showLoginSuccess(authMode==='signup')}else{throw new Error('Unexpected authentication response.')}}catch(err){byId('authNote').textContent='Could not complete this request: '+err.message;}finally{btn.disabled=false}});
byId('logoutBtn').onclick=async()=>{try{await api('/api/auth/logout',{});}catch(e){toast('Could not contact server; please try again.');return}currentCustomer=null;safeRemove('aerlon_session_v1');updateAuthUI();toast('You have been logged out.')};
byId('trackForm').addEventListener('submit',async e=>{e.preventDefault();const btn=byId('trackSubmit'),root=byId('trackResult');root.replaceChildren();const loading=document.createElement('div');loading.className='track-result-card';loading.style.padding='22px';loading.textContent='Looking up your order securely…';root.append(loading);btn.disabled=true;btn.textContent='CHECKING ORDER…';try{const orderId=byId('trackOrderId').value.trim(),id=encodeURIComponent(orderId),phone=encodeURIComponent(byId('trackPhone').value.trim());const result=await api('/api/orders/track?orderId='+id+'&phone='+phone);renderTrackResult(result,orderId)}catch(err){root.replaceChildren();const error=document.createElement('div');error.className='track-error';error.textContent='We couldn’t retrieve this order right now. '+err.message+' Please check the order reference and mobile number, then try again.';root.append(error)}finally{btn.disabled=false;btn.innerHTML='TRACK MY ORDER <span aria-hidden="true">↗</span>'}});
byId('reviewForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!selectedProduct)return;
  if(!byId('reviewRating').value){toast('Please select a star rating before submitting.');return}
  const session=currentCustomer;
  if(!session){toast('Please sign in to submit a review.');location.assign('/login.html');return}
  const submit=e.submitter||byId('reviewForm').querySelector('button[type="submit"]');
  if(submit){submit.disabled=true;submit.textContent='SUBMITTING…'}
  try{
    const result=await api('/api/products/'+encodeURIComponent(selectedProduct.id)+'/reviews',{
      rating:Number(byId('reviewRating').value),title:byId('reviewName').value.trim(),comment:byId('reviewText').value.trim()
    });
    toast(result.message||'Review saved successfully.');
    byId('reviewText').value='';
    byId('reviewName').value='';
    await loadProductReviews(selectedProduct.id);
  }catch(err){
    toast('Review not saved: '+err.message+(err.message.includes('sign in')?' Please log in to your account.':''));
  }finally{if(submit){submit.disabled=false;submit.textContent='SUBMIT REVIEW'}}
});
byId('themeSelect').value=safeRead(STORE.theme,'light');function applyTheme(v){document.body.classList.toggle('dark',v==='dark');safeWrite(STORE.theme,v);byId('themeSelect').value=v;byId('themeLabel').textContent=v==='dark'?'Dark mode':'Light mode';byId('themeSymbol').textContent=v==='dark'?'☾':'☼';document.querySelector('meta[name=theme-color]')?.setAttribute('content',v==='dark'?'#151515':'#ffffff')}applyTheme(byId('themeSelect').value);byId('themeSelect').onchange=e=>applyTheme(e.target.value);
byId('recentOrdersBtn').onclick=async()=>{closeModal('settingsModal');byId('menuBtn').setAttribute('aria-expanded','false');openModal('recentOrdersModal');const root=byId('recentOrdersList');root.textContent='Loading your orders…';try{const me=await api('/api/auth/me');if(!me.authenticated){root.textContent='Please sign in to view orders placed using your customer account.';location.assign('/login.html');return}currentCustomer=me.user;safeWrite('aerlon_session_v1',me.user);updateAuthUI();const result=await api('/api/orders/my');const orders=Array.isArray(result.orders)?result.orders:[];root.replaceChildren();if(!orders.length){root.textContent='No recent orders found for this account yet.';return}orders.slice(0,10).forEach(o=>{const d=document.createElement('div');d.className='reviewitem';const id=document.createElement('strong');id.textContent=(o.id||o.orderId||'Order');const meta=document.createElement('p');meta.textContent=(o.orderStatus||o.status||'received').replaceAll('_',' ')+' · '+(o.paymentStatus||'pending')+' · '+money(Number(o.total||o.amount)||0);const date=document.createElement('p');date.className='muted';date.textContent=o.createdAt?'Placed '+new Date(o.createdAt).toLocaleDateString('en-IN'):'';d.append(id,meta,date);root.append(d)})}catch(err){root.textContent='Could not load orders: '+err.message+'. Please sign in again if your session has expired.'}}
// Expose settings from the account area with a small inline link.
const settingsLink=document.createElement('button');settingsLink.className='add';settingsLink.textContent='SETTINGS / APPEARANCE';settingsLink.style.marginTop='12px';settingsLink.onclick=()=>{closeModal('accountModal');openModal('settingsModal')};byId('accountState').after(settingsLink);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&byId('settingsModal').classList.contains('show')){closeModal('settingsModal');byId('menuBtn').setAttribute('aria-expanded','false')}});
// Product cards intentionally show no View Product or Wishlist buttons; click the card to open details.
// Wrap the existing add-to-bag behaviour so cart contents survive refreshes.
const originalAdd=add;add=function(id,color='',size=''){originalAdd(id,color,size);safeWrite('aerlon_cart_v1',cart)};
const oldChange=change;change=function(id,d){oldChange(id,d);safeWrite('aerlon_cart_v1',cart)};
const oldRenderCart=renderCart;renderCart=function(){oldRenderCart();safeWrite("aerlon_cart_v1",cart);if(byId('checkout')?.classList.contains('show')){renderCheckoutItems();updateCheckoutSummary()}};
// Load owner-managed promotional banners from the public storefront API.
async function applySalesBanners(){
  const section=byId('salesBannerSection'),track=byId('salesBannerTrack');
  if(!section||!track)return;
  try{
    const response=await fetch('/api/storefront/banners',{headers:{'Accept':'application/json'}});
    if(!response.ok)return;
    const data=await response.json();
    const banners=Array.isArray(data.banners)?data.banners.filter(b=>b&&b.active!==false&&b.title):[];
    track.replaceChildren();
    banners.forEach(b=>{
      const card=document.createElement('article');card.className='sales-banner';
      const hasDesignedArt=typeof b.imageUrl==='string'&&/^https:\/\//i.test(b.imageUrl);
      if(hasDesignedArt){card.classList.add('has-designed-art');const image=document.createElement('img');image.className='sales-banner-image';image.src=b.imageUrl;image.alt=b.title||'AERLON campaign banner';image.loading='eager';image.decoding='async';image.referrerPolicy='no-referrer';card.append(image)}
      const copy=document.createElement('div');copy.className='sales-banner-copy';
      const title=document.createElement('h2');title.textContent=b.title;copy.append(title);
      if(b.subtitle){const subtitle=document.createElement('p');subtitle.textContent=b.subtitle;copy.append(subtitle)}
      if(b.buttonText&&b.buttonUrl){const link=document.createElement('a');link.textContent=b.buttonText;link.href=b.buttonUrl;link.rel='noopener';if(/^https:\/\//i.test(b.buttonUrl)){link.target='_blank'}copy.append(link)}
      if(!hasDesignedArt)card.append(copy);track.append(card);
    });
    section.hidden=!banners.length;
  }catch(error){console.warn('AERLON promotions could not be loaded:',error)}
}

// Apply owner-managed storefront header settings without blocking the page.
const defaultFooterSettings={enabled:true,brandText:'AERLON',tagline:'Defined by style. Built for you.',intro:'Considered fashion and everyday essentials, curated for a distinctive point of view.',showBrand:true,showTagline:true,showIntro:true,socials:{},columns:[],newsletterEnabled:true,newsletterKicker:'THE AERLON EDIT',newsletterTitle:'A considered edit, delivered.',newsletterDescription:'Discover new arrivals, style stories and occasional AERLON updates.',newsletterButtonText:'SUBSCRIBE',newsletterConsentText:'I agree to receive occasional AERLON updates by email.',trustEnabled:true,trustItems:['SECURE CHECKOUT','PAYMENT OPTIONS AT CHECKOUT','SHOP WITH CONFIDENCE'],copyrightText:'ALL RIGHTS RESERVED.',backToTopEnabled:true};
function applyFooterColumns(columns){
  const host=byId('mcFooterLinks');if(!host)return;host.replaceChildren();
  (Array.isArray(columns)?columns:[]).forEach((column,index)=>{
    const nav=document.createElement('nav');nav.className='mc-footer-links';nav.setAttribute('aria-label',String(column.title||`Footer links ${index+1}`));
    const heading=document.createElement('h3');heading.textContent=String(column.title||'LINKS');nav.appendChild(heading);
    (Array.isArray(column.links)?column.links:[]).forEach(link=>{
      const label=String(link.label||'').trim();if(!label)return;
      let el;
      if(link.action==='track'){el=document.createElement('button');el.type='button';el.dataset.footerAction='track';}
      else{const url=String(link.url||'').trim();if(!(/^(https:\/\/|\/(?!\/)|#|mailto:|tel:)/i.test(url)))return;el=document.createElement('a');el.href=url;if(/^https:\/\//i.test(url)){el.target='_blank';el.rel='noopener noreferrer';}}
      if(el.tagName==='A'&&/^mailto:/i.test(el.getAttribute('href')||'')){
        el.classList.add('mc-footer-email-link');
        const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');
        icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');
        icon.innerHTML='<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3.5 7 8.5 6 8.5-6"></path>';
        const text=document.createElement('span');text.textContent=label;
        el.append(icon,text);
      }else{el.textContent=label;}
      nav.appendChild(el);
    });
    host.appendChild(nav);
  });
  prepareFooterAccordions();
}
function prepareFooterAccordions(){
  document.querySelectorAll('#mcFooterLinks .mc-footer-links').forEach((nav,index)=>{
    if(nav.querySelector('.mc-footer-accordion-button'))return;
    const heading=nav.querySelector('h3');if(!heading)return;
    const text=heading.textContent.trim();
    const button=document.createElement('button');
    button.type='button';
    button.className='mc-footer-accordion-button';
    button.setAttribute('aria-expanded',String(!matchMedia('(max-width:720px)').matches));
    const panel=document.createElement('div');
    panel.className='mc-footer-link-list';
    panel.id='mcFooterPanel'+index;
    button.setAttribute('aria-controls',panel.id);
    const caption=document.createElement('span');caption.textContent=text;
    const caret=document.createElement('span');caret.className='mc-footer-accordion-caret';caret.textContent='⌄';caret.setAttribute('aria-hidden','true');
    button.append(caption,caret);
    heading.replaceChildren(button);
    for(const item of [...nav.children]){if(item!==heading)panel.appendChild(item);}
    nav.appendChild(panel);
    button.addEventListener('click',()=>button.setAttribute('aria-expanded',String(button.getAttribute('aria-expanded')!=='true')));
  });
}
async function applyStorefrontFooter(){
  try{
    const response=await fetch('/api/storefront/footer',{headers:{'Accept':'application/json'},cache:'no-store'});if(!response.ok)return;
    const payload=await response.json();const f={...defaultFooterSettings,...(payload.footer||{}),socials:{...defaultFooterSettings.socials,...(payload.footer?.socials||{})}};
    const footer=byId('siteFooter');if(!footer)return;footer.hidden=f.enabled===false;
    const brand=byId('mcFooterBrand');if(brand){brand.hidden=f.showBrand===false;brand.replaceChildren();if(f.logoUrl&&/^https:\/\//i.test(f.logoUrl)){const img=document.createElement('img');img.src=f.logoUrl;img.alt=f.brandText||'AERLON';img.loading='lazy';img.style.cssText='max-height:42px;max-width:190px;object-fit:contain';brand.appendChild(img);}else{brand.appendChild(document.createTextNode(f.brandText||'AERLON'));const dot=document.createElement('span');dot.textContent='.';brand.appendChild(dot);}}
    const tagline=byId('mcFooterTagline');if(tagline){tagline.textContent=f.tagline||'';tagline.hidden=f.showTagline===false||!f.tagline;}
    const intro=byId('mcFooterIntro');if(intro){intro.textContent=f.intro||'';intro.hidden=f.showIntro===false||!f.intro;}
    document.querySelectorAll('[data-social]').forEach(link=>{const url=String(f.socials?.[link.dataset.social]||'').trim();let valid=false;
      try {
        const parsed=new URL(url), host=parsed.hostname.replace(/^www\./,'');
        const hosts={instagram:['instagram.com'],facebook:['facebook.com'],youtube:['youtube.com'],pinterest:['pinterest.com','pinterest.in'],x:['x.com','twitter.com'],whatsapp:['wa.me','api.whatsapp.com']};
        valid=parsed.protocol==='https:' && !parsed.username && !parsed.password && !parsed.port && hosts[link.dataset.social]?.includes(host) && parsed.pathname.length>1;
      } catch {}
      if (!valid) link.removeAttribute('href');link.hidden=!valid;if(valid){link.href=url;link.target='_blank';link.rel='noopener noreferrer';}});
    if(Array.isArray(f.columns))applyFooterColumns(f.columns);
    const newsletter=byId('mcFooterNewsletter');if(newsletter)newsletter.hidden=f.newsletterEnabled===false;
    const setText=(id,value)=>{const el=byId(id);if(el&&typeof value==='string')el.textContent=value;};
    setText('mcFooterNewsletterKicker',f.newsletterKicker);setText('mcFooterNewsletterTitle',f.newsletterTitle);setText('mcFooterNewsletterDescription',f.newsletterDescription);setText('mcFooterNewsletterButtonText',f.newsletterButtonText);setText('mcFooterNewsletterConsentText',f.newsletterConsentText);
    const trust=byId('mcFooterTrust');if(trust){trust.hidden=f.trustEnabled===false;(f.trustItems||[]).slice(0,3).forEach((value,index)=>{const label=trust.querySelectorAll('.mc-trust-label')[index];if(label)label.textContent=value||'';});}
    setText('mcFooterCopyrightBrand',f.brandText||'AERLON');setText('mcFooterCopyrightText',f.copyrightText||'ALL RIGHTS RESERVED.');
    const back=byId('mcFooterBackTop');if(back)back.hidden=f.backToTopEnabled===false;
  }catch(_error){/* Keep the default footer if settings are unavailable. */}
}

async function applyStorefrontHeader(){
  try{
    const response=await fetch('/api/storefront/header',{headers:{'Accept':'application/json'}});
    if(!response.ok)return;
    const data=await response.json();
    const h=data.header||{};
    const strip=byId('announcementStrip');
    if(strip){
      if(h.showAnnouncement===false){strip.hidden=true;}
      else if(typeof h.announcement==='string'&&h.announcement.trim()){
        strip.hidden=false;
        const parts=h.announcement.split(/\s*(?:✦|\||·|•)\s*/).map(x=>x.trim()).filter(Boolean).slice(0,8);
        if(parts.length){
          strip.classList.toggle('single-message', parts.length === 1);
          const track=strip.querySelector('.announce-track');
          track.replaceChildren();
          for(let copy=0;copy<2;copy++){
            const group=document.createElement('div');group.className='announce-group';
            parts.forEach(text=>{const item=document.createElement('span');item.className='announce-item';item.textContent=text;group.appendChild(item)});
            track.appendChild(group);
          }
          const accessible=byId('announcementAccessible');if(accessible)accessible.textContent=parts.join('. ')+'.';
        }
      }
    }
    byId('storeHeader').dispatchEvent(new CustomEvent('store-brand', {detail:h}));
    if(typeof h.tagline==='string'){
      const tagline=document.querySelector('#mcFooterTagline');
      if(tagline){tagline.textContent=h.tagline;tagline.hidden=h.showTagline===false;}
    }

  }catch(_error){/* Keep the default storefront if settings are unavailable. */}
}
applyStorefrontHeader().then(applyStorefrontFooter);
applySalesBanners();
cart=safeRead('aerlon_cart_v1',[]).filter(item=>item&&item.id&&Number.isInteger(Number(item.quantity))&&Number(item.quantity)>0&&Number(item.quantity)<=10).map(item=>({id:String(item.id),color:String(item.color||''),size:String(item.size||''),quantity:Number(item.quantity)}));safeWrite('aerlon_cart_v1',cart);renderCart();refreshCustomerSession();

byId('successContinueBtn').addEventListener('click',()=>closeModal('orderSuccessModal'));
byId('successTrackBtn').addEventListener('click',()=>{const id=byId('successOrderId').textContent;closeModal('orderSuccessModal');byId('trackOrderId').value=id==='Reference unavailable'?'':id;byId('trackResult').replaceChildren();openModal('trackModal');});
byId('loginSuccessContinue').addEventListener('click',()=>closeModal('loginSuccessModal'));

// Luxury puzzle entry: show once per tab; skip for reduced-motion users.
const intro=byId('mcIntro');
let introDismissed=false;
function dismissIntro(){if(introDismissed||!intro)return;introDismissed=true;intro.classList.add('is-leaving');document.body.style.overflow='';setTimeout(()=>intro.remove(),560)}
let introSeen=false;try{introSeen=sessionStorage.getItem('aerlon-puzzle-entry-v1')==='1'}catch(_e){}
const reduceIntroMotion=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if(intro){if(introSeen||reduceIntroMotion){dismissIntro()}else{document.body.style.overflow='hidden';intro.querySelector('.intro-skip')?.addEventListener('click',dismissIntro);try{sessionStorage.setItem('aerlon-puzzle-entry-v1','1')}catch(_e){}setTimeout(dismissIntro,2800)}}

// Keep the existing payment value used by the checkout/API logic, while presenting premium selection cards.
function syncPaymentButtons(){document.querySelectorAll('[data-payment]').forEach(button=>{const active=button.dataset.payment===byId('payment').value;button.classList.toggle('active',active);button.querySelector('input').checked=active})}
document.querySelectorAll('[data-payment]').forEach(button=>button.addEventListener('change',()=>{byId('payment').value=button.dataset.payment;syncPaymentButtons();}));
syncPaymentButtons();

// Continue shopping now sits beside checkout in the cart footer.
byId('continueShoppingFooter').addEventListener('click',()=>{showBag(false);const target=document.querySelector('#products')||document.querySelector('#home')||document.querySelector('main')||document.body;requestAnimationFrame(()=>target.scrollIntoView({behavior:'smooth',block:'start'}));});

// Newsletter signups are stored by the storefront API; email campaigns require a mailing provider to be configured.
const footerNewsletterForm=byId('footerNewsletterForm');
if(footerNewsletterForm){
  footerNewsletterForm.addEventListener('submit',async event=>{
    event.preventDefault();
    const email=byId('footerNewsletterEmail').value.trim();
    const consent=byId('footerNewsletterConsent').checked;
    const status=byId('footerNewsletterStatus');
    const submit=footerNewsletterForm.querySelector('button[type="submit"]');
    status.textContent='';
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){status.textContent='Please enter a valid email address.';return;}
    if(!consent){status.textContent='Please confirm that you agree to receive updates.';return;}
    submit.disabled=true;
    try{
      const result=await api('/api/storefront/newsletter',{email,consent:true});
      status.textContent=result.message||'Your subscription has been saved.';
      footerNewsletterForm.reset();
    }catch(error){status.textContent=error.message||'We could not save your subscription. Please try again.';}
    finally{submit.disabled=false;}
  });
}
byId('siteFooter')?.addEventListener('click',event=>{const track=event.target.closest('[data-footer-action="track"]');if(track){openModal('trackModal');return;}const link=event.target.closest('.mc-footer-links a');if(link&&['#men','#women','#jackets','#sneakers'].includes(link.getAttribute('href'))){setTimeout(()=>byId('shop')?.scrollIntoView({behavior:'smooth',block:'start'}),0);}});
byId('mcFooterBackTop')?.addEventListener('click',event=>{event.preventDefault();window.scrollTo({top:0,behavior:'smooth'});});

prepareFooterAccordions();
setCollectionFromHash();
init();
;
/* International Pro header search: reuse existing catalog filter. */
(function(){const form=document.getElementById('aerlonHeaderSearch'),input=document.getElementById('aerlonHeaderSearchInput');if(!form||!input)return;form.addEventListener('submit',function(event){event.preventDefault();const catalog=document.getElementById('search');if(!catalog)return;catalog.value=input.value;catalog.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('shop')?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});});})();
;
/* Keep storefront collection search clear button and header search in sync. */
(function(){const field=document.getElementById('search'),clear=document.getElementById('clearCollectionSearch'),header=document.getElementById('aerlonHeaderSearchInput');if(!field||!clear)return;const sync=()=>{clear.hidden=!field.value;if(header&&header!==document.activeElement)header.value=field.value};field.addEventListener('input',sync);clear.addEventListener('click',()=>{field.value='';field.dispatchEvent(new Event('input',{bubbles:true}));field.focus()});sync()})();
