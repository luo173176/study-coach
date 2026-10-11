'use strict';
// 启动入口：node server/index.js
const { createApp } = require('./app');
const config = require('./config');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log('');
  console.log('✅ 知学管家 AI Study Coach 已启动');
  console.log(`   本地访问: http://localhost:${config.port}`);
  console.log(`   数据目录: ${config.dataDir}`);
  console.log(`   模型服务: ${config.ai.baseUrl}（模型 ${config.ai.model}）`);
  if (!config.ai.apiKey) {
    console.log('   ⚠️  尚未配置 AI_API_KEY：资料导入可以正常使用，但问答/整理/出题需要先在 .env 中配置。');
  }
  if (!config.appPassword) {
    console.log('   ℹ️  未设置访问密码（APP_PASSWORD）：任何能访问本端口的人都可以查看数据，公网/局域网部署请务必设置。');
  }
  console.log('');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`❌ 端口 ${config.port} 已被占用：请关闭占用该端口的程序，或在 .env 中修改 PORT 后重启。`);
  } else {
    console.error('❌ 服务器启动失败：', err && err.message);
  }
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[未处理的异步错误]', err);
});
