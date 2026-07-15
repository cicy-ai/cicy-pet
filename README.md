# CiCy Pet 🐾

一个跑在桌面上的 **AI Live2D 桌宠**：它会定时看你的屏幕，用视觉模型看懂你在干嘛，
再用大模型生成一句陪伴式的话，配上中文语音、口型同步和情绪驱动的表情/动作说出来。

- **AI 大脑** —— 截屏感知 · VLM 情境提取 · 主动陪聊 · 情绪系统（表情/动作随心情演出来）
- **中文 TTS + 口型同步** —— macOS `say`（离线）或微软 edge 神经音色，带磁盘缓存
- **14 个形象** —— 可换角色、跳舞、转圈、挥手；每个角色标注授权（直播/录播前必看）
- **进程内服务** —— 静态渲染 + TTS 全在 Electron 主进程里，无需外部 Python 服务

> 基于 [x380kkm/Live2DPet](https://github.com/x380kkm/Live2DPet) 的桌宠外壳与 AI 大脑改造而来。

## 跑起来

```bash
npm install
npm start
```

首次启动后，在设置窗口「AI 大脑」里填入一个 OpenAI 兼容的 API（地址 + Key + 模型，
建议用带视觉的模型），点「启动大脑」，它就会开始看屏并主动说话。

> **隐私** —— 开启视觉记忆后，它会定时截取整个屏幕并发给你配置的 API。开之前想清楚。

## 打包发布

和 cicy-desktop 同款，用 electron-builder：

```bash
npm run build:mac     # dmg + zip
npm run build:win     # nsis
npm run build:linux   # AppImage
```

产物在 `dist/`。CI 发布 workflow 在 `.github/workflows/`（发到 GitHub Release +
npm，和 cicy-desktop 一致）。

> ⚠️ **模型不随发布分发。** Live2D 授权 §4.1.1 禁止再分发模型文件，`renderer/models/`
> 已被 git 忽略。公开的 Release/npm 产物**不得**包含模型；本地自用可自行放入。详见 [NOTICE](./NOTICE)。

## 结构

```
main.js                      Electron 主进程编排
src/main/renderer-server.js  进程内静态服务 + TTS（取代旧的 Python serve.py）
src/main/                    窗口 / 托盘 / 截屏 / 情绪 IPC / 角色 …
src/core/                    AI 大脑：ai-chat · prompt-builder · emotion-system · vlm-extractor …
renderer/                    pet.html（桌宠渲染）· settings.html（设置）· libs · models(git-ignored)
```

## 授权

代码 MIT（见 [LICENSE](./LICENSE)）。Live2D Core / 模型另有授权，见 [NOTICE](./NOTICE)。
