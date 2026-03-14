/**
 * api/confirm.js
 * POST /api/confirm
 * Frontend submits TX hash after sending USDC.
 * Verifies on-chain, waits for confirmations, delivers airtime.
 * This runs as a long Vercel function (maxDuration: 60s).
 */

const { verifyAndProcessTx, schemas, validate, ok, fail } = require('./lib/core');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return fail(res, 'Method not allowed', 405);

  const { valid, value, errors } = validate(schemas.confirmPayment, req.body);
  if (!valid) return fail(res, errors.join('; '));

  try {
    const result = await verifyAndProcessTx({ txHash: value.txHash, orderId: value.orderId });
    if (!result.success) return fail(res, result.error || 'Transaction verification failed');
    return ok(res, { message: 'Transaction verified and airtime dispatched' });
  } catch (e) {
    console.error('Confirm error:', e.message);
    return fail(res, 'Verification failed: ' + e.message, 500);
  }
};
