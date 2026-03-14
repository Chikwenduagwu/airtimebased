const { calculateUSDC, ok, fail } = require('./lib/core');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin','*'); return res.status(200).end(); }
  try {
    const amountNGN = parseFloat(req.query.amountNGN);
    if (!amountNGN || amountNGN < 50) return fail(res, 'Minimum amount is ₦50');
    const pricing = calculateUSDC(amountNGN);
    return ok(res, { amountNGN, ...pricing });
  } catch (e) {
    return fail(res, e.message);
  }
};
