'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────────

const BASE_CHAIN_ID = '0x2105'; // 8453 decimal — Base Mainnet
const BASE_CHAIN_CONFIG = {
  chainId: BASE_CHAIN_ID,
  chainName: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://mainnet.base.org'],
  blockExplorerUrls: ['https://basescan.org'],
};

// ─── API ───────────────────────────────────────────────────────────────────────

const api = {
  async get(path) {
    const r = await fetch(path);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  },
};

// ─── App State ─────────────────────────────────────────────────────────────────

const S = {
  page: 'landing',
  wallet: null,       // connected wallet address (lowercase)
  chainId: null,      // current chain ID as hex string
  operators: [],
  order: null,
  payment: null,
  pollTimer: null,
  quoteTimer: null,
};

// ─── DOM helpers ───────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };

function hide(...ids) { ids.forEach(id => $(id)?.classList.add('hidden')); }
function show(...ids) { ids.forEach(id => $(id)?.classList.remove('hidden')); }

// ─── Router ────────────────────────────────────────────────────────────────────

function go(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'p-' + name));
  S.page = name;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

function hasProvider() {
  return typeof window.ethereum !== 'undefined';
}

/**
 * Main connect flow.
 * - No MetaMask → show install modal
 * - Has MetaMask → request accounts → check chain → update UI
 */
async function connectWallet() {
  if (!hasProvider()) {
    show('metamask-modal');
    return;
  }

  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts.length) return;

    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    S.wallet = accounts[0].toLowerCase();
    S.chainId = chainId;

    if (chainId !== BASE_CHAIN_ID) {
      // Wrong network — show warning, prompt switch, still save address
      hide('wallet-connected');
      show('btn-wrong-net');
      await switchToBase();
      return;
    }

    onWalletConnected(S.wallet);
  } catch (err) {
    if (err.code === 4001) return; // User rejected popup — silent
    console.error('Connect error:', err.message);
  }
}

/**
 * Prompts switch to Base. If not added, adds it first.
 */
async function switchToBase() {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BASE_CHAIN_ID }],
    });
    // chainChanged event fires → onChainChanged → onWalletConnected
  } catch (err) {
    if (err.code === 4902) {
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [BASE_CHAIN_CONFIG],
        });
      } catch (e) {
        console.error('Failed to add Base:', e.message);
      }
    }
  }
}

/**
 * Updates ALL wallet-aware UI across every page.
 * Called when connection is confirmed on Base network.
 */
function onWalletConnected(address) {
  S.wallet = address.toLowerCase();

  // ── Nav ──
  hide('btn-connect', 'btn-wrong-net');
  show('wallet-connected');
  setText('nav-wallet-addr', truncateAddr(address));

  // ── Purchase form: hide "not connected" box, show green wallet display ──
  hide('wallet-not-connected');
  show('wallet-display');
  setText('form-wallet-addr', address);

  // ── Landing hero CTA: swap label + hide wallet icon ──
  setText('hero-cta-label', 'Buy Airtime Now');
  const heroIcon = $('hero-wallet-icon');
  if (heroIcon) heroIcon.style.display = 'none';
  setText('how-cta-label', 'Buy Airtime Now');

  // ── Re-enable submit button ──
  const btn = $('submit-btn');
  if (btn) btn.disabled = false;
}

/**
 * Handles chain switch events from MetaMask.
 */
function onChainChanged(chainId) {
  S.chainId = chainId;

  if (chainId !== BASE_CHAIN_ID) {
    // Wrong network
    hide('wallet-connected');
    show('btn-wrong-net');
    hide('wallet-display');
    show('wallet-not-connected');
    const btn = $('submit-btn');
    if (btn) btn.disabled = true;
  } else if (S.wallet) {
    // Back on Base — restore
    hide('btn-wrong-net');
    onWalletConnected(S.wallet);
  }
}

/**
 * Handles account switch events from MetaMask.
 */
