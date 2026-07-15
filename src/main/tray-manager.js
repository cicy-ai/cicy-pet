/**
 * TrayManager — System tray icon and context menu.
 * Extracted from main.js lines 188-231.
 */
function createTrayManager(ctx, deps) {
    // deps: { Tray, Menu, path, mt, createSettingsWindow, basePath }
    const { Tray, Menu, path, mt, basePath } = deps;

    function createTray() {
        // app-icon.png 是一张 299x304、没有 alpha 通道的角色截图 —— 直接塞给 Tray，
        // 菜单栏里就是一个不透明的长方形色块。macOS 的托盘图标要 22x22（@2x 44x44）、
        // 带 alpha，并且标记成 template image，系统才会按菜单栏明暗自动反色。
        const { nativeImage } = require('electron');
        const icon = nativeImage.createFromPath(path.join(basePath, 'assets', 'trayTemplate.png'));
        icon.setTemplateImage(true);
        ctx.tray = new Tray(icon);
        ctx.tray.setToolTip('CiCy Pet');
        ctx.tray.on('click', () => {
            if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                ctx.settingsWindow.show();
                ctx.settingsWindow.focus();
            } else {
                deps.createSettingsWindow();
            }
        });
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
            { label: hasPet ? mt('tray.hidePet') : mt('tray.showPet'), click: async () => {
                if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                    ctx.petWindow.close();
                    return;
                }
                // 「显示宠物」原来只是把设置窗口弹出来 —— 指望你再去设置里导入一次模型，
                // 由那条路去触发 create-pet-window。设置界面换掉之后那条路没了，于是点过
                // 「隐藏宠物」就再也回不来。这里直接把窗口建回来。
                if (deps.createPetWindow) {
                    await deps.createPetWindow();
                } else if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                    ctx.settingsWindow.show();
                    ctx.settingsWindow.focus();
                }
                updateTrayMenu();
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
