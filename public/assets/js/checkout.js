// Store only a request fingerprint and a random retry key, never a delivery address.
let lastCheckoutAttempt;
async function checkoutAttempt(method, body) {
  const bytes = new TextEncoder().encode(JSON.stringify([method, body]));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  try { lastCheckoutAttempt ||= JSON.parse(sessionStorage.getItem('aerlon_checkout_attempt')); } catch {}
  if (lastCheckoutAttempt?.digest !== digest) {
    lastCheckoutAttempt = { digest, id: crypto.randomUUID() };
    try { sessionStorage.setItem('aerlon_checkout_attempt', JSON.stringify(lastCheckoutAttempt)); } catch {}
  }
  return lastCheckoutAttempt.id;
}

function endCheckoutAttempt() {
  lastCheckoutAttempt = null;
  try { sessionStorage.removeItem('aerlon_checkout_attempt'); } catch {}
}

(() => {
  const field = id => document.getElementById(id);
  const message = field('addressMessage');
  const button = field('locateAddress');
  const form = field('orderForm');
  const review = field('addressReview');
  const delivery = field('deliveryFields');
  const box = document.querySelector('.checkout-box');
  const dialog = field('checkout');
  const steps = Array.from(dialog.querySelectorAll('.checkout-steps li'));
  const sections = [delivery, field('paymentStep'), field('reviewStep')];
  let step = 0;
  let revision = 0;
  let lookupId = 0;
  let lastPin = '';
  let retryGps = false;

  function showStep(next, focus = true) {
    step = next;
    revision++;
    lookupId++;
    button.disabled = false;
    sections.forEach((section, i) => { section.hidden = i !== step; });
    steps.forEach((item, i) => {
      if (i === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
      item.classList.toggle('complete', i < step);
    });
    dialog.dataset.step = String(step + 1);
    dialog.querySelector('.checkout-order-summary').hidden = false;
    field('checkoutBack').hidden = step === 0;
    field('checkoutNext').hidden = step === 2;
    field('placeOrder').hidden = step !== 2;
    field('checkoutNext').textContent = step === 0 ? 'Continue to payment →' : 'Review order →';
    const copy = [
      ['STEP 01 / 03','Where should it go?','Tell us where to deliver. You can review everything before placing your order.'],
      ['STEP 02 / 03','Your way to pay.','Choose your preferred method. No payment is taken until the final confirmation.'],
      ['STEP 03 / 03','One final look.','Confirm your details and total before placing the order.']
    ][step];
    field('checkoutStageCount').textContent = copy[0];
    field('checkoutStageHeading').textContent = copy[1];
    field('checkoutStageDetail').textContent = copy[2];
    if (step === 2) {
      review.textContent = ['name','house','address','landmark','city','state','pin','phone','email'].map(id => field(id).value.trim()).filter(Boolean).join(' · ');
      field('paymentReview').textContent = field('payment').selectedOptions[0].textContent;
      field('checkoutGrandLabel').textContent = field('payment').value === 'COD' ? 'Total on delivery' : 'Order total';
    }
    box.scrollTop = 0;
    if (focus) {
      const heading = sections[step].querySelector('legend,h3');
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }
  function advance() {
    if (step === 0) {
      for (const input of delivery.querySelectorAll('input,select')) if (!input.reportValidity()) return;
    }
    if (step < 2) showStep(step + 1);
  }
  field('checkoutNext').onclick = advance;
  field('editCheckoutAddress').onclick = () => showStep(0);
  field('editCheckoutPayment').onclick = () => showStep(1);
  field('checkoutBack').onclick = () => showStep(Math.max(0, step - 1));
  field('enterPin').onclick = () => {
    revision++;
    message.textContent = 'Enter six digits to fill your city and state.';
    field('pin').focus();
  };
  form.addEventListener('submit', event => {
    if (step === 2) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    advance();
  }, true);
  function resetFlow() {
    retryGps = false;
    button.textContent = '⌖ Use my location';
    message.textContent = '';
    lastPin = '';
    showStep(0, false);
  }
  form.addEventListener('reset', resetFlow);
  new MutationObserver(() => { if (!dialog.classList.contains('show')) resetFlow(); }).observe(dialog, {attributes:true, attributeFilter:['class']});
  showStep(0, false);

  delivery.addEventListener('input', () => { revision++; });
  field('pin').addEventListener('input', async () => {
    const pin = field('pin').value;
    const id = ++lookupId;
    if (pin !== lastPin) lastPin = '';
    if (!/^[1-9]\d{5}$/.test(pin) || lastPin === pin) return;
    const previous = ['city','state'].map(key => field(key).value);
    try {
      const area = await api('/api/checkout/address/pin', { pin }, 7000);
      if (id !== lookupId || field('pin').value !== pin) return;
      lastPin = pin;
      ['city','state'].forEach((key,i) => {
        if (area[key] && field(key).value === previous[i]) field(key).value = area[key];
      });
      message.textContent = 'Review the city and state for this PIN.';
    } catch (e) { if (id === lookupId) message.textContent = e.message; }
  });
  button.onclick = async () => {
    if (!navigator.geolocation) { message.textContent = 'Choose Enter PIN instead to fill your city and state.'; return; }
    button.disabled = true;
    const current = ++revision;
    lookupId++;
    message.textContent = 'Finding your location… You can enter your PIN at any time.';
    try {
      const position = await new Promise((resolve,reject) => navigator.geolocation.getCurrentPosition(resolve,reject,{
        enableHighAccuracy: retryGps, timeout: retryGps ? 35000 : 20000, maximumAge: retryGps ? 0 : 120000
      }));
      if (current !== revision) return;
      if (position.coords.accuracy > 1000) throw new Error('Location is approximate. Retry or enter your PIN.');
      const result = await api('/api/checkout/address/location', {lat:position.coords.latitude,lon:position.coords.longitude}, 11000);
      if (current !== revision) return;
      for (const key of ['pin','city','state','address']) if (result[key]) field(key).value = result[key];
      lastPin = result.city && result.state ? result.pin : '';
      message.textContent = 'Area found. Review the details and enter your building and street.';
      button.textContent = '⌖ Update location';
      retryGps = false;
    } catch (error) {
      if (current !== revision) return;
      retryGps = true;
      button.textContent = '⌖ Retry location';
      const reason = {1:'Location permission is off.',2:'Your phone could not find its location.',3:'Your phone needs more time to find its location.'};
      message.textContent = reason[error.code] ? reason[error.code] + ' Retry or enter your PIN.' : error.message;
    } finally { button.disabled = false; }
  };
  field('removeCoupon').onclick = () => clearAppliedCoupon('Coupon removed.');
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

function finishCheckout(result, method) {
  endCheckoutAttempt();
  showCheckout(false);
  cart = [];
  appliedCoupon = null;
  document.getElementById('orderForm').reset();
  document.getElementById('couponMessage').textContent = '';
  document.getElementById('couponPanel').open = false;
  syncPaymentButtons();
  renderCart();
  showOrderSuccess(result.orderId, result.message, method);
}

async function payOnline(body) {
  const config = await api('/api/config');
  if (!config.razorpayEnabled) throw new Error('Online payments are unavailable. Choose cash on delivery.');
  const Checkout = await loadOnlineCheckout();
  const order = await api('/api/payments/razorpay/order', body);
  await new Promise(resolve => {
    let verifying = false;
    const checkout = new Checkout({
      key: order.keyId, amount: order.amount, currency: order.currency, order_id: order.razorpayOrderId,
      name: 'AERLON', description: 'Fashion order', prefill: { ...order.customer, contact: order.customer.phone },
      modal: { ondismiss() { if (!verifying) { toast('Payment window closed. Your bag is saved.'); resolve(); } } },
      async handler(response) {
        verifying = true;
        try { finishCheckout(await api('/api/payments/razorpay/verify', response), 'ONLINE'); }
        catch { alert('Payment confirmation is pending. Contact customer care before paying again. Reference: ' + order.razorpayOrderId); }
        finally { resolve(); }
      }
    });
    checkout.on('payment.failed', event => toast(event.error?.description || 'Payment failed. Your bag is saved.'));
    checkout.open();
  });
}

document.getElementById('orderForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('placeOrder');
  if (button.disabled || !cart.length) return;
  button.disabled = true;
  button.textContent = 'Please wait…';
  try {
    const method = document.getElementById('payment').value;
    const body = payload();
    body.expectedTotal = Math.max(0, total() - (appliedCoupon?.discount || 0));
    body.attemptId = await checkoutAttempt(method, body);
    if (method === 'COD') finishCheckout(await api('/api/orders/cod', body), method);
    else await payOnline(body);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; updateCheckoutSummary(); }
});

let paymentAvailability;
function refreshCheckoutMethods() {
  paymentAvailability ||= api('/api/config').then(config => {
    document.querySelector('[data-payment="ONLINE"]').hidden = !config.razorpayEnabled;
  }).catch(() => { paymentAvailability = null; });
}
