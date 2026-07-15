/**
 * main.js — Electron main process orchestrator.
 * All logic has been extracted into src/main/ modules.
 * This file wires them together and manages the app lifecycle.
 */
const { app, BrowserWindow, ipcMain, desktopCapturer, Menu, Tray, dialog, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const { AppContext } = require('./src/main/app-context');
const { createConfigManager } = require('./src/main/config-manager');
const { createI18nHelper } = require('./src/main/i18n-helper');
const { createTrayManager } = require('./src/main/tray-manager');
const { registerWindowHandlers } = require('./src/main/window-manager');
const { registerScreenCapture } = require('./src/main/screen-capture');
const { registerUtilityIPC } = require('./src/main/utility-ipc');
const { registerCharacterHandlers } = require('./src/main/character-manager');
const { registerEmotionIPC } = require('./src/main/emotion-ipc');
const { registerTTSIPC } = require('./src/main/tts-ipc');
const { registerEnhanceIPC } = require('./src/main/enhance-ipc');
const { registerDefaultAudioIPC } = require('./src/main/default-audio-ipc');
const { registerModelImport } = require('./src/main/model-import');
const { createPathUtils } = require('./src/utils/path-utils');
const { TTSService } = require('./src/core/tts-service');
const { TranslationService } = require('./src/core/translation-service');
const { createServer } = require('./src/main/renderer-server');

// ========== Shared State ==========

const ctx = new AppContext();
const configManager = createConfigManager(app);
const { mt } = createI18nHelper(ctx);
const basePath = __dirname;

// ========== Register Modules ==========

const { createSettingsWindow, createPetWindow } = registerWindowHandlers(ctx, ipcMain, {
    BrowserWindow, path, basePath, updateTrayMenu: () => trayManager.updateTrayMenu()
});

const trayManager = createTrayManager(ctx, {
    Tray, Menu, path, mt, basePath, app, createSettingsWindow, createPetWindow
});

registerScreenCapture(ctx, ipcMain, { desktopCapturer, powerMonitor });

registerUtilityIPC(ctx, ipcMain, {
    configManager, mt, Menu, shell, app, createSettingsWindow
});

registerCharacterHandlers(ctx, ipcMain, {
    fs, path, crypto, app, dialog, configManager
});

registerEmotionIPC(ctx, ipcMain);

registerTTSIPC(ctx, ipcMain, {
    configManager, fs, path, app, mt
});

registerEnhanceIPC(ctx, ipcMain, { app, fs, https, http });

registerDefaultAudioIPC(ctx, ipcMain, {
    app, fs, path, configManager
});

registerModelImport(ctx, ipcMain, {
    app, fs, path, dialog, mt, configManager, BrowserWindow
});

// ========== App Lifecycle ==========

app.whenReady().then(async () => {
    ctx.pathUtils = createPathUtils(app, path);
    try { ctx._cachedLang = (await configManager.loadConfigFile()).uiLanguage || 'en'; } catch {}

    // 进程内起渲染器 + TTS 服务（取代旧的 Python serve.py）。窗口都从 127.0.0.1:13004
    // 加载，所以必须先把它拉起来再建窗口。失败也不阻塞——窗口那边有 loadFile 兜底。
    try {
        const cacheDir = path.join(app.getPath('userData'), '.tts-cache');
        ctx.rendererServer = await createServer({ appDir: basePath, cacheDir, port: 13004,
            log: (...a) => console.log(...a) });
    } catch (e) {
        console.error('[server] failed to start:', e.message);
    }

    ctx.ttsService = new TTSService();
    ctx.translationService = new TranslationService();
    createSettingsWindow();
    trayManager.createTray();

    // 宠物窗口本来只有在设置里导入模型后才会被创建（而这个仓库不带任何模型，
    // 所以默认永远看不到宠物）。渲染现在交给 live2d-standalone 的 pet.html，
    // 模型它自己带，所以启动就把宠物拉起来。
    createPetWindow().catch((e) => console.error('[pet] autostart failed:', e.message));

    // Initialize TTS after windows are created (non-blocking)
    setImmediate(async () => {
        const voicevoxDir = ctx.pathUtils.getVoicevoxPath();
        if (voicevoxDir && fs.existsSync(voicevoxDir)) {
            const config = await configManager.loadConfigFile();
            const vvmFiles = config.tts?.vvmFiles || ['0.vvm', '8.vvm'];
            const gpuMode = config.tts?.gpuMode || false;
            const ok = ctx.ttsService.init(voicevoxDir, vvmFiles, { gpuMode });
            if (ok) {
                if (config.tts) ctx.ttsService.setConfig(config.tts);
                if (config.apiKey) {
                    const tl = config.translation || {};
                    ctx.translationService.configure({
                        apiKey: tl.apiKey || config.apiKey,
                        baseURL: tl.baseURL || config.baseURL || 'https://openrouter.ai/api/v1',
                        modelName: tl.modelName || config.modelName || 'x-ai/grok-4.1-fast'
                    });
                }
            }
        } else {
            console.log('[TTS] voicevox_core not found, TTS disabled');
        }
    });
});

app.on('window-all-closed', () => {
    if (ctx.tray) return;
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    ctx.isQuitting = true;
});
