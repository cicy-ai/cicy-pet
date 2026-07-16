/**
 * 火山引擎豆包大模型流式 ASR —— 边说边出字幕。
 * 协议：自定义二进制帧（gzip JSON full request + gzip PCM audio 帧），
 * 端点 bigmodel_async（双向流式，低延迟）。接法移植自 BaiLongma cloud-asr.js。
 * 认证走 X-Api-Key（方舟 API Key，和豆包 TTS 同一把）；403 时自动回退 1.0 资源。
 */
'use strict';
const zlib = require('zlib');
const crypto = require('crypto');
const WebSocket = require('ws');

const VOLC_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
const DEFAULT_RESOURCE = 'volc.seedasr.sauc.duration';
const RESOURCE_FALLBACKS = new Map([
  ['volc.seedasr.sauc.duration', 'volc.bigasr.sauc.duration'],
]);

const MSG_FULL_REQUEST = 0x1, MSG_AUDIO = 0x2, MSG_RESPONSE = 0x9, MSG_ERROR = 0xf;
const FLAG_NONE = 0x0, FLAG_LAST = 0x2;
const SER_NONE = 0x0, SER_JSON = 0x1, GZIP = 0x1;

function frame(type, flags, ser, payload) {
  const body = zlib.gzipSync(payload && payload.length ? payload : Buffer.alloc(0));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  const header = Buffer.from([(0x1 << 4) | 0x1, (type << 4) | flags, (ser << 4) | GZIP, 0x00]);
  return Buffer.concat([header, size, body]);
}

function fullRequest() {
  return frame(MSG_FULL_REQUEST, FLAG_NONE, SER_JSON, Buffer.from(JSON.stringify({
    user: { uid: 'cicy-pet' },
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false,
      result_type: 'full', show_utterances: true,
    },
  }), 'utf-8'));
}

function audioFrame(pcm, isLast = false) {
  return frame(MSG_AUDIO, isLast ? FLAG_LAST : FLAG_NONE, SER_NONE, Buffer.from(pcm || Buffer.alloc(0)));
}

function parseResponse(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 8) return null;
  const headerSize = (buf[0] & 0x0f) * 4;
  const type = (buf[1] >> 4) & 0x0f;
  const flags = buf[1] & 0x0f;
  const compression = buf[2] & 0x0f;
  let offset = headerSize;

  if (type === MSG_ERROR) {
    if (buf.length < offset + 8) return { error: '火山 ASR 返回错误帧' };
    const code = buf.readUInt32BE(offset); offset += 4;
    const size = buf.readUInt32BE(offset); offset += 4;
    return { error: `火山 ASR 错误 ${code}: ${buf.slice(offset, offset + size).toString('utf-8')}` };
  }
  if (type !== MSG_RESPONSE) return null;
  if (flags === 0x1 || flags === 0x3) offset += 4;
  if (buf.length < offset + 4) return null;
  const size = buf.readUInt32BE(offset); offset += 4;
  let payload = buf.slice(offset, offset + size);
  if (compression === GZIP && payload.length) payload = zlib.gunzipSync(payload);
  const text = payload.toString('utf-8');
  if (!text) return null;
  return { body: JSON.parse(text), isLast: flags === 0x3 };
}

// 火山 result 是「累积」的：每帧带全部 utterances，definite=已定句。
// 逐条下发（seg = 会话前缀 + 稳定下标），前端按 seg 替换/去重。
function emitTranscripts(body, isLast, onTranscript, sessionId) {
  const results = Array.isArray(body?.result) ? body.result : (body?.result ? [body.result] : []);
  const utterances = results.flatMap((r) => (Array.isArray(r?.utterances) ? r.utterances : []));
  if (utterances.length > 0) {
    utterances.forEach((u, i) => {
      if (u?.text) onTranscript(u.text, !!u.definite, `v${sessionId}:${i}`);
    });
    return;
  }
  const text = results.map((r) => r?.text || '').filter(Boolean).join('');
  if (text) onTranscript(text, !!isLast, `v${sessionId}:full`);
}

/**
 * 建一条流式识别会话。
 * @returns {{ sendAudio(pcm:Buffer):void, flush():void, close():void }}
 */
function createVolcAsrSession({ apiKey, resourceId }, onTranscript, onError, onClose) {
  const requestId = crypto.randomUUID();
  let ws = null, ready = false, closed = false, flushRequested = false;
  const pending = [];

  function connect(resId) {
    const socket = new WebSocket(VOLC_URL, {
      headers: {
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resId,
        'X-Api-Request-Id': requestId,
        'X-Api-Connect-Id': requestId,
        'X-Api-Sequence': '-1',
      },
    });
    ws = socket;
    socket.on('open', () => {
      if (ws !== socket || closed) return;
      try { socket.send(fullRequest()); } catch {}
      ready = true;
      for (const buf of pending) { try { socket.send(audioFrame(buf)); } catch {} }
      pending.length = 0;
      if (flushRequested) { try { socket.send(audioFrame(Buffer.alloc(0), true)); } catch {} }
    });
    socket.on('message', (data) => {
      if (ws !== socket) return;
      try {
        const parsed = parseResponse(data);
        if (!parsed) return;
        if (parsed.error) return onError(parsed.error);
        emitTranscripts(parsed.body, parsed.isLast, onTranscript, requestId.slice(0, 8));
      } catch (e) { onError(`火山 ASR 响应解析失败: ${e.message}`); }
    });
    socket.on('error', (err) => {
      if (ws !== socket || closed) return;
      const fb = RESOURCE_FALLBACKS.get(resId);
      if (/Unexpected server response:\s*403/i.test(err.message || '') && fb) {
        connect(fb);   // 2.0 资源没开通 → 无感回退 1.0
        return;
      }
      pending.length = 0;
      onError(err.message);
    });
    socket.on('close', () => {
      if (ws !== socket) return;
      ready = false; closed = true;
      onClose?.();
    });
  }

  connect(resourceId || DEFAULT_RESOURCE);

  return {
    sendAudio(pcm) {
      if (closed) return;
      if (ready && ws?.readyState === WebSocket.OPEN) { try { ws.send(audioFrame(pcm)); } catch {} }
      else pending.push(Buffer.from(pcm));
    },
    flush() {
      flushRequested = true;
      if (ready && ws?.readyState === WebSocket.OPEN) { try { ws.send(audioFrame(Buffer.alloc(0), true)); } catch {} }
    },
    close() {
      closed = true;
      try { ws?.close(); } catch {}
    },
  };
}

module.exports = { createVolcAsrSession };
