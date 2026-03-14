/**
 * api/orders.js
 * POST /api/orders  — create new order
 * GET  /api/orders?id=xxx — get order status
 */

const { createOrder, getOrder, validateOperator, getReloadlyBalance, upsertUser, calculateUSDC, schemas, validate, ok, fail, uuidv4, setCORS } = require('./lib/core');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET /api/orders?id=xxx ──
  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return fail(res, 'Order ID required');
    const order = await getOrder(id).catch(e => { throw e; });
    if (!order) return fail(res, 'Order not found', 404);
    return ok(res, {
      order: {
        id: order.id, status: order.status,
        phoneNumber: order.phone_number, operatorName: order.operator_name,
        amountNGN: order.amount_ngn, amountUSDC: order.amount_usdc, amountUSDCRaw: order.amount_usdc_raw,
        blockchainTxHash: order.blockchain_tx_hash, reloadlyTxId: order.reloadly_tx_id,
        failureReason: order.failure_reason, refundTxHash: order.refund_tx_hash,
        createdAt: order.created_at, updatedAt: order.updated_at,
      },
    });
  }

  // ── POST /api/orders ──
  if (req.method === 'POST') {
    const { valid, value, errors } = validate(schemas.createOrder, req.body);
    if (!valid) return fail(res, errors.join('; '));

    const { phoneNumber, operatorId, amountNGN, walletAddress } = value;

    try {
      // 1. Validate operator + amount
      const { valid: opValid, operator, reason } = await validateOperator(operatorId, amountNGN);
      if (!opValid) return fail(res, reason || 'Operator validation failed');

      // 2. Check Reloadly balance
      const bal = await getReloadlyBalance();
      const requiredUSD = amountNGN / parseFloat(process.env.USD_NGN_RATE || '1250');
      if (bal.balance < requiredUSD * 1.1) return fail(res, 'Service temporarily unavailable', 503);

      // 3. Price
      const pricing = calculateUSDC(amountNGN);

      // 4. Upsert user
      await upsertUser(walletAddress);

      // 5. Create order
      const order = await createOrder({
        userWallet: walletAddress, phoneNumber, operatorId,
        operatorName: operator.name, amountNGN, amountUSDC: pricing.amountUSDC,
        amountUSDCRaw: pricing.amountUSDCRaw, idempotencyKey: uuidv4(),
      });

      return ok(res, {
        order: { id: order.id, status: order.status, amountUSDC: order.amount_usdc, amountUSDCRaw: order.amount_usdc_raw, phoneNumber: order.phone_number, operatorName: order.operator_name, amountNGN: order.amount_ngn, createdAt: order.created_at },
        payment: { treasuryWallet: process.env.TREASURY_WALLET_ADDRESS, usdcContractAddress: process.env.USDC_CONTRACT_ADDRESS, network: 'Base', chainId: 8453 },
        pricing,
      }, 201);
    } catch (e) {
      console.error('Create order error:', e.message);
      return fail(res, 'Internal error creating order', 500);
    }
  }

  return fail(res, 'Method not allowed', 405);
};
