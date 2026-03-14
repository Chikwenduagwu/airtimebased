'use strict';

// ─── API ───────────────────────────────────────────────────────────────────────

const api = {
  async get(path) {
    const r = await fetch(path);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  },
};

// ─── State ─────────────────────────────────────────────────────────────────────

const S = {
  page: 'landing',
  operators: [],
  order: null,
  payment: null,
  pollTimer: null,
  quoteTimer: null,
};

// ─── Router ────────────────────────────────────────────────────────────────────

function go(name) {
  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('active', p.id === 'p-' + name);
  });
  S.page = name;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ─── DOM helpers ───────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const show = (el, on = true) => el && (el.style.display = on ? '' : 'none');
const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
const setHTML = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  go('landing');
  loadOperators();
  bindAll();
}

// ─── Operators ─────────────────────────────────────────────────────────────────

async function loadOperators() {
  try {
    const res = await api.get('/api/operators?countryCode=NG');
    if (!res.success) return;
    S.operators = res.operators;
    const sel = $('op-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Select Network —</option>';
    res.operators.forEach(op => {
      const o = document.createElement('option');
      o.value = op.id;
      o.textContent = op.name;
      o.dataset.min = op.minAmount || 0;
      o.dataset.max = op.maxAmount || 99999;
      sel.appendChild(o);
    });
  } catch {}
}

// ─── Quote ─────────────────────────────────────────────────────────────────────

async function fetchQuote(ngn) {
  const valEl = $('price-val');
  const skelEl = $('price-skel');
  if (!valEl) return;

  if (!ngn || ngn < 50) {
    valEl.textContent = '—';
    valEl.classList.remove('updating');
    return;
  }

  valEl.classList.add('updating');
  if (skelEl) skelEl.style.display = 'block';
  valEl.style.display = 'none';

  try {
    const res = await api.get(`/api/quote?amountNGN=${ngn}`);
    if (res.success) {
      valEl.textContent = parseFloat(res.amountUSDC).toFixed(6);
    } else {
      valEl.textContent = '—';
    }
  } catch {
    valEl.textContent = '—';
  } finally {
    if (skelEl) skelEl.style.display = 'none';
    valEl.style.display = '';
    valEl.classList.remove('updating');
  }
}

// ─── Validation ────────────────────────────────────────────────────────────────

const re = {
  phone: /^\+?[1-9]\d{6,14}$/,
  wallet: /^0x[a-fA-F0-9]{40}$/,
  txHash: /^0x[a-fA-F0-9]{64}$/,
};

function clearErrors() {
  document.querySelectorAll('.field-err').forEach(e => e.classList.remove('on'));
  document.querySelectorAll('input.err, select.err').forEach(e => e.classList.remove('err'));
  const al = $('form-alert');
  if (al) al.classList.remove('on');
}

function fieldErr(inputId, msg) {
  const inp = $(inputId);
  const errEl = $(inputId + '-err');
  if (inp) inp.classList.add('err');
  if (errEl) { errEl.textContent = msg; errEl.classList.add('on'); }
  return false;
}

function showAlert(id, msg, type = 'error') {
  const el = $(id);
  if (!el) return;
  const ico = el.querySelector('.alert-icon');
  const txt = el.querySelector('.alert-msg');
  if (ico) ico.textContent = type === 'error' ? '⚠' : type === 'success' ? '✓' : 'ℹ';
  if (txt) txt.textContent = msg;
  el.className = `alert on ${type}`;
}

// ─── Form Submit ───────────────────────────────────────────────────────────────

async function submitOrder(e) {
  e.preventDefault();
  clearErrors();

  const phone = $('f-phone').value.trim();
  const opId = parseInt($('op-select').value);
  const ngn = parseFloat($('f-amount').value);
  const wallet = $('f-wallet').value.trim();

  let ok = true;

  if (!re.phone.test(phone)) {
    fieldErr('f-phone', 'Use international format, e.g. +2348012345678');
    ok = false;
  }
  if (!opId || isNaN(opId)) {
    fieldErr('op-select', 'Please select a network');
    ok = false;
  } else {
    const op = $('op-select').options[$('op-select').selectedIndex];
    const min = parseFloat(op.dataset.min || 0);
    const max = parseFloat(op.dataset.max || 99999);
    if (isNaN(ngn) || ngn < 50) { fieldErr('f-amount', 'Minimum is ₦50'); ok = false; }
    else if (ngn < min) { fieldErr('f-amount', `Minimum for this network is ₦${min}`); ok = false; }
    else if (ngn > max) { fieldErr('f-amount', `Maximum for this network is ₦${max}`); ok = false; }
  }
  if (!re.wallet.test(wallet)) {
    fieldErr('f-wallet', 'Enter a valid Base wallet address (0x...)');
    ok = false;
  }

  if (!ok) return;

  const btn = $('submit-btn');
  btn.disabled = true;
  btn.classList.add('loading');

  try {
    const res = await api.post('/api/orders', { phoneNumber: phone, operatorId: opId, amountNGN: ngn, walletAddress: wallet });

    if (!res.success) {
      showAlert('form-alert', res.error || 'Failed to create order. Please try again.');
      return;
    }

    S.order = res.order;
    S.payment = res.payment;
    renderWaiting();
    go('waiting');
    startPoll(res.order.id);

  } catch (err) {
    showAlert('form-alert', 'Network error. Check your connection and try again.');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

// ─── Waiting Page ───────────────────────────────────────────────────────────────

function renderWaiting() {
  const o = S.order;
  const p = S.payment;

  setText('w-amount', parseFloat(o.amountUSDC).toFixed(6));
  setText('w-orderid', 'REF: ' + o.id.slice(0, 8).toUpperCase());

  const addrEl = $('w-wallet-addr');
  if (addrEl) { addrEl.textContent = p.treasuryWallet; addrEl.dataset.full = p.treasuryWallet; }

  const amtCopy = $('w-amount-copy');
  if (amtCopy) amtCopy.dataset.val = o.amountUSDC;

  setStep(1);
  setText('tracker-status', 'Monitoring Base network for your transaction...');
}

function setStep(n) {
  for (let i = 1; i <= 4; i++) {
    const el = $('step-' + i);
    if (!el) continue;
    el.classList.remove('active', 'done');
    if (i < n) el.classList.add('done');
    else if (i === n) el.classList.add('active');
  }
}

// ─── Poll ──────────────────────────────────────────────────────────────────────

function startPoll(orderId) {
  stopPoll();
  let count = 0;
  S.pollTimer = setInterval(async () => {
    if (++count > 120) { stopPoll(); setText('tracker-status', 'Auto-check expired. Your TX may still be processing.'); return; }
    try {
      const res = await api.get(`/api/orders?id=${orderId}`);
      if (res.success) onStatus(res.order);
    } catch {}
  }, 5000);
}

function stopPoll() {
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
}

function onStatus(order) {
  S.order = order;
  const msgs = {
    AWAITING_PAYMENT: 'Monitoring Base network for your transaction...',
    PAYMENT_CONFIRMED: 'Payment confirmed on-chain! Preparing airtime...',
    PROCESSING_RELOADLY: 'Sending airtime to your phone...',
    COMPLETED: 'Airtime delivered successfully!',
    FAILED: 'Something went wrong.',
    REFUNDED: 'Order failed — refund has been issued.',
  };
  const steps = { AWAITING_PAYMENT: 1, PAYMENT_CONFIRMED: 2, PROCESSING_RELOADLY: 3, COMPLETED: 4, FAILED: 4, REFUNDED: 4 };
  setStep(steps[order.status] || 1);
  setText('tracker-status', msgs[order.status] || '');

  if (order.status === 'COMPLETED') { stopPoll(); setTimeout(() => renderSuccess(order), 600); }
  if (order.status === 'FAILED' || order.status === 'REFUNDED') { stopPoll(); setTimeout(() => renderFail(order), 600); }
}

// ─── TX Fallback ────────────────────────────────────────────────────────────────

async function submitTx() {
  const hash = $('tx-input').value.trim();
  if (!re.txHash.test(hash)) { showAlert('tx-alert', 'Enter a valid 0x transaction hash'); return; }
  const orderId = S.order?.id;
  if (!orderId) return;

  const btn = $('tx-btn');
  btn.disabled = true;

  try {
    const res = await api.post('/api/confirm', { orderId, txHash: hash });
    if (res.success) {
      showAlert('tx-alert', 'Transaction submitted — processing...', 'success');
    } else {
      showAlert('tx-alert', res.error || 'Verification failed');
    }
  } catch { showAlert('tx-alert', 'Network error submitting transaction'); }
  finally { btn.disabled = false; }
}

// ─── Success / Fail ─────────────────────────────────────────────────────────────

function renderSuccess(order) {
  setText('s-phone', order.phoneNumber);
  setText('s-amount', '₦' + parseFloat(order.amountNGN).toLocaleString());
  setText('s-network', order.operatorName || '—');
  setText('s-usdc', parseFloat(order.amountUSDC).toFixed(6) + ' USDC');

  const txEl = $('s-tx');
  if (txEl && order.blockchainTxHash) {
    const short = order.blockchainTxHash.slice(0, 10) + '...' + order.blockchainTxHash.slice(-8);
    txEl.innerHTML = `<a href="https://basescan.org/tx/${order.blockchainTxHash}" target="_blank" rel="noopener">${short} ↗</a>`;
  }

  setText('s-reloadly', order.reloadlyTxId || '—');
  go('success');
}

function renderFail(order) {
  setText('f-reason', order.failureReason || 'An unexpected error occurred during processing.');

  const refEl = $('f-refund');
  if (refEl) {
    if (order.refundTxHash) {
      const short = order.refundTxHash.slice(0, 10) + '...' + order.refundTxHash.slice(-8);
      refEl.innerHTML = `Refund sent: <a href="https://basescan.org/tx/${order.refundTxHash}" target="_blank" rel="noopener">${short} ↗</a>`;
    } else {
      refEl.textContent = 'Refund is being processed — allow up to 5 minutes.';
    }
  }

  go('failure');
}

// ─── Copy ──────────────────────────────────────────────────────────────────────

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('copied');
    btn.textContent = '✓';
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '⧉'; }, 2000);
  }).catch(() => {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    document.body.removeChild(t);
  });
}

