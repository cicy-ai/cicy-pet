/**
 * renderer-server.js — 进程内静态服务 + TTS。
 *
 * 取代原来的 Python `serve.py`：打包成 app 后换台机器不一定有 python，所以把
 * 「服务渲染器 + 合成语音」搬进 Electron 主进程，只用 Node 内置模块，不加依赖。
 *
 * 路由：
 *   GET /                 → renderer/（pet.html / settings.html / models / libs）
 *   GET /app/...          → 仓库根（大脑那 15 个核心脚本在 src/ 下，settings.html 同源加载）
 *   GET /voices           → [{engine, id, name}]
 *   GET /tts?text=&engine=&voice= → audio/wav
 *
 * TTS 引擎（和 serve.py 一致）：
 *   say  : macOS 自带，离线、无需 python；音色机械。
 *   edge : 微软神经音色，自然；需要 `python3 -m edge_tts`（装了才有，没装自动回落 say）。
 * 缓存放 userData/.tts-cache（app 包只读，不能往里写）。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_ENGINE = 'edge';
const DEFAULT_VOICE = { say: 'Tingting', edge: 'zh-CN-XiaoyiNeural' };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.moc3': 'application/octet-stream', '.woff2': 'font/woff2',
};

// edge-tts 走 websocket 到微软；会话代理会把它扛死，spawn 时摘掉 proxy 变量。
const NO_PROXY_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(http_proxy|https_proxy|all_proxy)$/i.test(k))
);

// 昵称表：edge 的中文神经音色
const EDGE_NICE = {
  'zh-CN-XiaoxiaoNeural': '晓晓 · 女 · 温柔', 'zh-CN-XiaoyiNeural': '晓伊 · 女 · 活泼',
  'zh-CN-YunxiNeural': '云希 · 男 · 阳光', 'zh-CN-YunxiaNeural': '云夏 · 男 · 少年',
  'zh-CN-YunjianNeural': '云健 · 男 · 沉稳', 'zh-CN-YunyangNeural': '云扬 · 男 · 播音',
  'zh-CN-liaoning-XiaobeiNeural': '晓北 · 女 · 东北', 'zh-CN-shaanxi-XiaoniNeural': '晓妮 · 女 · 陕西',
};

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts });
    let out = Buffer.alloc(0), err = '';
    if (p.stdout) p.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    if (p.stderr) p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${err.slice(0, 200)}`)));
  });
}

async function sayVoices() {
  // macOS 自带中文音色。坑：短名 `say -v Eddy` 会选到英文版念出空音频，必须用全名。
  if (process.platform !== 'darwin') return [];
  try {
    const out = (await run('say', ['-v', '?'])).toString('utf8');
    const seen = new Set(), voices = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^(.+?)\s+zh_CN\s/);
      if (!m) continue;
      const full = m[1].trim();
      if (seen.has(full)) continue;
      seen.add(full);
      voices.push({ engine: 'say', id: full, name: full.split(' (')[0] });
    }
    return voices;
  } catch { return []; }
}

async function edgeVoices() {
  try {
    const out = (await run('python3', ['-m', 'edge_tts', '--list-voices'], { env: NO_PROXY_ENV })).toString('utf8');
    const voices = [];
    for (const line of out.split('\n')) {
      const id = line.trim().split(/\s+/)[0] || '';
      if (id.startsWith('zh-CN-')) voices.push({ engine: 'edge', id, name: EDGE_NICE[id] || id });
    }
    return voices;
  } catch { return []; }
}

// Windows 内置 SAPI（System.Speech）—— Windows 版的「say」：能直接合成中文 wav，
// 不需要 afconvert。文本/音色/输出路径走环境变量传进 PowerShell，避免引号注入。
const WIN_LIST_PS1 = `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | Where-Object { $_.Culture.Name -like 'zh*' } | ForEach-Object { $_.Name }
$s.Dispose()`;
const WIN_SAY_PS1 = `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { if ($env:TTS_VOICE) { $s.SelectVoice($env:TTS_VOICE) } } catch {}
$s.SetOutputToWaveFile($env:TTS_OUT)
$s.Speak([System.IO.File]::ReadAllText($env:TTS_TXT, [System.Text.Encoding]::UTF8))
$s.Dispose()`;

async function winVoices() {
  if (process.platform !== 'win32') return [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cicypet-v-'));
  const ps = path.join(tmp, 'list.ps1');
  try {
    fs.writeFileSync(ps, WIN_LIST_PS1);
    const out = (await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps])).toString('utf8');
    return out.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((name) => ({ engine: 'say', id: name, name: name.replace(/^Microsoft\s+/, '').replace(/\s+Desktop$/, '') }));
  } catch { return []; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// 平台内置 TTS：mac 用 say，win 用 SAPI，其余暂无。前端里这一档都叫 engine="say"。
async function systemVoices() {
  if (process.platform === 'win32') return winVoices();
  return sayVoices();
}

function createServer({ appDir, cacheDir, assetDir = null, port = 13004, log = () => {} }) {
  const rendererDir = path.join(appDir, 'renderer');
  let voicesCache = null;

  async function allVoices() {                // 懒加载：edge 列表要联网，慢起来十几秒
    if (!voicesCache) voicesCache = [...await edgeVoices(), ...await systemVoices()];
    return voicesCache;
  }

  function cachePath(engine, voice, text, rate, pitch) {
    const key = crypto.createHash('sha1').update(`${engine}|${voice}|${text}|${rate || ''}|${pitch || ''}`).digest('hex');
    return path.join(cacheDir, `${key}.wav`);
  }

  async function synth(engine, voice, text, rate, pitch) {
    const out = cachePath(engine, voice, text, rate, pitch);
    if (fs.existsSync(out)) return { wav: fs.readFileSync(out), hit: true };
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cicypet-'));
    const wav = path.join(tmp, 'o.wav');
    try {
      if (engine === 'edge') {
        // edge 需要 python3 + afconvert；mac 上默认可用，win/linux 上多半没有（前端会
        // 自动回落到 say）。前端口型用 buf.sampleRate 自适应，所以采样率不必强行归一。
        // rate/pitch：edge 支持 ±% / ±Hz（如 +8% / +20Hz），调皮感主要靠这两个。
        const mp3 = path.join(tmp, 'o.mp3');
        const extra = [];
        if (rate) extra.push(`--rate=${rate}`);
        if (pitch) extra.push(`--pitch=${pitch}`);
        await run('python3', ['-m', 'edge_tts', '--voice', voice, ...extra, '--text', text, '--write-media', mp3], { env: NO_PROXY_ENV });
        await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', '-c', '1', mp3, wav]);
      } else if (process.platform === 'win32') {
        // Windows 内置 SAPI → 直接写 wav（PCM），无需 afconvert
        const ps = path.join(tmp, 'say.ps1'), txt = path.join(tmp, 'in.txt');
        fs.writeFileSync(ps, WIN_SAY_PS1);
        fs.writeFileSync(txt, text, 'utf8');
        await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps],
          { env: { ...process.env, TTS_VOICE: voice || '', TTS_OUT: wav, TTS_TXT: txt } });
      } else {
        const aiff = path.join(tmp, 'o.aiff');
        await run('say', ['-v', voice, '-o', aiff, text]);
        await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', aiff, wav]);
      }
      const data = fs.readFileSync(wav);
      fs.writeFileSync(out + '.part', data);   // 原子落盘
      fs.renameSync(out + '.part', out);
      return { wav: data, hit: false };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // path → 磁盘文件；/app/* 映射到仓库根，其余映射到 renderer/。带目录穿越防护。
  const guard = (base, rel) => {
    const t = path.resolve(base, rel);
    return (t === base || t.startsWith(base + path.sep)) ? t : null;   // 防越界
  };
  function resolveFile(urlPath) {
    const clean = decodeURIComponent(urlPath.split('?')[0]);
    if (clean.startsWith('/app/')) return guard(appDir, clean.slice(5));
    const rel = clean.replace(/^\/+/, '') || 'settings.html';
    // 模型资产优先从 assetDir（首次运行下载到 userData）取；打包后 renderer/ 里没有模型，
    // 这时全靠 assetDir。dev 源码树里带 models，assetDir 为空 → 自动回落 renderer/。
    if (assetDir && (rel === 'models.json' || rel.startsWith('models/'))) {
      const a = guard(assetDir, rel);
      if (a && fs.existsSync(a)) return a;
    }
    return guard(rendererDir, rel);
  }

  const server = http.createServer(async (req, res) => {
    const noStore = (extra = {}) => res.writeHead(res.statusCode || 200, { 'Cache-Control': 'no-store', ...extra });
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/voices') {
        const body = Buffer.from(JSON.stringify(await allVoices()), 'utf8');
        noStore({ 'Content-Type': MIME['.json'], 'Content-Length': body.length });
        return res.end(body);
      }
      if (u.pathname === '/tts') {
        const text = (u.searchParams.get('text') || '').trim();
        const engine = u.searchParams.get('engine') || DEFAULT_ENGINE;
        const voice = u.searchParams.get('voice') || DEFAULT_VOICE[engine] || '';
        if (!text) { res.statusCode = 400; return res.end('text required'); }
        if (engine !== 'say' && engine !== 'edge') { res.statusCode = 400; return res.end('bad engine'); }
        // rate/pitch 只对 edge 生效，格式 ±N% / ±NHz（防注入：只放行这两种形状）
        const rate = /^[+-]\d{1,3}%$/.test(u.searchParams.get('rate') || '') ? u.searchParams.get('rate') : '';
        const pitch = /^[+-]\d{1,3}Hz$/.test(u.searchParams.get('pitch') || '') ? u.searchParams.get('pitch') : '';
        try {
          const { wav, hit } = await synth(engine, voice, text, rate, pitch);
          noStore({ 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'X-TTS-Cache': hit ? 'hit' : 'miss' });
          return res.end(wav);
        } catch (e) {
          log('[tts]', engine, 'failed:', e.message);
          res.statusCode = 500; return res.end(`${engine} failed: ${e.message}`);
        }
      }
      // 静态文件
      const file = resolveFile(u.pathname);
      if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.statusCode = 404; return res.end('not found');
      }
      const data = fs.readFileSync(file);
      noStore({ 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': data.length });
      res.end(data);
    } catch (e) {
      log('[server] error:', e.message);
      res.statusCode = 500; res.end('server error');
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(`[server] http://127.0.0.1:${port}  renderer=${rendererDir}`);
      resolve(server);
    });
  });
}

module.exports = { createServer };
