/**
 * Window Manager — extracted from main.js
 * Handles settings window, pet window, chat bubble, and window control IPC handlers.
 */

const CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
    "connect-src * data: blob:; img-src * data: file: blob:; " +
    "media-src * data: blob:; font-src 'self' data:";

function applyCSP(win) {
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [CSP]
            }
        });
    });
}

function registerWindowHandlers(ctx, ipcMain, deps) {
    // deps: { BrowserWindow, path, screen, updateTrayMenu, basePath }

    function createSettingsWindow() {
        ctx.settingsWindow = new deps.BrowserWindow({
            width: 480,
            height: 600,
            frame: true,
            resizable: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: deps.path.join(deps.basePath, 'preload.js')
            }
        });
        // macOS: 否则窗口只属于它出生的那个 Space，被全屏应用挡住时看不见也切不过去。
        ctx.settingsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        ctx.settingsWindow.setAlwaysOnTop(true, 'floating');

        // 设置界面由进程内服务（:13004）提供，和 pet.html 同源，靠 BroadcastChannel
        // 直接联动（换角色/换音色实时生效）。服务没起来时兜底直接读文件。
        const settingsUrl = process.env.SETTINGS_URL || 'http://127.0.0.1:13004/settings.html';
        ctx.settingsWindow.loadURL(settingsUrl).catch((e) => {
            console.error('[settings] loadURL failed, falling back:', e.message);
            ctx.settingsWindow.loadFile(deps.path.join(deps.basePath, 'renderer', 'settings.html'));
        });
        ctx.settingsWindow.on('close', (e) => {
            if (!ctx.isQuitting) {
                e.preventDefault();
                ctx.settingsWindow.hide();
                return;
            }
        });
        ctx.settingsWindow.on('closed', () => { ctx.settingsWindow = null; });
        applyCSP(ctx.settingsWindow);
    }

    // ========== Pet Window ==========

    async function createPetWindow(data) {
        try {
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                // 「显示宠物」一步到位:现身;窗口若被甩到屏外,顺便拉回右下角(同一个功能)
                const { screen } = require('electron');
                const wa = screen.getPrimaryDisplay().workAreaSize;
                const b = ctx.petWindow.getBounds();
                const offscreen = b.x > wa.width - 40 || b.x + b.width < 40 ||
                                  b.y > wa.height - 40 || b.y + b.height < 40;
                if (offscreen) ctx.petWindow.setPosition(wa.width - 220, wa.height - 220);
                ctx.petWindow.show();
                ctx.petWindow.focus();
                return { success: true, message: 'already open' };
            }
            if (data) ctx.characterData = { ...ctx.characterData, ...data };

            ctx.petWindow = new deps.BrowserWindow({
                width: 340, height: 420,
                frame: false, transparent: true, alwaysOnTop: true,
                resizable: true, minimizable: false, maximizable: false,
                fullscreenable: false, skipTaskbar: true,
                hasShadow: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: deps.path.join(deps.basePath, 'preload.js'),
                    // 拍摄剧本会把窗口藏到屏幕外再飞进来——离屏时 macOS 会掐 rAF，
                    // 飞行动画会卡死在半路。关掉节流，离屏也照常出帧。
                    backgroundThrottling: false
                }
            });
            ctx.petWindow.setAlwaysOnTop(true, 'screen-saver');
            ctx.petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

            // 渲染交给 live2d-standalone 的 pet.html（本地服务 :13004）——它自带
            // 可用的模型、口型和 TTS。preload 照常注入，pet.html 里依旧能用
            // electronAPI 拖窗、弹右键菜单。服务没起来时兜底直接读文件。
            // entrance=1：每次启动 Mao 都从屏幕外飞进来落到桌面。
            // device=<平台>：给这台唯一身份(mac/windows/linux)——漫游/goto 靠它区分,
            // 不能靠「有 electronAPI 就叫 mac」(Windows 的 Electron 也有 electronAPI 会撞车)。
            const dev = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
            const petUrl = process.env.PET_URL || `http://127.0.0.1:13004/pet.html?entrance=1&device=${dev}`;
            ctx.petWindow.loadURL(petUrl).catch((e) => {
                console.error('[pet] loadURL failed, falling back:', e.message);
                ctx.petWindow.loadFile(deps.path.join(deps.basePath, 'renderer', 'pet.html'));
            });
            applyCSP(ctx.petWindow);

            const { screen } = require('electron');
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width, height } = primaryDisplay.workAreaSize;
            ctx.petWindow.setPosition(width - 220, height - 220);

            ctx.petWindow.on('closed', () => {
                ctx.petWindow = null;
                if (ctx.chatBubbleWindow && !ctx.chatBubbleWindow.isDestroyed()) ctx.chatBubbleWindow.close();
                if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                    ctx.settingsWindow.webContents.send('pet-window-closed');
                }
                deps.updateTrayMenu();
            });

            // Hide settings window to tray when pet starts
            if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                ctx.settingsWindow.hide();
            }
            deps.updateTrayMenu();

            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    ipcMain.handle('create-pet-window', (_event, data) => createPetWindow(data));

    ipcMain.handle('close-pet-window', async () => {
        try {
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) ctx.petWindow.close();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-pet-character', async (event, data) => {
        try {
            if (data) ctx.characterData = { ...ctx.characterData, ...data };
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                ctx.petWindow.webContents.send('character-update', ctx.characterData);
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-character-data', async () => {
        return ctx.characterData;
    });

    // ========== Window Control ==========

    ipcMain.handle('set-window-size', async (event, width, height) => {
        try {
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) ctx.petWindow.setSize(width, height);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('set-window-position', async (event, x, y, w, h) => {
        try {
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                if (w && h) {
                    ctx.petWindow.setBounds({ x, y, width: w, height: h });
                } else {
                    ctx.petWindow.setPosition(x, y);
                }
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-window-bounds', async () => {
        if (ctx.petWindow && !ctx.petWindow.isDestroyed()) return ctx.petWindow.getBounds();
        return { x: 0, y: 0, width: 200, height: 200 };
    });

    ipcMain.handle('get-window-position', async () => {
        if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
            const pos = ctx.petWindow.getPosition();
            return { x: pos[0], y: pos[1] };
        }
        return { x: 0, y: 0 };
    });

    // ========== Chat Bubble ==========

    ipcMain.handle('show-pet-chat', async (event, message, autoCloseTime = 8000) => {
        try {
            if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return { success: false, error: 'no pet window' };

            // Close existing bubble
            if (ctx.chatBubbleWindow && !ctx.chatBubbleWindow.isDestroyed()) {
                ctx.chatBubbleWindow.close();
                ctx.chatBubbleWindow = null;
            }

            const petBounds = ctx.petWindow.getBounds();

            ctx.chatBubbleWindow = new deps.BrowserWindow({
                width: 250, height: 80,
                x: petBounds.x + (petBounds.width - 250) / 2,
                y: petBounds.y - 80 + petBounds.height * 0.25,
                frame: false, transparent: true, alwaysOnTop: true,
                resizable: true, minimizable: false, maximizable: false,
                fullscreenable: false, skipTaskbar: true, focusable: false,
                show: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: deps.path.join(deps.basePath, 'preload.js')
                }
            });
            ctx.chatBubbleWindow.setAlwaysOnTop(true, 'screen-saver');
            ctx.chatBubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            await ctx.chatBubbleWindow.loadFile(deps.path.join(deps.basePath, 'pet-chat-bubble.html'));
            applyCSP(ctx.chatBubbleWindow);

            setTimeout(() => {
                if (ctx.chatBubbleWindow && !ctx.chatBubbleWindow.isDestroyed()) {
                    ctx.chatBubbleWindow.webContents.send('chat-bubble-message', { message, autoCloseTime });
                }
            }, 500);

            ctx.chatBubbleWindow.on('closed', () => { ctx.chatBubbleWindow = null; });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-chat-bubble', async () => {
        try {
            if (ctx.chatBubbleWindow && !ctx.chatBubbleWindow.isDestroyed()) ctx.chatBubbleWindow.close();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('resize-chat-bubble', async (event, width, height) => {
        try {
            if (ctx.chatBubbleWindow && !ctx.chatBubbleWindow.isDestroyed() && ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                const petBounds = ctx.petWindow.getBounds();
                ctx.chatBubbleWindow.setBounds({
                    x: Math.round(petBounds.x + (petBounds.width - width) / 2),
                    y: Math.round(petBounds.y - height + petBounds.height * 0.25),
                    width: width, height: height
                });
                if (!ctx.chatBubbleWindow.isVisible()) {
                    ctx.chatBubbleWindow.showInactive();
                }
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    return { createSettingsWindow, createPetWindow };
}

module.exports = { registerWindowHandlers };
