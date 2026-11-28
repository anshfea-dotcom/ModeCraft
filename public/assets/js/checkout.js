// AERLON single-page checkout. Request retry keys contain no address or gift code.
let lastCheckoutAttempt;
async function checkoutAttempt(method,body){
  const bytes=new TextEncoder().encode(JSON.stringify([method,body]));
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  try{lastCheckoutAttempt||=JSON.parse(sessionStorage.getItem('aerlon_checkout_attempt'));}catch{}
  if(lastCheckoutAttempt?.digest!==digest){
    lastCheckoutAttempt={digest,id:crypto.randomUUID()};
    try{sessionStorage.setItem('aerlon_checkout_attempt',JSON.stringify(lastCheckoutAttempt));}catch{}
  }
  return lastCheckoutAttempt.id;
}
function endCheckoutAttempt(){
  lastCheckoutAttempt=null;
  try{sessionStorage.removeItem('aerlon_checkout_attempt');}catch{}
}
(() => {
  const by=id=>document.getElementById(id);
  const dialog=by('checkout'),box=dialog.querySelector('.checkout-box');
  const form=by('orderForm'),delivery=by('deliveryFields');
  const status=by('addressMessage'),locate=by('locateAddress');
  const addressList=by('checkoutSavedAddresses'),addressNote=by('checkoutAddressSaveMessage');
  const error=by('checkoutError'),save=by('checkoutSaveAddress'),addNew=by('checkoutAddAddress');
  const giftDetails=by('checkoutGiftDetails'),giftInput=by('checkoutGiftCode'),giftMessage=by('checkoutGiftMessage');
  const keys=['name','phone','pin','city','state','house','address','landmark','addressType','email'];
  let addresses=[],activeId=null,account=null,loadingAddresses=false,lookupId=0,revision=0,previousPin='',gpsRetry=false;
  function setError(text){
    error.hidden=!text;
    error.textContent=text||'';
    if(text){error.scrollIntoView({block:'nearest',behavior:'auto'});}
  }
  function locationStatus(state,text){
    status.dataset.state=state;
    status.textContent=(state==='success'?'✓ ':state==='error'?'⚠ ':state==='loading'?'… ':'')+text;
  }
  function invalidField(){
    const input=delivery.querySelector('input:invalid,select:invalid');
    if(input){
      setError('Please complete your delivery address. Check the highlighted field and try again.');
      input.focus();input.reportValidity();
      return true;
    }
    setError('');return false;
  }
  form.addEventListener('invalid',event=>{
    if(delivery.contains(event.target)){
      setError('Please enter your delivery details correctly before placing your order.');
    }
  },true);
  function addressData(){
    return {name:by('name').value.trim(),phone:by('phone').value.trim(),
      email:by('email').value.trim(),postalCode:by('pin').value.trim(),
      city:by('city').value.trim(),state:by('state').value.trim(),
      house:by('house').value.trim(),address:by('address').value.trim(),
      landmark:by('landmark').value.trim(),addressType:by('addressType').value};
  }
  function applyAddress(address){
    for(const key of keys){
      const actual=key==='pin'?'postalCode':key;
      if(address[actual]!==undefined)by(key).value=address[actual];
    }
    activeId=address.id||null;
    revision++;lookupId++;previousPin=by('pin').value;
    setError('');drawAddresses();
    addressNote.textContent='Saved address selected. You can edit any field before ordering.';
  }
  function drawAddresses(){
    addressList.replaceChildren();
    addressList.hidden=!addresses.length;
    for(const address of addresses){
      const row=document.createElement('div');
      row.className='checkout-saved-address'+(address.id===activeId?' selected':'');
      const pick=document.createElement('button');pick.type='button';pick.className='checkout-use-address';
      const name=document.createElement('strong');name.textContent=(address.addressType||'Home')+' · '+address.name;
      const line=document.createElement('small');
      line.textContent=[address.house,address.address,address.city,address.state,address.postalCode].filter(Boolean).join(', ');
      pick.append(name,line);pick.onclick=()=>applyAddress(address);
      const remove=document.createElement('button');remove.type='button';remove.className='checkout-remove-address';remove.textContent='Delete';
      remove.setAttribute('aria-label','Delete saved address '+(address.addressType||''));
      remove.onclick=async()=>{
        if(!window.confirm('Delete this saved address from your account?'))return;
        remove.disabled=true;
        try{await api('/api/customer/addresses/'+encodeURIComponent(address.id),undefined,15000,'DELETE');
          addresses=addresses.filter(item=>item.id!==address.id);
          if(activeId===address.id)activeId=null;
          drawAddresses();addressNote.textContent='Address removed from your account.';
        }catch(err){addressNote.textContent='Could not delete address: '+err.message;remove.disabled=false;}
      };
      row.append(pick,remove);addressList.append(row);
    }
  }
  async function loadAddresses(){
    if(loadingAddresses)return;
    loadingAddresses=true;addressNote.textContent='Checking saved addresses…';
    try{
      const me=await api('/api/auth/me');
      if(!dialog.classList.contains('show'))return;
      const previousAccountId=account?.id;
      account=me.authenticated?me.user:null;
      if(previousAccountId!==account?.id){addresses=[];activeId=null;}
      if(!account){
        addresses=[];activeId=null;drawAddresses();
        addressNote.textContent='Sign in to save addresses across devices. Guest checkout is available.';
        return;
      }
      const result=await api('/api/customer/addresses');
      if(!dialog.classList.contains('show'))return;
      addresses=Array.isArray(result.addresses)?result.addresses:[];drawAddresses();
      if(!by('name').value)by('name').value=account.name||'';
      if(!by('email').value)by('email').value=account.email||'';
      if(!by('phone').value)by('phone').value=account.phone||'';
      if(!activeId&&addresses.length&&!by('address').value)applyAddress(addresses[0]);
      addressNote.textContent=addresses.length?'Choose a saved address or add a new one.':'Your address will be saved to this account when you place an order.';
    }catch(err){
      addressNote.textContent='Saved addresses unavailable: '+err.message+'. You can still enter an address manually.';
    }finally{loadingAddresses=false;}
  }
  async function persistAddress(showMessage=true){
    if(!account){
      if(showMessage)addressNote.textContent='Please sign in to save an address to your customer account.';
      return false;
    }
    if(invalidField())return false;
    const data=addressData();
    const result=await api('/api/customer/addresses',{...data,...(activeId?{id:activeId}:{})});
    const updated=result.address;
    activeId=updated.id;
    addresses=[updated,...addresses.filter(x=>x.id!==updated.id)];
    drawAddresses();
    if(showMessage)addressNote.textContent='✓ Address saved to your AERLON account.';
    return true;
  }
  save.addEventListener('click',async()=>{
    save.disabled=true;addressNote.textContent='Saving address…';
    try{await persistAddress(true);}catch(err){addressNote.textContent='Could not save address: '+err.message;}
    finally{save.disabled=false;}
  });
  addNew.addEventListener('click',()=>{
    activeId=null;revision++;lookupId++;previousPin='';
    for(const key of keys)by(key).value=key==='addressType'?'Home':'';
    if(account){
      by('name').value=account.name||'';
      by('phone').value=account.phone||'';
      by('email').value=account.email||'';
    }
    drawAddresses();setError('');locationStatus('','');
    addressNote.textContent='Enter the new address below, then tap Save address.';
    by('house').focus();
  });
  // The account ID lives on the server; no address or phone is placed in localStorage.
  window.aerlonSaveCheckoutAddress=()=>account?persistAddress(false).catch(()=>false):Promise.resolve(false);
  new MutationObserver(()=>{
    if(dialog.classList.contains('show')){setError('');loadAddresses();}
    else{lookupId++;gpsRetry=false;locate.disabled=false;locate.textContent='⌖ Use my location';}
  }).observe(dialog,{attributes:true,attributeFilter:['class']});
  const syncGift=()=>{
    const gift=by('payment').value==='GIFT';
    giftDetails.hidden=!gift;
    by('checkoutGrandLabel').textContent=gift?'Gift card total':'Total on delivery';
    giftInput.required=gift;
    if(!gift){giftMessage.textContent='The gift card must cover your full order total.';}
  };
  document.querySelector('.payment-methods').addEventListener('change',()=>{syncGift();setError('');});
  syncGift();
  by('checkoutCheckGift').onclick=async()=>{
    const code=giftInput.value.trim().toUpperCase();
    if(!code){giftMessage.textContent='Enter your AERLON gift code first.';giftInput.focus();return;}
    const button=by('checkoutCheckGift');button.disabled=true;button.textContent='Checking…';
    giftMessage.textContent='Verifying gift card balance…';
    try{
      const result=await api('/api/gift-cards/check',{code});
      const amount=Number(result.balance)||0,due=Math.max(0,total()-Number(appliedCoupon?.discount||0));
      giftMessage.textContent=amount>=due&&due>0?
        '✓ Card balance '+money(amount)+' covers the total '+money(due)+'.':
        'Card balance '+money(amount)+' is insufficient for '+money(due)+'. Use Cash on Delivery or a fully funded card.';
    }catch(e){giftMessage.textContent='Could not verify gift card: '+e.message;}
    finally{button.disabled=false;button.textContent='Check balance';}
  };
  const pin=by('pin');
  delivery.addEventListener('input',()=>{revision++;setError('');});
  pin.addEventListener('input',async()=>{
    const code=pin.value,id=++lookupId;
    if(code!==previousPin)previousPin='';
    if(!/^[1-9]\d{5}$/.test(code)||previousPin===code)return;
    locationStatus('loading','Checking PIN and delivery area…');
    const old=[by('city').value,by('state').value];
    try{
      const found=await api('/api/checkout/address/pin',{pin:code},9000);
      if(id!==lookupId||pin.value!==code)return;
      previousPin=code;
      for(const [index,key] of ['city','state'].entries())if(found[key]&&by(key).value===old[index])by(key).value=found[key];
      locationStatus('success','PIN verified. Please confirm your city and state.');
    }catch(err){if(id===lookupId)locationStatus('error',err.message+' You may enter the details manually.');}
  });
  by('enterPin').addEventListener('click',()=>{
    locationStatus('','Enter your six-digit PIN code to find the area.');
    pin.focus();
  });
  locate.addEventListener('click',async()=>{
    if(!navigator.geolocation){
      locationStatus('error','Location is unavailable in this browser. Please enter your PIN.');
      pin.focus();return;
    }
    locate.disabled=true;locate.textContent='◌ Finding…';
    const current=++revision;lookupId++;
    locationStatus('loading','Requesting your location. You can also enter your address manually.');
    try{
      const position=await new Promise((resolve,reject)=>
        navigator.geolocation.getCurrentPosition(resolve,reject,{
          enableHighAccuracy:gpsRetry,timeout:gpsRetry?30000:20000,maximumAge:gpsRetry?0:120000
        })
      );
      if(current!==revision)return;
      if(position.coords.accuracy>1200)throw new Error('Your location is approximate. Retry or enter a PIN.');
      locationStatus('loading','Location received. Finding your city, state and PIN…');
      const found=await api('/api/checkout/address/location',{
        lat:position.coords.latitude,lon:position.coords.longitude
      },12000);
      if(current!==revision)return;
      for(const key of ['pin','city','state','address'])if(found[key])by(key).value=found[key];
      previousPin=found.pin||'';
      locationStatus('success','Area fetched successfully. Check your PIN and add your house and street before placing the order.');
      gpsRetry=false;locate.textContent='⌖ Update location';
    }catch(err){
      if(current!==revision)return;
      gpsRetry=true;locate.textContent='⌖ Retry location';
      const explanation={1:'Location permission was denied.',2:'Your device could not determine location.',3:'Location request timed out.'};
      locationStatus('error',(explanation[err.code]||err.message)+' Enter the address manually or retry.');
    }finally{locate.disabled=false;if(locate.textContent==='◌ Finding…')locate.textContent='⌖ Use my location';}
  });
  by('removeCoupon').onclick=()=>clearAppliedCoupon('Coupon removed.');
  by('checkoutItems').addEventListener('click',e=>{
    const button=e.target.closest('[data-fix-variant]');
    if(!button)return;
    const item=cart.find(row=>cartKey(row)===button.dataset.fixVariant);
    if(!item)return;
    const product=products.find(p=>String(p.id)===String(item.id));
    clearAppliedCoupon();
    cart=cart.filter(row=>row!==item);
    renderCart();
    showCheckout(false);
    if(product)openProduct(product.id);
  });
  window.aerlonCheckoutValidate=()=>{
    if(!cart.length){setError('Your bag is empty. Add a product before ordering.');return false;}
    const incomplete=cart.find(item=>{
      const p=products.find(x=>String(x.id)===String(item.id));
      const variants=Array.isArray(p?.inventoryVariants)?p.inventoryVariants:[];
      return !item.size || (!item.color && (variants.length||p?.colors?.length));
    });
    if(incomplete){
      setError('⚠ Please select your size'+(!incomplete.color?' and colour':'')+' for every product before placing an order. Use “Select size” in the order summary.');
      by('checkoutItems').scrollIntoView({block:'nearest'});
      return false;
    }
    if(invalidField())return false;
    if(by('payment').value==='GIFT'&&!giftInput.value.trim()){
      setError('Enter a valid gift code to pay with Gift Code.');
      giftInput.focus();return false;
    }
    setError('');return true;
  };
  form.addEventListener('reset',()=>{
    activeId=null;gpsRetry=false;previousPin='';status.textContent='';
    setTimeout(()=>{syncGift();setError('');},0);
  });
})();

