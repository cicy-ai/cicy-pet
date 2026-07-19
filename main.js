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
const { registerEnhanceIPC } = require('./src/main/enhance-ipc');
const { registerDefaultAudioIPC } = require('./src/main/default-audio-ipc');
const { registerModelImport } = require('./src/main/model-import');
const { createPathUtils } = require('./src/utils/path-utils');
const { createServer } = require('./src/main/renderer-server');
const { ensureModels } = require('./src/main/model-fetcher');

// 模型包（Live2D §4.1.1 不随安装包分发）——首次运行从 OSS 拉到 userData。
const MODELS_URL = process.env.CICY_PET_MODELS_URL
    || 'https://cicy-1372193042-cn.oss-cn-shanghai.aliyuncs.com/releases/cicy-pet-models.tar.gz';

// ========== Shared State ==========

const ctx = new AppContext();
const configManager = createConfigManager(app);
const { mt } = createI18nHelper(ctx);
const basePath = __dirname;

// ========== Register Modules ==========

const { createSettingsWindow, createPetWindow, recallToDesktop } = registerWindowHandlers(ctx, ipcMain, {
    BrowserWindow, path, basePath, updateTrayMenu: () => trayManager.updateTrayMenu()
});

const trayManager = createTrayManager(ctx, {
    Tray, Menu, path, mt, basePath, app, createSettingsWindow, createPetWindow, recallToDesktop
});

registerScreenCapture(ctx, ipcMain, { desktopCapturer, powerMonitor });

registerUtilityIPC(ctx, ipcMain, {
    configManager, mt, Menu, shell, app, createSettingsWindow
});

registerCharacterHandlers(ctx, ipcMain, {
    fs, path, crypto, app, dialog, configManager
});

registerEmotionIPC(ctx, ipcMain);

registerEnhanceIPC(ctx, ipcMain, { app, fs, https, http });

registerDefaultAudioIPC(ctx, ipcMain, {
    app, fs, path, configManager
});

registerModelImport(ctx, ipcMain, {
    app, fs, path, dialog, mt, configManager, BrowserWindow
});

// ========== App Lifecycle ==========

// 单实例锁：重复启动（双击两次 .command/.bat 很常见）只会叠出两只互相打架的宠物
// ——第二个实例直接退出，把已在跑的那只带到前面。
if (!app.requestSingleInstanceLock()) {
    app.quit();
}
app.on('second-instance', () => {
    if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
        ctx.petWindow.show();
        ctx.petWindow.focus();
    }
});

