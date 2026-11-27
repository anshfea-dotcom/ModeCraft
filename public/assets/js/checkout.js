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
  const action = document.querySelector('#checkout .checkout-action');
  const wide = matchMedia('(min-width: 781px)');
  function positionAction() {
    const parent = document.querySelector(wide.matches ? '.checkout-order-summary' : '.checkout-box');
    parent.append(action);
  }
  wide.addEventListener('change', positionAction);
  positionAction();
  let revision = 0;
  let confirmed = false;
  let lastPin = '';
  function invalidate() {
    revision++;
    confirmed = false;
    review.textContent = '';
  }
  delivery.addEventListener('input', invalidate);
  form.addEventListener('reset', () => { invalidate(); lastPin = ''; message.textContent = ''; button.disabled = false; });
  field('saveAddress').onclick = () => {
    for (const input of delivery.querySelectorAll('input,select')) if (!input.reportValidity()) return;
    review.textContent = ['name', 'house', 'address', 'landmark', 'city', 'state', 'pin', 'phone'].map(id => field(id).value.trim()).filter(Boolean).join(' · ');
    confirmed = true;
    review.focus();
  };
  form.addEventListener('submit', e => {
    if (confirmed) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    message.textContent = 'Review your delivery details and select Save & Continue.';
    field('saveAddress').focus();
  }, true);

  field('pin').addEventListener('blur', async () => {
    const pin = field('pin').value;
    if (!/^[1-9]\d{5}$/.test(pin) || pin === lastPin) return;
    const current = revision;
    try {
      const area = await api('/api/checkout/address/pin', { pin }, 7000);
      if (current !== revision) return;
      lastPin = pin;
      for (const id of ['city','state']) if (area[id]) field(id).value = area[id];
      confirmed = false;
      message.textContent = 'Review the city and state for this PIN.';
    } catch (e) { if (current === revision) message.textContent = e.message; }
  });
  button.onclick = async () => {
    if (!navigator.geolocation) { message.textContent = 'Location is unavailable in this browser. Enter your address manually.'; return; }
    button.disabled = true;
    message.textContent = 'Finding your delivery area…';
    let detected = false;
    const current = revision;
    try {
      const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000, maximumAge: 60000 }));
      if (current !== revision) return;
      if (position.coords.accuracy > 1000) throw new Error('Location is too approximate. Enter your address manually.');
      const result = await api('/api/checkout/address/location', { lat: position.coords.latitude, lon: position.coords.longitude }, 11000);
      if (current !== revision) return;
      for (const id of ['pin','city','state','address']) if (result[id]) field(id).value = result[id];
      lastPin = result.city && result.state ? result.pin : '';
      invalidate();
      detected = true;
      message.textContent = 'Review the detected details and complete any missing fields.';
      return;
    } catch (e) {
      const errors = { 1: 'Location permission was declined.', 2: 'GPS is unavailable.', 3: 'Location request timed out.' };
      if (current === revision) message.textContent = errors[e.code] ? errors[e.code] + ' Enter your address manually.' : e.message;
    } finally { button.disabled = detected; }
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
