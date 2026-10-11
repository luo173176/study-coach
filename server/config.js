'use strict';
// 配置加载：环境变量优先，其次项目根目录的 .env 文件
const fs = require('fs');
const path = require('path');
const { clampInt } = require('./util');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') {
      process.env[m[1]] = v;
    }
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const uploadsDir = path.join(dataDir, 'uploads');
const ocrCacheDir = path.join(dataDir, 'ocr-cache');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(ocrCacheDir, { recursive: true });

module.exports = {
  version: '0.1.0',
  port: clampInt(process.env.PORT, 1, 65535, 3000),
  dataDir,
  uploadsDir,
  dbPath: path.join(dataDir, 'study-coach.sqlite'),
  appPassword: process.env.APP_PASSWORD || '',
  upload: {
    maxMb: clampInt(process.env.UPLOAD_MAX_MB, 1, 200, 20),
    allowedExt: ['.pdf', '.txt', '.md', '.markdown'],
  },
  ai: {
    baseUrl: (process.env.AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, ''),
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'glm-4-flash',
    timeoutMs: clampInt(process.env.AI_TIMEOUT_MS, 3000, 600000, 60000),
    maxRetries: clampInt(process.env.AI_MAX_RETRIES, 0, 5, 1),
    maxTokens: clampInt(process.env.AI_MAX_TOKENS, 256, 32000, 2048),
    cacheHours: clampInt(process.env.AI_CACHE_HOURS, 0, 8760, 168),
  },
  rag: {
    topK: clampInt(process.env.RAG_TOP_K, 1, 20, 6),
    chunkChars: 700,
    chunkOverlap: 100,
    maxCharsPerMaterial: 2000000,
    maxContextChunks: 24,
  },
  // 扫描版 PDF 的 OCR 识别（tesseract.js，语言包首次联网下载后缓存到 ocrCacheDir）
  ocr: {
    enabled: process.env.OCR_ENABLED !== '0',
    lang: process.env.OCR_LANG || 'chi_sim+eng',
    maxPages: clampInt(process.env.OCR_MAX_PAGES, 1, 50, 10),
    scale: Math.min(4, Math.max(1, parseFloat(process.env.OCR_SCALE) || 2)),
    langPath: process.env.OCR_LANG_PATH || '',
    cachePath: ocrCacheDir,
  },
};
