const { getOperators, ok, fail, setCORS } = require('./lib/core');

// Simple in-process cache (warm between invocations in same instance)
let _cache = null, _cacheAt = 0;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { require('./lib/core').setCORS?.(res); return res.status(200).end(); }
  try {
    const now = Date.now();
    if (!_cache || now - _cacheAt > 20 * 60 * 1000) {
      _cache = await getOperators(req.query.countryCode || 'NG');
      _cacheAt = now;
    }
    return ok(res, { operators: _cache });
  } catch (e) {
    return fail(res, e.message, 500);
  }
};
