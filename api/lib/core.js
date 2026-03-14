/**
 * api/lib/core.js
 * Shared backend logic for all Vercel serverless functions.
 * Contains: DB helpers, pricing engine, Reloadly service, blockchain utils, refund logic.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { ethers } = require('ethers');
const { v4: uuidv4 } = require('uuid');

// ─── Supabase ──────────────────────────────────────────────────────────────────

const getSupabase = (() => {
  let client = null;
  return () => {
    if (!client) {
      client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
    return client;
  };
})();

const ORDER_STATUS = {
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PROCESSING_RELOADLY: 'PROCESSING_RELOADLY',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
};

const VALID_TRANSITIONS = {
  AWAITING_PAYMENT: ['PAYMENT_CONFIRMED', 'FAILED'],
  PAYMENT_CONFIRMED: ['PROCESSING_RELOADLY'],
  PROCESSING_RELOADLY: ['COMPLETED', 'FAILED'],
  FAILED: ['REFUNDED'],
  COMPLETED: [],
  REFUNDED: [],
};

async function createOrder(data) {
  const db = getSupabase();
  const { data: order, error } = await db
    .from('orders')
    .insert({
      user_wallet: data.userWallet.toLowerCase(),
      phone_number: data.phoneNumber,
      operator_id: data.operatorId,
      operator_name: data.operatorName,
      amount_ngn: data.amountNGN,
      amount_usdc: data.amountUSDC,
      amount_usdc_raw: data.amountUSDCRaw,
      reloadly_idempotency_key: data.idempotencyKey,
      status: ORDER_STATUS.AWAITING_PAYMENT,
    })
    .select()
    .single();
  if (error) throw new Error(`DB create order: ${error.message}`);
  return order;
}

async function getOrder(orderId) {
  const db = getSupabase();
  const { data, error } = await db.from('orders').select('*').eq('id', orderId).single();
  if (error) { if (error.code === 'PGRST116') return null; throw new Error(error.message); }
  return data;
}

async function transitionOrder(orderId, newStatus, extra = {}) {
  const order = await getOrder(orderId);
  if (!order) throw new Error(`Order not found: ${orderId}`);
  const allowed = VALID_TRANSITIONS[order.status] || [];
  if (!allowed.includes(newStatus))
    throw new Error(`Invalid transition: ${order.status} → ${newStatus}`);
  const db = getSupabase();
  const { data, error } = await db
    .from('orders')
    .update({ status: newStatus, ...extra })
    .eq('id', orderId)
    .select()
    .single();
  if (error) throw new Error(`DB transition: ${error.message}`);
  return data;
}

async function isTxUsed(txHash) {
  const db = getSupabase();
  const { data } = await db.from('orders').select('id').eq('blockchain_tx_hash', txHash.toLowerCase()).maybeSingle();
  return !!data;
}

async function logTreasury({ type, amountUSDCRaw, amountUSDC, referenceOrderId, txHash, note }) {
  const db = getSupabase();
  await db.from('treasury_logs').insert({ type, amount_usdc: amountUSDC, amount_usdc_raw: amountUSDCRaw, reference_order_id: referenceOrderId, tx_hash: txHash, note });
}

async function upsertUser(walletAddress) {
  const db = getSupabase();
  const { data, error } = await db
    .from('users')
    .upsert({ wallet_address: walletAddress.toLowerCase() }, { onConflict: 'wallet_address' })
    .select().single();
  if (error) throw new Error(`DB upsert user: ${error.message}`);
  return data;
}

// ─── Pricing ───────────────────────────────────────────────────────────────────

function calculateUSDC(amountNGN) {
  const rate = parseFloat(process.env.USD_NGN_RATE || '1250');
  const markup = parseFloat(process.env.MARKUP_PERCENT || '2');
  const baseUSD = amountNGN / rate;
  const amountUSDC = parseFloat((baseUSD * (1 + markup / 100)).toFixed(6));
  const amountUSDCRaw = BigInt(Math.round(amountUSDC * 1_000_000)).toString();
  return { amountUSDC, amountUSDCRaw, usdNgnRate: rate, markupPercent: markup, effectiveRate: parseFloat((rate / (1 + markup / 100)).toFixed(4)) };
}

function verifyUSDCAmount(received, expected) {
  return BigInt(received) === BigInt(expected);
}

// ─── Reloadly ──────────────────────────────────────────────────────────────────

let _tokenCache = { token: null, expiresAt: 0 };

async function getReloadlyToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 60_000) return _tokenCache.token;
  const { data } = await axios.post(process.env.RELOADLY_AUTH_URL, {
    client_id: process.env.RELOADLY_CLIENT_ID,
    client_secret: process.env.RELOADLY_CLIENT_SECRET,
    grant_type: 'client_credentials',
    audience: process.env.RELOADLY_AUDIENCE,
  }, { timeout: 10_000 });
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function reloadlyHeaders() {
  const token = await getReloadlyToken();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/com.reloadly.topups-v1+json' };
}

async function getOperators(countryCode = 'NG') {
  const headers = await reloadlyHeaders();
  const { data } = await axios.get(`${process.env.RELOADLY_API_URL}/operators/countries/${countryCode}`, {
    headers, params: { includePin: false, includeBundles: false, suggestedAmounts: false }, timeout: 15_000,
  });
  return (data || []).filter(op => op.supportsLocalAmounts).map(op => ({
    id: op.id, name: op.name, logoUrl: op.logoUrls?.[0] || null,
    minAmount: op.minLocalAmount, maxAmount: op.maxLocalAmount,
  }));
}

async function validateOperator(operatorId, amountNGN) {
  const headers = await reloadlyHeaders();
  try {
    const { data: op } = await axios.get(`${process.env.RELOADLY_API_URL}/operators/${operatorId}`, { headers, timeout: 10_000 });
    if (!op.supportsLocalAmounts) return { valid: false, operator: op, reason: 'Operator does not support NGN topups' };
    if (amountNGN < (op.minLocalAmount || 0)) return { valid: false, operator: op, reason: `Minimum is ₦${op.minLocalAmount}` };
    if (amountNGN > (op.maxLocalAmount || Infinity)) return { valid: false, operator: op, reason: `Maximum is ₦${op.maxLocalAmount}` };
    return { valid: true, operator: op, reason: null };
  } catch { return { valid: false, operator: null, reason: 'Operator not found' }; }
}

async function getReloadlyBalance() {
  const headers = await reloadlyHeaders();
  const { data } = await axios.get(`${process.env.RELOADLY_API_URL}/accounts/balance`, { headers, timeout: 10_000 });
  return data;
}

async function checkTopupStatus(idempotencyKey) {
  try {
    const headers = await reloadlyHeaders();
    const { data } = await axios.get(`${process.env.RELOADLY_API_URL}/topups/reports/transactions`, {
      headers, params: { customIdentifier: idempotencyKey, size: 1 }, timeout: 10_000,
    });
    const txs = data?.content || [];
    if (txs.length > 0) return { found: true, transactionId: String(txs[0].transactionId), status: txs[0].status };
    return { found: false };
  } catch { return { found: false }; }
}

async function sendAirtime({ phoneNumber, operatorId, amountNGN, idempotencyKey, orderId }) {
  const MAX = 3;
  let lastErr;
  for (let i = 1; i <= MAX; i++) {
    try {
      const headers = await reloadlyHeaders();
      const { data } = await axios.post(`${process.env.RELOADLY_API_URL}/topups`, {
        operatorId, amount: amountNGN, useLocalAmount: true, customIdentifier: idempotencyKey,
        recipientPhone: { countryCode: 'NG', number: phoneNumber.replace(/^\+234/, '0') },
        senderPhone: { countryCode: 'NG', number: '08000000000' },
      }, { headers, timeout: 30_000 });
      return { success: true, transactionId: String(data.transactionId), status: data.status };
    } catch (err) {
      lastErr = err;
      if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
        const check = await checkTopupStatus(idempotencyKey);
        if (check.found) return { success: true, transactionId: check.transactionId, status: check.status };
      }
      if (err.response?.status >= 400 && err.response?.status < 500) {
        return { success: false, error: err.response.data?.message || 'Reloadly error' };
      }
      if (i < MAX) await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
  return { success: false, error: lastErr?.response?.data?.message || lastErr?.message || 'Max retries exceeded' };
}

// ─── Refund ────────────────────────────────────────────────────────────────────

const USDC_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

async function executeRefund(orderId) {
  const order = await getOrder(orderId);
  if (!order || order.status !== ORDER_STATUS.FAILED) return { success: false, error: 'Order not eligible for refund' };

  // Transition FIRST — acts as a mutex to prevent double-refund
  await transitionOrder(orderId, ORDER_STATUS.REFUNDED, { failure_reason: order.failure_reason });

  try {
    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL, { chainId: 8453, name: 'base' });
    const signer = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY, provider);
    const usdc = new ethers.Contract(process.env.USDC_CONTRACT_ADDRESS, USDC_TRANSFER_ABI, signer);
    const amount = BigInt(order.amount_usdc_raw);
    const gas = await usdc.transfer.estimateGas(order.user_wallet, amount);
    const tx = await usdc.transfer(order.user_wallet, amount, { gasLimit: gas * BigInt(120) / BigInt(100) });
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error('Refund TX failed on-chain');
    const txHash = tx.hash.toLowerCase();
    await transitionOrder(orderId, ORDER_STATUS.REFUNDED, { refund_tx_hash: txHash });
    await logTreasury({ type: 'debit', amountUSDCRaw: order.amount_usdc_raw, amountUSDC: order.amount_usdc, referenceOrderId: orderId, txHash, note: `Refund for order ${orderId}` });
    return { success: true, txHash };
  } catch (err) {
    // CRITICAL: marked REFUNDED but TX failed — needs manual intervention
    console.error('CRITICAL: Refund TX failed after status update', { orderId, error: err.message });
    return { success: false, error: err.message };
  }
}

// ─── Blockchain TX Verification ────────────────────────────────────────────────

async function verifyAndProcessTx({ txHash, orderId }) {
  const used = await isTxUsed(txHash);
  if (used) return { success: false, error: 'TX already used' };

  const order = await getOrder(orderId);
  if (!order || order.status !== ORDER_STATUS.AWAITING_PAYMENT) return { success: false, error: 'Order not awaiting payment' };

  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL, { chainId: 8453, name: 'base' });
  const MIN_CONF = parseInt(process.env.MIN_CONFIRMATIONS || '2');

  // Wait for confirmations (max 8 min)
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
    if (receipt?.blockNumber) {
      const current = await provider.getBlockNumber();
      if (current - receipt.blockNumber + 1 >= MIN_CONF) break;
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) return { success: false, error: 'TX failed on-chain' };

  // Decode Transfer event
  const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  let transfer = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== process.env.USDC_CONTRACT_ADDRESS.toLowerCase()) continue;
    try { transfer = iface.parseLog(log); break; } catch {}
  }
  if (!transfer) return { success: false, error: 'No USDC Transfer event found' };

  const { from, to, value } = transfer.args;
  if (to.toLowerCase() !== process.env.TREASURY_WALLET_ADDRESS.toLowerCase()) return { success: false, error: 'Not sent to treasury' };
  if (from.toLowerCase() !== order.user_wallet.toLowerCase()) return { success: false, error: 'Sender mismatch' };
  if (!verifyUSDCAmount(value.toString(), order.amount_usdc_raw)) return { success: false, error: `Amount mismatch: got ${value}, expected ${order.amount_usdc_raw}` };

  // ── Confirm payment ──
  await transitionOrder(orderId, ORDER_STATUS.PAYMENT_CONFIRMED, { blockchain_tx_hash: txHash.toLowerCase() });
  await logTreasury({ type: 'credit', amountUSDCRaw: order.amount_usdc_raw, amountUSDC: order.amount_usdc, referenceOrderId: orderId, txHash: txHash.toLowerCase(), note: `Payment confirmed for order ${orderId}` });

  // ── Deliver airtime ──
  await transitionOrder(orderId, ORDER_STATUS.PROCESSING_RELOADLY);
  const result = await sendAirtime({ phoneNumber: order.phone_number, operatorId: order.operator_id, amountNGN: parseFloat(order.amount_ngn), idempotencyKey: order.reloadly_idempotency_key, orderId });

  if (result.success) {
    await transitionOrder(orderId, ORDER_STATUS.COMPLETED, { reloadly_tx_id: result.transactionId });
    return { success: true };
  } else {
    await transitionOrder(orderId, ORDER_STATUS.FAILED, { failure_reason: result.error });
    executeRefund(orderId).catch(console.error); // async, don't await
    return { success: false, error: result.error };
  }
}

// ─── Input Validation ─────────────────────────────────────────────────────────

const Joi = require('joi');

const schemas = {
  createOrder: Joi.object({
    phoneNumber: Joi.string().pattern(/^\+?[1-9]\d{6,14}$/).required(),
    operatorId: Joi.number().integer().positive().required(),
    amountNGN: Joi.number().min(50).max(50000).required(),
    walletAddress: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),
  }),
  confirmPayment: Joi.object({
    orderId: Joi.string().uuid().required(),
    txHash: Joi.string().pattern(/^0x[a-fA-F0-9]{64}$/).required(),
  }),
};

function validate(schema, data) {
  const { error, value } = schema.validate(data, { abortEarly: false, stripUnknown: true });
  if (error) return { valid: false, errors: error.details.map(d => d.message) };
  return { valid: true, value };
}

// ─── CORS / Response Helpers ──────────────────────────────────────────────────

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function ok(res, data, status = 200) { setCORS(res); res.status(status).json({ success: true, ...data }); }
function fail(res, error, status = 400) { setCORS(res); res.status(status).json({ success: false, error }); }

module.exports = {
  getSupabase, ORDER_STATUS, createOrder, getOrder, transitionOrder, isTxUsed, logTreasury, upsertUser,
  calculateUSDC, verifyUSDCAmount,
  getOperators, validateOperator, getReloadlyBalance, sendAirtime, checkTopupStatus,
  executeRefund, verifyAndProcessTx,
  schemas, validate, ok, fail, uuidv4,
};
