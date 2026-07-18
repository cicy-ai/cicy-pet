#!/usr/bin/env node
// 轻量文件服务:只把渲染器(pet.html/notebook.html/remote.html + 模型 + /tts /memories
// /control 等接口)伺服出去,不开任何 Electron 宠物窗口。渲染发生在访问端(手机浏览器/
// WebView),这台机器只发文件+转发,几乎不占资源——手机看宠物、又不拖卡本机。
const path = require('path');
const fs = require('fs');
const { createServer } = require('./src/main/renderer-server');

const basePath = __dirname;
const cacheDir = path.join(basePath, '.tts-cache');
try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}

// 读 config.json 拿 doubao/zhipu key(和 Electron 主进程同源)
const getConfig = async () => {
  try { return JSON.parse(fs.readFileSync(path.join(basePath, 'config.json'), 'utf8')); }
  catch { return {}; }
};

createServer({
  appDir: basePath,
  cacheDir,
  assetDir: null,        // 模型直接在 renderer/models,无需 userData 覆盖
  port: 13004,
  log: (...a) => console.log('[headless]', ...a),
  getConfig,
}).then(() => {
  console.log('[headless] 渲染器文件服务已启动 :13004 —— 手机可经 pet.cicy-ai.com 访问');
}).catch((e) => {
  console.error('[headless] 启动失败:', e.message);
  process.exit(1);
});
