/**
 * ScreenCapture — Screen capture, window detection, idle time.
 * Extracted from main.js lines 488-530.
 */

/** Release NativeImage references to free GPU/process memory sooner */
function releaseSources(sources) {
    if (!sources) return;
    for (const s of sources) try { s.thumbnail = null; s.appIcon = null; } catch {}
}

function registerScreenCapture(ctx, ipcMain, deps) {
    // deps: { desktopCapturer, powerMonitor }
    const { desktopCapturer, powerMonitor } = deps;

    ipcMain.handle('get-screen-capture', async (event, targetTitle) => {
        let winSources = null, sources = null;
        try {
            if (targetTitle) {
                winSources = await desktopCapturer.getSources({
                    types: ['window'], thumbnailSize: { width: 512, height: 512 }
                });
                const match = winSources.find(s => s.name === targetTitle);
                if (match) {
                    const result = match.thumbnail.toJPEG(30).toString('base64');
                    releaseSources(winSources);
                    return result;
                }
                releaseSources(winSources);
                winSources = null;
            }
            sources = await desktopCapturer.getSources({
                types: ['screen'], thumbnailSize: { width: 512, height: 512 }
            });
            if (sources.length > 0) {
                const result = sources[0].thumbnail.toJPEG(30).toString('base64');
                releaseSources(sources);
                return result;
            }
            releaseSources(sources);
            return null;
        } catch (error) {
            releaseSources(winSources);
            releaseSources(sources);
            console.error('Screen capture failed:', error);
            return null;
        }
    });

    ipcMain.handle('get-screen-capture-hq', async (event, targetTitle) => {
        let winSources = null, sources = null;
        try {
            if (targetTitle) {
                winSources = await desktopCapturer.getSources({
                    types: ['window'], thumbnailSize: { width: 768, height: 768 }
                });
                const match = winSources.find(s => s.name === targetTitle);
                if (match) {
                    const result = match.thumbnail.toJPEG(40).toString('base64');
                    releaseSources(winSources);
                    return result;
                }
                releaseSources(winSources);
                winSources = null;
            }
            sources = await desktopCapturer.getSources({
                types: ['screen'], thumbnailSize: { width: 768, height: 768 }
            });
            if (sources.length > 0) {
                const result = sources[0].thumbnail.toJPEG(40).toString('base64');
                releaseSources(sources);
                return result;
            }
            releaseSources(sources);
            return null;
        } catch (error) {
            releaseSources(winSources);
            releaseSources(sources);
            console.error('HQ screen capture failed:', error);
            return null;
        }
    });

    // active-win 的原生二进制每次运行都会向 macOS 讨辅助功能权限——settings.html 里的旧
    // DesktopPetSystem 每秒轮询一次,权限没给就每秒弹一次「CiCy Desktop 想控制这台电脑」。
    // 闸门:未授权(false = 只查不弹)直接返回失败,绝不触发弹窗;用户真要用这功能,
    // 去系统设置手动授权后自动恢复。
    function axTrusted() {
        if (process.platform !== 'darwin') return true;
        try { return require('electron').systemPreferences.isTrustedAccessibilityClient(false); }
        catch { return false; }
    }

    ipcMain.handle('get-active-window', async () => {
        if (!axTrusted()) return { success: false, error: 'accessibility not granted' };
        try {
            const activeWin = (await import('active-win')).default;
            const result = await activeWin();
            if (result) return { success: true, data: result };
            return { success: false, error: 'no active window' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-open-windows', async () => {
        if (!axTrusted()) return { success: false, error: 'accessibility not granted' };
        try {
            const { getOpenWindows } = await import('active-win');
            const windows = await getOpenWindows();
            return { success: true, data: windows || [] };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-system-idle-time', () => {
        return powerMonitor.getSystemIdleTime();
    });
}

module.exports = { registerScreenCapture };
