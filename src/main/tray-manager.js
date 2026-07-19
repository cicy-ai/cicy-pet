/**
 * TrayManager — System tray icon and context menu.
 * Extracted from main.js lines 188-231.
 */
function createTrayManager(ctx, deps) {
    // deps: { Tray, Menu, path, mt, createSettingsWindow, basePath }
    const { Tray, Menu, path, mt, basePath } = deps;

    function createTray() {
        // macOS 的托盘图标要 22x22、带 alpha 的黑色字形并标记 template image，系统按
        // 菜单栏明暗自动反色；Windows 没有 template 概念，同一张黑字形在任务栏上就是
        // 一坨黑 —— Windows 用彩色 app-icon（16x16 由系统从 ico/png 里缩）。
        const { nativeImage } = require('electron');
        let icon;
        if (process.platform === 'win32') {
            icon = nativeImage.createFromPath(path.join(basePath, 'assets', 'app-icon.ico'));
        } else {
            icon = nativeImage.createFromPath(path.join(basePath, 'assets', 'trayTemplate.png'));
            icon.setTemplateImage(true);
        }
        ctx.tray = new Tray(icon);
        ctx.tray.setToolTip('CiCy Pet');
        // 点托盘图标只弹菜单,不直接开设置窗(用户 2026-07-19:「show setting 时再显示」)。
        // mac 上 setContextMenu 后左右键默认都弹菜单,无需 click 处理。
        updateTrayMenu();
    }

    function updateTrayMenu() {
        if (!ctx.tray) return;
        const hasPet = ctx.petWindow && !ctx.petWindow.isDestroyed();
        const template = [
            { label: mt('tray.showSettings'), click: () => {
                if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                    ctx.settingsWindow.show();
                    ctx.settingsWindow.focus();
                } else {
                    deps.createSettingsWindow();
                }
            }},
            // 固定两项，不做「切换」：窗口可能被 Alt+R/甩飞挪到屏幕外，托盘不知道，
            // 切换式菜单的标签会跟实际状态脱节（这就是「hide 之后 show 不出来」）。
            // createPetWindow 对活着的窗口会自动拉回屏内并 show。
            { label: mt('tray.showPet'), click: async () => {
                if (deps.createPetWindow) await deps.createPetWindow();
                deps.recallToDesktop && deps.recallToDesktop();   // 她在手机上?一并召回桌面
                updateTrayMenu();
            }},
            { label: mt('tray.hidePet'), enabled: hasPet, click: () => {
                if (ctx.petWindow && !ctx.petWindow.isDestroyed()) ctx.petWindow.close();
            }},
            { type: 'separator' },
            { label: mt('tray.quit'), click: () => {
                ctx.isQuitting = true;
                deps.app.quit();
            }}
        ];
        ctx.tray.setContextMenu(Menu.buildFromTemplate(template));
    }

    return { createTray, updateTrayMenu };
}

module.exports = { createTrayManager };
