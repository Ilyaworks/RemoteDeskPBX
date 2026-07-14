import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Управление мышью/клавиатурой (client)
  mouseMove: (x: number, y: number) => ipcRenderer.send('mouse-move', x, y),
  mouseClick: (button: number) => ipcRenderer.send('mouse-click', button),
  mouseScroll: (delta: number) => ipcRenderer.send('mouse-scroll', delta),
  keyPress: (keycode: number) => ipcRenderer.send('key-press', keycode),

  // T7: сохранение скриншота в Документы (employee)
  saveScreenshot: (dataUrl: string, code: string) => ipcRenderer.invoke('save-screenshot', dataUrl, code),

  // T1: сохранение учётных данных сотрудника (employee, safeStorage)
  credsSave: (data: { login: string; password: string }) => ipcRenderer.invoke('creds-save', data),
  credsLoad: (): Promise<{ login: string; password: string } | null> => ipcRenderer.invoke('creds-load'),
  credsClear: () => ipcRenderer.invoke('creds-clear'),

  // T2: плавающее окно чата у клиента (мост между окном приложения и окном чата)
  showChat: (msg: { from: string; text: string }) => ipcRenderer.send('chat-show', msg),
  hideChat: () => ipcRenderer.send('chat-hide'),
  chatSend: (text: string) => ipcRenderer.send('chat-send', text),
  onChatDisplay: (cb: (msg: { from: string; text: string }) => void) =>
    ipcRenderer.on('chat-display', (_e, msg) => cb(msg)),
  onChatOutgoing: (cb: (text: string) => void) =>
    ipcRenderer.on('chat-outgoing', (_e, text) => cb(text)),
});