app.whenReady().then(async () => {
    ctx.pathUtils = createPathUtils(app, path);
    try { ctx._cachedLang = (await configManager.loadConfigFile()).uiLanguage || 'en'; } catch {}

    // 进程内起渲染器 + TTS 服务（取代旧的 Python serve.py）。窗口都从 127.0.0.1:13004
    // 加载，所以必须先把它拉起来再建窗口。失败也不阻塞——窗口那边有 loadFile 兜底。
    const assetDir = path.join(app.getPath('userData'), 'assets');
    try {
        const cacheDir = path.join(app.getPath('userData'), '.tts-cache');
        ctx.rendererServer = await createServer({ appDir: basePath, cacheDir, assetDir, port: 13004,
            log: (...a) => console.log(...a),
            // doubao TTS 的 key 存在 config.json（gitignore），server 按需读
            getConfig: () => configManager.loadConfigFile().catch(() => ({})),
            // /perms:实时报系统授权状态(配置页显示"眼睛/耳朵"开没开);
            // open=1 时顺手把对应的系统设置页打开(只有桌面本机能干这事)
            perms: (open) => {
                const { systemPreferences, shell } = require('electron');
                if (process.platform !== 'darwin') return { platform: process.platform, screen: 'granted', microphone: 'granted' };
                const PANES = {
                    screen: 'Privacy_ScreenCapture', microphone: 'Privacy_Microphone',
                    camera: 'Privacy_Camera', accessibility: 'Privacy_Accessibility',
                };
                if (PANES[open]) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + PANES[open]);
                // 绝不查 accessibility:isTrustedAccessibilityClient 在未签名 App 上
                // 每查一次系统就骚扰一次(用户 2026-07-19:"它一直弹我关不掉")。
                // 那功能本来就停用了,状态写死 unused。
                return {
                    platform: 'darwin',
                    screen: systemPreferences.getMediaAccessStatus('screen'),
                    microphone: systemPreferences.getMediaAccessStatus('microphone'),
                    camera: systemPreferences.getMediaAccessStatus('camera'),
                    accessibility: 'unused',
                };
            },
            // /peek 的眼睛:主进程按需截一张主屏(她在手机上也能看 mac 屏幕)。
            // 一次性截图,不轮询;需要系统「屏幕录制」权限(没给时静默返回空)。
            capture: async () => {
                // 权限闸 v2:不能按"自己"查状态——桌宠是子进程,TCC 权限跟着责任爹
                // (CiCy Desktop)走,getMediaAccessStatus 查自己永远 denied。改成真试:
                // 成功就成功;失败则 5 分钟内不再试(未授权时最多 5 分钟弹一次,不轰炸)。
                if (global.__capFailAt && Date.now() - global.__capFailAt < 5 * 60 * 1000) return null;
                try {
                    const sources = await desktopCapturer.getSources({
                        types: ['screen'], thumbnailSize: { width: 1024, height: 1024 } });
                    const th = sources[0] && sources[0].thumbnail;
                    const b64 = th && !th.isEmpty() ? th.toJPEG(35).toString('base64') : null;
                    for (const s of sources) { try { s.thumbnail = null; s.appIcon = null; } catch {} }
                    if (b64) global.__capFailAt = 0;          // 成功即解除冷却
                    else global.__capFailAt = Date.now();     // 拿到空图(权限被撤?)也进冷却
                    return b64;
                } catch (e) {
                    console.error('[capture]', e);
                    global.__capFailAt = Date.now();          // 失败进 5 分钟冷却,不反复骚扰系统
                    return null;
                }
            } });
    } catch (e) {
        console.error('[server] failed to start:', e.message);
    }

    // settings 窗口**不再开机自建**:它加载的旧 DesktopPetSystem 在后台每秒轮询
    // active-win(辅助功能)+ desktopCapturer(屏幕录制),权限没给就无限弹系统授权框。
    // 大脑已是 Sherlly,这套旧观察链路纯空转——需要设置时从托盘点开(按需创建)。
    trayManager.createTray();

    // 宠物窗口：模型本来就 bundled 在 renderer/models/，所以**先把宠物拉起来**，
    // 不等 ensureModels——否则 ensureModels 一旦联网卡住（会话代理不通），窗口就永远建不出来，
    // 桌面上看不到宠物。ensureModels 只对「打包后无 bundled 模型」的场景有用，放后台补即可。
    createPetWindow().catch((e) => console.error('[pet] autostart failed:', e.message));

    // 模型包补齐（后台，不阻塞窗口）：打包产物 renderer/ 里没模型时首次从 OSS 下载。
    ensureModels({
        rendererModelsDir: path.join(basePath, 'renderer', 'models'),
        assetDir, url: MODELS_URL, log: (...a) => console.log(...a),
    }).then((how) => console.log('[models]', how))
      .catch((e) => console.error('[models] fetch failed (可在设置里重试):', e.message));

    // 一切控制走手机导演台(remote.html → /control SSE → pet.html 执行器),
    // 不再注册全局快捷键(用户 2026-07-18:「快捷键可以不需要,只要手机控制」)。
    // petEval 保留:主进程内部驱动 pet.html 用(片头结束接坠机等)。
    const petEval = async (code) => {
        // 宠物窗口可能被托盘「隐藏宠物」关掉了——快捷键按下时先把她拉回来再执行，
        // 否则按了没反应还查无此症。重建后等模型加载完（ready 事件太早，粗等 4s）。
        if (!ctx.petWindow || ctx.petWindow.isDestroyed()) {
            try { await createPetWindow(); } catch { return; }
            setTimeout(() => {
                if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                    ctx.petWindow.webContents.executeJavaScript(code).catch(() => {});
                }
            }, 4000);
            return;
        }
        ctx.petWindow.webContents.executeJavaScript(code).catch(() => {});
    };
    // 小本本:一本小巧的手账,不再占大半个屏。窗口紧贴内容——纸铺满整窗、
    // 不透明,高度由页面 postMessage 上报的真实内容高度决定(空则矮,厚则长)。
    let notebookWindow = null;
    const toggleNotebook = () => {
        const { screen } = require('electron');
        const wa = screen.getPrimaryDisplay().workAreaSize;
        if (notebookWindow && !notebookWindow.isDestroyed()) {
            if (notebookWindow.isVisible()) { notebookWindow.hide(); return false; }
            notebookWindow.webContents.reload();
            notebookWindow.show();
            return true;
        }
        const W = 440;
        const H = 560;   // 初始;加载后按内容自适应(见 ipc 'notebook-size')
        notebookWindow = new BrowserWindow({
            width: W, height: H, x: 40, y: Math.round((wa.height - H) / 2),
            frame: false, transparent: true, alwaysOnTop: true, resizable: false,
            skipTaskbar: true, hasShadow: true,
            webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false,
                preload: path.join(__dirname, 'notebook-preload.js') },
        });
        notebookWindow.setAlwaysOnTop(true, 'screen-saver');
        notebookWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        notebookWindow.loadURL('http://127.0.0.1:13004/notebook.html');
        notebookWindow.on('closed', () => { notebookWindow = null; });
        return true;
    };
    // 页面量好真实高度后回报,窗口跟着收/放(限制在屏高内),纸永远铺满、无空透明边
    ipcMain.on('notebook-size', (_e, h) => {
        if (!notebookWindow || notebookWindow.isDestroyed()) return;
        const { screen } = require('electron');
        const wa = screen.getPrimaryDisplay().workAreaSize;
        const H = Math.max(320, Math.min(Math.round(h) + 4, Math.round(wa.height * 0.9)));
        const [w] = notebookWindow.getSize();
        notebookWindow.setSize(w, H, false);
        notebookWindow.setPosition(40, Math.round((wa.height - H) / 2));
    });
    ipcMain.handle('toggle-notebook', () => toggleNotebook());
    // Alt+T = 实时片头:全屏窗口现场播 6s 片头动画(titlecard.html,纯 CSS 零渲染),
    // 关窗后无缝接 EP1 坠机预演——一镜到底,拍到的就是真实表演。点击可跳过。
    let titlecardWindow = null;
    const playTitleCard = () => {
        if (titlecardWindow && !titlecardWindow.isDestroyed()) return false;
        const { screen } = require('electron');
        const b = screen.getPrimaryDisplay().bounds;
        titlecardWindow = new BrowserWindow({
            x: b.x, y: b.y, width: b.width, height: b.height,
            frame: false, transparent: false, alwaysOnTop: true,
            skipTaskbar: true, hasShadow: false, resizable: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
        });
        titlecardWindow.setAlwaysOnTop(true, 'screen-saver');
        titlecardWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        titlecardWindow.loadURL('http://127.0.0.1:13004/titlecard.html');
        titlecardWindow.on('closed', () => {
            titlecardWindow = null;
            petEval('window.petScript && window.petScript.demo && window.petScript.demo()');
        });
        return true;
    };
    ipcMain.handle('play-titlecard', () => playTitleCard());
    // 语音对话要用麦克风：mac 首次要向系统讨权限（记住后不再弹）
    if (process.platform === 'darwin') {
        try { require('electron').systemPreferences.askForMediaAccess('microphone').catch(() => {}); } catch {}
    }

});

app.on('window-all-closed', () => {
    if (ctx.tray) return;
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    ctx.isQuitting = true;
});
