'use strict';
// 极简内存限流：防止误操作刷爆模型调用
function rateLimit(maxPerMin) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter((t) => now - t < 60000);
    arr.push(now);
    buckets.set(key, arr);
    if (buckets.size > 5000) buckets.clear(); // 防止 Map 无限增长
    if (arr.length > maxPerMin) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试。' });
    }
    next();
  };
}

module.exports = { rateLimit };