function onAccountsChanged(accounts) {
  if (!accounts || !accounts.length) {
    disconnectWallet();
  } else {
    S.wallet = accounts[0].toLowerCase();
    onWalletConnected(S.wallet);
  }
}

/**
 * Full disconnect — clears state and resets UI everywhere.
 */
function disconnectWallet() {
  S.wallet = null;
  S.chainId = null;

  // Nav
  show('btn-connect');
  hide('wallet-connected', 'btn-wrong-net');

  // Purchase form
  show('wallet-not-connected');
  hide('wallet-display');

  // Landing hero CTA — restore "Connect Wallet"
  setText('hero-cta-label', 'Connect Wallet');
  const heroIcon = $('hero-wallet-icon');
  if (heroIcon) heroIcon.style.display = '';
  setText('how-cta-label', 'Connect Wallet to Start');

  // Disable submit
  const btn = $('submit-btn');
  if (btn) btn.disabled = true;
}

/**
 * Silent check on page load — auto-reconnects if user already authorized.
 * Uses eth_accounts (no popup, only returns already-permitted accounts).
 */
async function checkExistingConnection() {
  if (!hasProvider()) return;
  try {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (accounts && accounts.length) {
      const chainId = await window.ethereum.request({ method: 'eth_chainId' });
      S.wallet = accounts[0].toLowerCase();
      S.chainId = chainId;
      if (chainId !== BASE_CHAIN_ID) {
        hide('wallet-connected');
        show('btn-wrong-net');
      } else {
        onWalletConnected(S.wallet);
      }
    }
  } catch {}
}

/**
 * Register MetaMask live event listeners.
 */
function bindWalletEvents() {
  if (!hasProvider()) return;
  window.ethereum.on('accountsChanged', onAccountsChanged);
  window.ethereum.on('chainChanged', onChainChanged);
}

