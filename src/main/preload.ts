import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getScreenSourceId: () => ipcRenderer.invoke('get-screen-source'),
  logError: (msg: string) => ipcRenderer.send('log-error', msg),
});