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

    // 屏幕录制权限闸:未授权时静默失败,不触发系统弹窗(每次 getSources 未授权都会弹一次)
    function screenGranted() {
        if (process.platform !== 'darwin') return true;
        try { return require('electron').systemPreferences.getMediaAccessStatus('screen') === 'granted'; }
        catch { return false; }
    }

    ipcMain.handle('get-screen-capture', async (event, targetTitle) => {
        if (!screenGranted()) return null;
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
        if (!screenGranted()) return null;
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

    // active-win 彻底停用(2026-07-19):它是旧「观察主人窗口」系统的引擎,被设置页每秒轮询;
    // 每次运行都向系统要辅助功能+屏幕录制,权限不齐就每秒弹一次授权框("怎么还有"事件)。
    // 大脑已是 Sherlly,这套观察不再需要——IPC 保留但恒返回失败,绝不碰系统 API。
    ipcMain.handle('get-active-window', async () => ({ success: false, error: 'disabled' }));
    ipcMain.handle('get-open-windows', async () => ({ success: false, error: 'disabled' }));

    ipcMain.handle('get-system-idle-time', () => {
        return powerMonitor.getSystemIdleTime();
    });
}

module.exports = { registerScreenCapture };
