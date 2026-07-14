import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  mouseMove: (x: number, y: number) => ipcRenderer.send('mouse-move', x, y),
  mouseClick: (button: number) => ipcRenderer.send('mouse-click', button),
  mouseScroll: (delta: number) => ipcRenderer.send('mouse-scroll', delta),
  keyPress: (keycode: number) => ipcRenderer.send('key-press', keycode),
});