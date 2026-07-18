// 小本本窗口专用极简 preload:只暴露"上报内容高度",让主进程把窗口收到贴合内容。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nbHost', {
  reportHeight: (h) => ipcRenderer.send('notebook-size', h),
});