(() => {
  const track = document.getElementById('recentProducts');
  const controls = document.getElementById('recentControls');
  const prev = document.getElementById('recentPrev');
  const next = document.getElementById('recentNext');
  function sync() {
    const end = track.scrollWidth - track.clientWidth;
    controls.hidden = end < 2;
    prev.disabled = track.scrollLeft <= 1;
    next.disabled = track.scrollLeft >= end - 1;
  }
  function move(direction) {
    const card = track.querySelector('.card');
    if (card) track.scrollBy({ left: direction * (card.offsetWidth + parseFloat(getComputedStyle(track).columnGap)), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  prev.onclick = () => move(-1);
  next.onclick = () => move(1);
  track.addEventListener('keydown', e => {
    if (['ArrowLeft','ArrowRight'].includes(e.key)) { e.preventDefault(); move(e.key === 'ArrowLeft' ? -1 : 1); }
  });
  track.addEventListener('scroll', sync, { passive: true });
  new ResizeObserver(sync).observe(track);
  new MutationObserver(sync).observe(track, { childList: true });
})();


function finishCheckout(result,method){
  // Kick off optional account address saving before resetting the form.
  try{window.aerlonSaveCheckoutAddress?.();}catch{}
  endCheckoutAttempt();
  showCheckout(false);
  cart=[];
  appliedCoupon=null;
  document.getElementById('orderForm').reset();
  document.getElementById('couponMessage').textContent='';
  document.getElementById('couponPanel').open=false;
  syncPaymentButtons();
  renderCart();
  showOrderSuccess(result.orderId,result.message,method);
}

document.getElementById('orderForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=document.getElementById('placeOrder');
  if(button.disabled || !window.aerlonCheckoutValidate?.())return;
  const method=document.getElementById('payment').value;
  if(!['COD','GIFT'].includes(method))return;
  button.disabled=true;button.textContent='Placing your order…';
  try{
    const body=payload();
    body.expectedTotal=Math.max(0,total()-(Number(appliedCoupon?.discount)||0));
    if(method==='GIFT')body.giftCode=document.getElementById('checkoutGiftCode').value.trim().toUpperCase();
    body.attemptId=await checkoutAttempt(method,body);
    const url=method==='GIFT'?'/api/orders/gift':'/api/orders/cod';
    const result=await api(url,body,30000);
    finishCheckout(result,method);
  }catch(error){
    const node=document.getElementById('checkoutError');
    node.textContent='⚠ '+(error.message||'Could not place the order. Please retry.');
    node.hidden=false;node.scrollIntoView({block:'nearest'});
  }finally{
    button.disabled=false;
    updateCheckoutSummary();
  }
});
function refreshCheckoutMethods(){
  // Intentionally COD and funded gift cards only; keep legacy online verification
  // routes on the server for orders that were already started.
}