// ─── Reset ─────────────────────────────────────────────────────────────────────

function resetForm() {
  stopPoll();
  S.order = null;
  S.payment = null;
  const form = $('purchase-form');
  if (form) form.reset();
  clearErrors();
  const pv = $('price-val');
  if (pv) pv.textContent = '—';
}

// ─── Bind Events ───────────────────────────────────────────────────────────────

function bindAll() {
  // Nav logo → landing
  document.querySelectorAll('[data-go="landing"]').forEach(el => el.addEventListener('click', () => go('landing')));

  // CTA buttons → purchase
  document.querySelectorAll('[data-go="purchase"]').forEach(el => el.addEventListener('click', () => go('purchase')));

  // Back to purchase from waiting
  $('back-to-purchase')?.addEventListener('click', () => { stopPoll(); go('purchase'); });

  // New order buttons
  document.querySelectorAll('[data-new-order]').forEach(el => el.addEventListener('click', () => { resetForm(); go('purchase'); }));

  // Form submit
  $('purchase-form')?.addEventListener('submit', submitOrder);

  // Live quote — debounced
  $('f-amount')?.addEventListener('input', () => {
    clearTimeout(S.quoteTimer);
    S.quoteTimer = setTimeout(() => fetchQuote(parseFloat($('f-amount').value)), 380);
  });

  $('op-select')?.addEventListener('change', () => {
    const v = $('f-amount')?.value;
    if (v) fetchQuote(parseFloat(v));
  });

  // TX hash submission
  $('tx-btn')?.addEventListener('click', submitTx);

  // Copy wallet address
  $('copy-wallet')?.addEventListener('click', function () {
    const addr = $('w-wallet-addr')?.dataset.full || $('w-wallet-addr')?.textContent;
    if (addr) copyText(addr, this);
  });

  // Copy amount
  $('copy-amount')?.addEventListener('click', function () {
    const val = this.closest('.pay-amount-row')?.querySelector('.pay-amount-val')?.textContent;
    if (val) copyText(val, this);
  });

  // Keyboard: Enter on TX input
  $('tx-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitTx(); });
}

// ─── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