function truncateAddr(addr) {
  return addr ? addr.slice(0, 6) + '...' + addr.slice(-4) : '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPERATORS & QUOTE
// ═══════════════════════════════════════════════════════════════════════════════

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

async function fetchQuote(ngn) {
  const valEl = $('price-val');
  const skelEl = $('price-skel');
  if (!valEl) return;

  if (!ngn || ngn < 50) { valEl.textContent = '—'; valEl.classList.remove('updating'); return; }

  valEl.classList.add('updating');
  if (skelEl) skelEl.style.display = 'block';
  valEl.style.display = 'none';

  try {
    const res = await api.get(`/api/quote?amountNGN=${ngn}`);
    valEl.textContent = res.success ? parseFloat(res.amountUSDC).toFixed(6) : '—';
  } catch { valEl.textContent = '—'; }
  finally {
    if (skelEl) skelEl.style.display = 'none';
    valEl.style.display = '';
    valEl.classList.remove('updating');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORM & ORDER
// ═══════════════════════════════════════════════════════════════════════════════

const re = {
  phone: /^\+?[1-9]\d{6,14}$/,
  txHash: /^0x[a-fA-F0-9]{64}$/,
};

function clearErrors() {
  document.querySelectorAll('.field-err').forEach(e => e.classList.remove('on'));
  document.querySelectorAll('input.err, select.err').forEach(e => e.classList.remove('err'));
  $('form-alert')?.classList.remove('on');
}

function fieldErr(inputId, msg) {
  $(inputId)?.classList.add('err');
  const errEl = $(inputId + '-err');
  if (errEl) { errEl.textContent = msg; errEl.classList.add('on'); }
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

async function submitOrder(e) {
  e.preventDefault();
  clearErrors();

  // ── Wallet guards (checked before any field validation) ──
  if (!S.wallet) {
    showAlert('form-alert', 'Connect your wallet first — click "Connect Wallet" in the nav.');
    return;
  }
  if (S.chainId !== BASE_CHAIN_ID) {
    showAlert('form-alert', 'Switch to Base Network in MetaMask, then try again.');
    await switchToBase();
    return;
  }

  const phone = $('f-phone').value.trim();
  const opId  = parseInt($('op-select').value);
  const ngn   = parseFloat($('f-amount').value);
  // Wallet address is ALWAYS the connected wallet — never manually entered
  const walletAddress = S.wallet;

  let valid = true;

  if (!re.phone.test(phone)) {
    fieldErr('f-phone', 'Use international format, e.g. +2348012345678');
    valid = false;
  }
  if (!opId || isNaN(opId)) {
    fieldErr('op-select', 'Please select a network');
    valid = false;
  } else {
    const opEl = $('op-select').options[$('op-select').selectedIndex];
    const min = parseFloat(opEl.dataset.min || 0);
    const max = parseFloat(opEl.dataset.max || 99999);
    if (isNaN(ngn) || ngn < 50)  { fieldErr('f-amount', 'Minimum is ₦50'); valid = false; }
    else if (ngn < min)           { fieldErr('f-amount', `Minimum for this network is ₦${min}`); valid = false; }
    else if (ngn > max)           { fieldErr('f-amount', `Maximum for this network is ₦${max}`); valid = false; }
  }

  if (!valid) return;

  const btn = $('submit-btn');
  btn.disabled = true;
  btn.classList.add('loading');

  try {
    const res = await api.post('/api/orders', {
      phoneNumber: phone, operatorId: opId, amountNGN: ngn, walletAddress,
    });

    if (!res.success) {
      showAlert('form-alert', res.error || 'Failed to create order. Please try again.');
      return;
    }

    S.order = res.order;
    S.payment = res.payment;
    renderWaiting();
    go('waiting');
    startPoll(res.order.id);
  } catch {
    showAlert('form-alert', 'Network error. Check your connection and try again.');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WAITING PAGE
// ═══════════════════════════════════════════════════════════════════════════════

function renderWaiting() {
  const o = S.order;
  const p = S.payment;

  setText('w-amount', parseFloat(o.amountUSDC).toFixed(6));
  setText('w-orderid', 'REF: ' + o.id.slice(0, 8).toUpperCase());

  const addrEl = $('w-wallet-addr');
  if (addrEl) { addrEl.textContent = p.treasuryWallet; addrEl.dataset.full = p.treasuryWallet; }

  // Show sender wallet strip
  const strip = $('waiting-wallet-strip');
  if (strip && S.wallet) {
    strip.classList.remove('hidden');
    setText('waiting-wallet-addr', truncateAddr(S.wallet));
  }

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

function startPoll(orderId) {
  stopPoll();
  let count = 0;
  S.pollTimer = setInterval(async () => {
    if (++count > 120) { stopPoll(); setText('tracker-status', 'Auto-check timed out. Your TX may still be processing.'); return; }
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
  const steps = { AWAITING_PAYMENT:1, PAYMENT_CONFIRMED:2, PROCESSING_RELOADLY:3, COMPLETED:4, FAILED:4, REFUNDED:4 };
  setStep(steps[order.status] || 1);
  setText('tracker-status', msgs[order.status] || '');
  if (order.status === 'COMPLETED') { stopPoll(); setTimeout(() => renderSuccess(order), 600); }
  if (order.status === 'FAILED' || order.status === 'REFUNDED') { stopPoll(); setTimeout(() => renderFail(order), 600); }
}

async function submitTx() {
  const hash = $('tx-input').value.trim();
  if (!re.txHash.test(hash)) { showAlert('tx-alert', 'Enter a valid 0x transaction hash'); return; }
  const orderId = S.order?.id;
  if (!orderId) return;
  const btn = $('tx-btn');
  btn.disabled = true;
  try {
    const res = await api.post('/api/confirm', { orderId, txHash: hash });
    showAlert('tx-alert', res.success ? 'Transaction submitted — processing...' : (res.error || 'Verification failed'), res.success ? 'success' : 'error');
  } catch { showAlert('tx-alert', 'Network error submitting transaction'); }
  finally { btn.disabled = false; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUCCESS / FAILURE
// ═══════════════════════════════════════════════════════════════════════════════

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

  // Show wallet on success page
  const walletRow = $('s-wallet-row');
  if (walletRow && S.wallet) { walletRow.style.display = ''; setText('s-wallet', truncateAddr(S.wallet)); }

  setText('s-reloadly', order.reloadlyTxId || '—');
  go('success');
}

function renderFail(order) {
  setText('f-reason', order.failureReason || 'An unexpected error occurred.');
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

// ═══════════════════════════════════════════════════════════════════════════════
// COPY
// ═══════════════════════════════════════════════════════════════════════════════

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('copied'); btn.textContent = '✓';
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '⧉'; }, 2000);
  }).catch(() => {
    const t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select();
    document.execCommand('copy'); document.body.removeChild(t);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESET & BIND
// ═══════════════════════════════════════════════════════════════════════════════

function resetForm() {
  stopPoll(); S.order = null; S.payment = null;
  $('purchase-form')?.reset(); clearErrors();
  const pv = $('price-val'); if (pv) pv.textContent = '—';
}

function bindAll() {
  // Logo → landing
  document.querySelectorAll('[data-go="landing"]').forEach(el => el.addEventListener('click', () => go('landing')));

  // Hero CTA: connect wallet if needed, else go to purchase
  $('hero-cta-btn')?.addEventListener('click', () => S.wallet ? go('purchase') : connectWallet());
  $('how-cta-btn')?.addEventListener('click', () => S.wallet ? go('purchase') : connectWallet());

  // Nav wallet buttons
  $('btn-connect')?.addEventListener('click', connectWallet);
  $('btn-wrong-net')?.addEventListener('click', switchToBase);
  $('btn-disconnect')?.addEventListener('click', disconnectWallet);

  // Inline connect on form (when not connected)
  $('form-connect-btn')?.addEventListener('click', connectWallet);

  // Back from waiting
  $('back-to-purchase')?.addEventListener('click', () => { stopPoll(); go('purchase'); });

  // New order
  document.querySelectorAll('[data-new-order]').forEach(el =>
    el.addEventListener('click', () => { resetForm(); go('purchase'); })
  );

  // Form
  $('purchase-form')?.addEventListener('submit', submitOrder);

  // Live quote
  $('f-amount')?.addEventListener('input', () => {
    clearTimeout(S.quoteTimer);
    S.quoteTimer = setTimeout(() => fetchQuote(parseFloat($('f-amount').value)), 380);
  });
  $('op-select')?.addEventListener('change', () => {
    const v = $('f-amount')?.value; if (v) fetchQuote(parseFloat(v));
  });

  // TX fallback
  $('tx-btn')?.addEventListener('click', submitTx);
  $('tx-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitTx(); });

  // Copy
  $('copy-wallet')?.addEventListener('click', function () {
    const addr = $('w-wallet-addr')?.dataset.full || $('w-wallet-addr')?.textContent;
    if (addr) copyText(addr, this);
  });
  $('copy-amount')?.addEventListener('click', function () {
    const val = $('w-amount')?.textContent;
    if (val) copyText(val, this);
  });

  // Modal
  $('modal-close')?.addEventListener('click', () => hide('metamask-modal'));
  $('metamask-modal')?.addEventListener('click', e => { if (e.target === $('metamask-modal')) hide('metamask-modal'); });
}

// ─── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  go('landing');
  bindAll();
  bindWalletEvents();           // MetaMask live event listeners
  await checkExistingConnection(); // Auto-reconnect silently on load
  loadOperators();              // Background fetch

  // Submit starts disabled until wallet is connected
  const btn = $('submit-btn');
  if (btn && !S.wallet) btn.disabled = true;
}

document.addEventListener('DOMContentLoaded', init);
