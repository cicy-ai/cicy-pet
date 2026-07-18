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
const DEFAULT_VOICE = { say: 'Tingting', edge: 'zh-CN-XiaoyiNeural', doubao: 'zh_female_shuangkuaisisi_uranus_bigtts' };

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

// 豆包（方舟）2.0 大模型音色——纯 HTTP 调用，无本地依赖，mac/win/linux 通吃。
// 需要 config.json 里配 doubaoKey（火山方舟语音合成的 API Key）。
const DOUBAO_VOICES = [
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思 · 女 · 活泼' },
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小源 · 女 · 甜美' },
  { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿 · 女 · 角色' },
  { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 · 女 · 通用' },
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi · 女 · 多语种' },
  { id: 'zh_male_taocheng_uranus_bigtts', name: '小天 · 男 · 通用' },
];

// 豆包 TTS：JSON-lines 流，每行 {code, data: base64 mp3 块}，拼起来就是完整 mp3。
// （前端 decodeAudioData 认字节不认扩展名，mp3 直接可播。）接法参考 BaiLongma。
async function doubaoSynth({ voice, text, rate, key }) {
  if (!key) throw new Error('doubaoKey 未配置（config.json）');
  const speaker = voice || 'zh_female_shuangkuaisisi_uranus_bigtts';
  const resourceId = /_moon_bigtts$/.test(speaker) || /^BV\d+(_24k)?_streaming$/.test(speaker)
    ? 'seed-tts-1.0' : 'seed-tts-2.0';
  const reqParams = { text, speaker, audio_params: { format: 'mp3', sample_rate: 24000 } };
  const r = parseInt(rate, 10);   // 前端传 "+8%" → 8；豆包 speech_rate 0=原速 100=2倍
  if (Number.isFinite(r) && r !== 0) reqParams.audio_params.speech_rate = Math.max(-50, Math.min(100, r));
  const resp = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
    method: 'POST',
    headers: {
      'X-Api-Key': key,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': `cicy_${Date.now()}_${process.pid}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user: { uid: 'cicy-pet' }, req_params: reqParams }),
  });
  if (!resp.ok) throw new Error(`doubao ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const raw = Buffer.from(await resp.arrayBuffer());
  if ((resp.headers.get('content-type') || '').includes('audio/')) return raw;
  const chunks = [];
  for (const rawLine of raw.toString('utf8').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^data:\s*/, '');
    if (!line || line === '[DONE]' || !line.startsWith('{')) continue;
    const d = JSON.parse(line);
    const code = Number(d.code ?? d.status_code ?? 0);
    if (code > 0 && code !== 20000000) throw new Error(`doubao ${code}: ${d.message || d.status_text || ''}`);
    if (d.data) chunks.push(Buffer.from(d.data, 'base64'));
  }
  if (!chunks.length) throw new Error('doubao: 没拿到音频数据');
  return Buffer.concat(chunks);
}

// 豆包流式 TTS：请求 PCM 格式，把每帧 base64 解码出的裸 PCM16 立刻写给 res。
// 首字延迟≈一帧（几十 ms），前端边收边播。采样率 24k、单声道、LE16。
async function doubaoStreamPCM(res, { voice, text, rate, key }) {
  if (!key) throw new Error('doubaoKey 未配置');
  const speaker = voice || 'zh_female_shuangkuaisisi_uranus_bigtts';
  const resourceId = /_moon_bigtts$/.test(speaker) || /^BV\d+(_24k)?_streaming$/.test(speaker)
    ? 'seed-tts-1.0' : 'seed-tts-2.0';
  const reqParams = { text, speaker, audio_params: { format: 'pcm', sample_rate: 24000 } };
  const r = parseInt(rate, 10);
  if (Number.isFinite(r) && r !== 0) reqParams.audio_params.speech_rate = Math.max(-50, Math.min(100, r));
  const resp = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
    method: 'POST',
    headers: {
      'X-Api-Key': key, 'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': `cicy_${Date.now()}_${process.pid}`, 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user: { uid: 'cicy-pet' }, req_params: reqParams }),
  });
  if (!resp.ok) throw new Error(`doubao ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
  res.writeHead(200, {
    'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000',
    'Cache-Control': 'no-store', 'Transfer-Encoding': 'chunked',
  });
  // web ReadableStream → 逐块解码 JSON-lines（行可能跨块，留 pending 拼接）
  const reader = resp.body.getReader();
  let pending = '';
  const flushLine = (line) => {
    const s = line.trim().replace(/^data:\s*/, '');
    if (!s || s === '[DONE]' || !s.startsWith('{')) return;
    let d; try { d = JSON.parse(s); } catch { return; }
    const code = Number(d.code ?? d.status_code ?? 0);
    if (code > 0 && code !== 20000000) throw new Error(`doubao ${code}: ${d.message || ''}`);
    if (d.data) res.write(Buffer.from(d.data, 'base64'));   // 裸 PCM 立即下发
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += Buffer.from(value).toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const ln of lines) flushLine(ln);
  }
  if (pending.trim()) flushLine(pending);
  res.end();
}

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

// 从 agent 回复里抽出「该读出来的话」：cicy agent 回复形如
// "[thinking]\n...\n\n[text]\n<真正答复>"。取 [text] 段，去掉 markdown / emoji / 长链接。
function extractSpoken(raw) {
  let t = raw || '';
  const idx = t.lastIndexOf('[text]');
  if (idx >= 0) {
    t = t.slice(idx + 6);            // 只要 [text] 之后
  } else if (/\[thinking\]/.test(t)) {
    // 有 thinking 但没 text 标记 → 宁可不读，也绝不把思考念出来
    return '';
  }
  return t
    .replace(/```[\s\S]*?```/g, '')           // 代码块整段删
    .replace(/https?:\/\/\S+/g, '')           // 链接不读
    .replace(/[*_`#>~|]/g, '')                // markdown 符号
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️]/gu, '') // emoji
    .replace(/\n{2,}/g, '\n').trim()
    .slice(0, 240);                           // 桌宠只读前 240 字，别念长文
}

function createServer({ appDir, cacheDir, assetDir = null, port = 13004, log = () => {}, getConfig = null }) {
  const rendererDir = path.join(appDir, 'renderer');
  let voicesCache = null;

  // 语音密钥放独立的 secrets.json（gitignore）——不能放 config.json：
  // configManager 的保存周期会按字段白名单重写整个文件，白名单外的字段直接被丢。
  async function readSecrets() {
    let out = {};
    try { if (getConfig) out = (await getConfig()) || {}; } catch {}
    try {
      Object.assign(out, JSON.parse(fs.readFileSync(path.join(appDir, 'secrets.json'), 'utf8')));
    } catch {}
    return out;
  }

  // ── Sherlly agent 桥 ──────────────────────────────────────────────────────
  // 发消息给 cicy-code 的 agent pane，轮询 current-reply 直到那一轮跑完，取纯文本回复。
  const AGENT_BASE = process.env.CICY_API_PORT ? `http://127.0.0.1:${process.env.CICY_API_PORT}` : 'http://127.0.0.1:8008';
  const controlClients = new Set();   // /control-stream 的在线订阅者(桌面 pet.html)
  let petCfg = {};                    // 桌面雪莉上报的当前配置(手机配置页回显用)
  // Electron 主进程带着会话代理（http_proxy=127.0.0.1:9001），fetch 会把本机 8008 也
  // 发去代理导致连不上 → 给 agent 请求显式关代理（Node18+ fetch 支持 dispatcher）。
  let noProxyDispatcher = null;
  try {
    const { Agent } = require('undici');
    noProxyDispatcher = new Agent();
  } catch {}
  const agentFetch = (url, opts = {}) =>
    fetch(url, noProxyDispatcher ? { ...opts, dispatcher: noProxyDispatcher } : opts);
  async function agentToken() {
    const s = await readSecrets();
    if (s.cicyToken) return s.cicyToken;
    try {
      const g = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'cicy-ai', 'global.json'), 'utf8'));
      return g.api_token || '';
    } catch { return ''; }
  }
  async function agentPane() { return (await readSecrets()).agentPane || 'w-10242'; }

  // 小本本数据源：直读大脑（Sherlly）工作区的持久记忆目录。
  // 每条记忆 = 一个带 frontmatter 的 .md（cicy-code recognizer 每轮自动写入），
  // 这里只做解析和分组，渲染交给 pet.html 的手账面板。
  function readAgentMemories(pane) {
    const dir = path.join(os.homedir(), 'cicy-ai', 'workers', pane, '.cicy', 'memory');
    let items = [];
    try { items = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const name of items) {
      if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
      let raw = '';
      try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (!m) continue;
      const e = { mem_id: name.replace(/\.md$/, ''), type: 'fact', title: '', salience: 3, tags: [], updated: '', content: m[2].trim() };
      for (const line of m[1].split('\n')) {
        const kv = line.match(/^(\w+):\s*(.*)$/);
        if (!kv) continue;
        const [, k, v] = kv;
        if (k === 'mem_id') e.mem_id = v.trim();
        else if (k === 'type') e.type = v.trim();
        else if (k === 'title') e.title = v.trim();
        else if (k === 'salience') e.salience = parseInt(v, 10) || 3;
        else if (k === 'tags') e.tags = v.split(',').map((s) => s.trim()).filter(Boolean);
        else if (k === 'updated') e.updated = v.trim();
      }
      out.push(e);
    }
    // 首页排序：salience 高在前，同级按更新时间新在前
    out.sort((a, b) => (b.salience - a.salience) || String(b.updated).localeCompare(String(a.updated)));
    return out;
  }

  async function askAgent(text) {
    const token = await agentToken();
    const pane = await agentPane();
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const replyUrl = `${AGENT_BASE}/api/agents/current-reply/${pane}`;
    // 基线 turn_id：发送前记住，等它变化＝新一轮的回复
    let baseTurn = '';
    try { baseTurn = (await (await agentFetch(replyUrl, { headers: H })).json()).turn_id || ''; } catch {}
    // 发送
    const send = await agentFetch(`${AGENT_BASE}/api/tmux/send`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ win_id: pane, text, submit: true }),
    });
    if (!send.ok) throw new Error(`send ${send.status}: ${(await send.text()).slice(0, 120)}`);
    // 轮询新一轮完成（最多 90s；agent 干活可能慢）
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700));
      let j;
      try { j = await (await agentFetch(replyUrl, { headers: H })).json(); } catch { continue; }
      const turn = (j.turn_id || '').trim();
      if (turn && turn !== baseTurn && j.complete) {
        const ans = (j.answer || '').trim();
        if (ans) return ans;
      }
    }
    throw new Error('agent 超时未回复');
  }

  async function allVoices() {                // 懒加载：edge 列表要联网，慢起来十几秒
    if (!voicesCache) {
      const doubao = (await readSecrets()).doubaoKey
        ? DOUBAO_VOICES.map((v) => ({ engine: 'doubao', id: v.id, name: v.name }))
        : [];
      voicesCache = [...doubao, ...await edgeVoices(), ...await systemVoices()];
    }
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
      if (engine === 'doubao') {
        const mp3 = await doubaoSynth({ voice, text, rate, key: (await readSecrets()).doubaoKey });
        fs.writeFileSync(out, mp3);   // 缓存文件后缀 .wav 但内容是 mp3——前端按字节嗅探，无所谓
        return { wav: mp3, hit: false };
      }
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
      // 语音转文字：POST 16kHz 单声道 wav → 本地 whisper-cli（离线、免 key）→ {text}
      // 模型放 ~/.cache/whisper-cpp/ggml-small.bin（或 WHISPER_MODEL 指定）。
      if (u.pathname === '/stt' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cicystt-'));
          try {
            const mdlDir = path.join(os.homedir(), '.cache', 'whisper-cpp');
            const model = process.env.WHISPER_MODEL
              || ['ggml-small.bin', 'ggml-base.bin'].map((f) => path.join(mdlDir, f)).find((p) => fs.existsSync(p));
            if (!model || !fs.existsSync(model)) { res.statusCode = 503; return res.end('whisper model missing'); }
            const wav = path.join(tmp, 'in.wav');
            fs.writeFileSync(wav, Buffer.concat(chunks));
            // GUI 启动时 PATH 常不含 /usr/local/bin，优先用绝对路径
            const bin = ['/usr/local/bin/whisper-cli', '/opt/homebrew/bin/whisper-cli']
              .find((p) => fs.existsSync(p)) || 'whisper-cli';
            // --prompt 偏置成简体（whisper 中文默认爱出繁体）
            const out = (await run(bin,
              ['-m', model, '-f', wav, '-l', 'zh', '-nt', '-np',
               '--prompt', '以下是普通话的简体中文。'])).toString('utf8').trim();
            const body = Buffer.from(JSON.stringify({ text: out }), 'utf8');
            noStore({ 'Content-Type': MIME['.json'], 'Content-Length': body.length });
            res.end(body);
          } catch (e) {
            log('[stt] failed:', e.message);
            res.statusCode = 500; res.end('stt failed: ' + e.message);
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        });
        return;
      }
      // ── /agent：把宠物的话交给 cicy-code 的 Sherlly agent，等它跑完把文字回复拿回来 ──
      // 宠物 = 脸和嘴，Sherlly = 有手有脚的大脑。发送走 cicy-agent，取回复轮询 current-reply。
      // ---------- 手机遥控通道 ----------
      // 手机(remote.html / cicy-mobile)POST /control 下指令;桌面 pet.html 用
      // EventSource 挂在 /control-stream 上即时收到并执行。全控制 = 拍摄导演台在手机上。
      if (u.pathname === '/control' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const { cmd, arg } = JSON.parse(body || '{}');
            const payload = JSON.stringify({ cmd, arg, t: Date.now() });
            for (const client of controlClients) { try { client.write(`data: ${payload}\n\n`); } catch {} }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, listeners: controlClients.size }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(e.message || e) }));
          }
        });
        return;
      }
      if (u.pathname === '/control-stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*',
        });
        res.write(': hello\n\n');
        controlClients.add(res);
        const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);
        req.on('close', () => { clearInterval(ka); controlClients.delete(res); });
        return;
      }

      // 桌面雪莉上报当前配置(POST) / 手机读当前配置(GET)——配置页回显现状
      if (u.pathname === '/petcfg') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => {
            try { petCfg = JSON.parse(body || '{}'); } catch {}
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          });
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(petCfg));
        }
        return;
      }

      if (u.pathname === '/memories') {
        try {
          const pane = await agentPane();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ entries: readAgentMemories(pane) }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e.message || e) }));
        }
        return;
      }

      if (u.pathname === '/agent' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          let text = '';
          try { text = (JSON.parse(Buffer.concat(chunks).toString()).text || '').trim(); } catch {}
          if (!text) { res.statusCode = 400; return res.end('text required'); }
          try {
            const answer = await askAgent(text);
            const body = Buffer.from(JSON.stringify({ answer }), 'utf8');
            noStore({ 'Content-Type': MIME['.json'], 'Content-Length': body.length });
            res.end(body);
          } catch (e) {
            log('[agent] failed:', e.message);
            res.statusCode = 500; res.end('agent failed: ' + e.message);
          }
        });
        return;
      }
      // 视觉：POST {image(base64 或 dataURL), prompt} → 智谱 GLM-4V-Flash（免费）→ {text}
      // CiCy「看屏幕」用它：渲染端截屏传进来，这里代理调用（key 不暴露给页面）。
      if (u.pathname === '/vision' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          try {
            const { image, prompt } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            if (!image) { res.statusCode = 400; return res.end('image required'); }
            const key = (await readSecrets()).zhipuKey;
            if (!key) { res.statusCode = 503; return res.end('zhipuKey 未配置'); }
            const url = /^data:/.test(image) ? image : `data:image/jpeg;base64,${image}`;
            const r = await agentFetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
              method: 'POST',
              headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'glm-4v-flash',
                messages: [{ role: 'user', content: [
                  { type: 'text', text: prompt || '简短描述这张屏幕截图里用户在做什么。' },
                  { type: 'image_url', image_url: { url } },
                ] }],
              }),
            });
            const j = await r.json();
            const text = ((j.choices && j.choices[0].message.content) || '').replace(/<\|[^|]*\|>/g, '').trim();
            const body = Buffer.from(JSON.stringify({ text }), 'utf8');
            noStore({ 'Content-Type': MIME['.json'], 'Content-Length': body.length });
            res.end(body);
          } catch (e) {
            log('[vision] failed:', e.message);
            res.statusCode = 500; res.end('vision failed: ' + e.message);
          }
        });
        return;
      }
      // 豆包流式 TTS：边合成边下发裸 PCM，前端边收边播（首字快）。只有 doubao 走这里。
      if (u.pathname === '/tts-stream') {
        const text = (u.searchParams.get('text') || '').trim();
        const voice = u.searchParams.get('voice') || DEFAULT_VOICE.doubao;
        const rate = /^[+-]\d{1,3}%$/.test(u.searchParams.get('rate') || '') ? u.searchParams.get('rate') : '';
        if (!text) { res.statusCode = 400; return res.end('text required'); }
        try {
          const key = (await readSecrets()).doubaoKey;
          await doubaoStreamPCM(res, { voice, text, rate, key });
        } catch (e) {
          log('[tts-stream] failed:', e.message);
          if (!res.headersSent) { res.statusCode = 500; res.end('stream failed: ' + e.message); }
          else { try { res.end(); } catch {} }
        }
        return;
      }
      if (u.pathname === '/tts') {
        const text = (u.searchParams.get('text') || '').trim();
        const engine = u.searchParams.get('engine') || DEFAULT_ENGINE;
        const voice = u.searchParams.get('voice') || DEFAULT_VOICE[engine] || '';
        if (!text) { res.statusCode = 400; return res.end('text required'); }
        if (!['say', 'edge', 'doubao'].includes(engine)) { res.statusCode = 400; return res.end('bad engine'); }
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

  // ── /asr：流式字幕桥 ─────────────────────────────────────────────────────
  // 渲染端 WS 送 16k PCM16 小块进来，这里桥到火山流式 ASR，字幕增量推回去。
  // 浏览器 WebSocket 发不了自定义鉴权头，所以必须在这儿代理一层。
  try {
    const { WebSocketServer } = require('ws');
    const { createVolcAsrSession } = require('./volc-asr');
    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    wss.on('connection', async (ws) => {
      const key = (await readSecrets()).volcAsrKey || (await readSecrets()).doubaoKey;
      if (!key) { ws.send(JSON.stringify({ type: 'error', message: '未配置豆包/火山 key' })); ws.close(); return; }
      const session = createVolcAsrSession({ apiKey: key },
        (text, definite, seg) => { try { ws.send(JSON.stringify({ type: 'transcript', text, definite, seg })); } catch {} },
        (message) => { try { ws.send(JSON.stringify({ type: 'error', message })); } catch {} },
        () => { try { ws.close(); } catch {} });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return session.sendAudio(data);
        try { if (JSON.parse(data.toString()).type === 'flush') session.flush(); } catch {}
      });
      ws.on('close', () => session.close());
    });
    server.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://x').pathname !== '/asr') { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  } catch (e) { log('[asr] streaming bridge unavailable:', e.message); }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // 0.0.0.0:手机(cicy-mobile 雪莉页/浏览器)走局域网直连这台 Mac 的皮囊与嘴。
    // 端点无鉴权,家用局域网可接受;上公网需加防护。
    server.listen(port, '0.0.0.0', () => {
      log(`[server] http://127.0.0.1:${port}  renderer=${rendererDir}`);
      resolve(server);
    });
  });
}

module.exports = { createServer };
