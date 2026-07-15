/**
 * model-fetcher.js — 首次运行时把 Live2D 模型包下载到 userData。
 *
 * 为什么这样做：Live2D 授权 §4.1.1 禁止再分发模型文件，所以模型不进 git 仓库、
 * 也不打进公开安装包。安装包首次启动时从 OSS 拉一个模型包解压到 userData/assets，
 * 之后 renderer-server 就从那儿伺服 /models.json 和 /models/*。
 *
 * dev（源码树里自带 renderer/models）不触发下载。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.rmSync(dest, { force: true });
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        file.close(); fs.rmSync(dest, { force: true });
        return reject(new Error('HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    req.on('error', (e) => { file.close(); fs.rmSync(dest, { force: true }); reject(e); });
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
  });
}

// tar 在 Win10 1803+ / macOS / Linux 都自带（System32\tar.exe / /usr/bin/tar）。
function extractTgz(tgz, destDir) {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xzf', tgz, '-C', destDir]);
    let err = '';
    if (p.stderr) p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => c === 0 ? resolve() : reject(new Error('tar ' + c + ': ' + err.slice(0, 200))));
  });
}

/**
 * 确保模型就位。返回 'bundled' | 'cached' | 'downloaded'。
 * @param {string} rendererModelsDir  源码树 renderer/models（dev 才有）
 * @param {string} assetDir           userData/assets（下载目标 & 伺服源）
 * @param {string} url                模型包 tar.gz 的 OSS 地址
 */
async function ensureModels({ rendererModelsDir, assetDir, url, log = () => {} }) {
  try {
    if (fs.existsSync(rendererModelsDir) && fs.readdirSync(rendererModelsDir).length) return 'bundled';
  } catch {}
  if (fs.existsSync(path.join(assetDir, 'models.json'))) return 'cached';

  fs.mkdirSync(assetDir, { recursive: true });
  const tgz = path.join(assetDir, 'models.tar.gz');
  log('[models] first run — downloading', url);
  await download(url, tgz);
  log('[models] extracting →', assetDir);
  await extractTgz(tgz, assetDir);
  fs.rmSync(tgz, { force: true });
  if (!fs.existsSync(path.join(assetDir, 'models.json'))) throw new Error('bundle missing models.json');
  return 'downloaded';
}

module.exports = { ensureModels };
