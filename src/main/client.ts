import { app, BrowserWindow, desktopCapturer, session, ipcMain, Menu, screen } from 'electron';
import path from 'path';
import { mouse, keyboard, Button, Key } from '@nut-tree-fork/nut-js';

// ============ Mouse & Keyboard via nut-js ============

let moveTimer: NodeJS.Timeout | null = null;
let moveX = 0;
let moveY = 0;

ipcMain.on('mouse-move', (_e, x: number, y: number) => {
  moveX = Math.round(x);
  moveY = Math.round(y);
  if (!moveTimer) {
    moveTimer = setTimeout(async () => {
      moveTimer = null;
      try { await mouse.setPosition({ x: moveX, y: moveY }); }
      catch (err) { console.error('mouse-move error:', err); }
    }, 16);
  }
});

ipcMain.on('mouse-click', async (_e, button: number) => {
  try { await mouse.click(button === 2 ? Button.RIGHT : Button.LEFT); }
  catch (err) { console.error('mouse-click error:', err); }
});

ipcMain.on('mouse-scroll', async (_e, delta: number) => {
  try {
    if (delta > 0) await mouse.scrollUp(1);
    else await mouse.scrollDown(1);
  } catch (err) { console.error('mouse-scroll error:', err); }
});

const keycodeToKey: Record<number, Key> = {
  30: Key.A, 48: Key.B, 46: Key.C, 32: Key.D, 18: Key.E, 33: Key.F,
  34: Key.G, 35: Key.H, 23: Key.I, 36: Key.J, 37: Key.K, 38: Key.L,
  50: Key.M, 49: Key.N, 24: Key.O, 25: Key.P, 16: Key.Q, 19: Key.R,
  31: Key.S, 20: Key.T, 22: Key.U, 47: Key.V, 17: Key.W, 45: Key.X,
  21: Key.Y, 44: Key.Z,
  2: Key.Num1, 3: Key.Num2, 4: Key.Num3, 5: Key.Num4, 6: Key.Num5,
  7: Key.Num6, 8: Key.Num7, 9: Key.Num8, 10: Key.Num9, 11: Key.Num0,
  71: Key.NumPad7, 72: Key.NumPad8, 73: Key.NumPad9,
  75: Key.NumPad4, 76: Key.NumPad5, 77: Key.NumPad6,
  79: Key.NumPad1, 80: Key.NumPad2, 81: Key.NumPad3,
  82: Key.NumPad0, 55: Key.Multiply, 78: Key.Add,
  74: Key.Subtract, 83: Key.Decimal, 3637: Key.Divide,
  59: Key.F1, 60: Key.F2, 61: Key.F3, 62: Key.F4,
  63: Key.F5, 64: Key.F6, 65: Key.F7, 66: Key.F8,
  67: Key.F9, 68: Key.F10, 87: Key.F11, 88: Key.F12,
  14: Key.Backspace, 15: Key.Tab, 28: Key.Return, 103: Key.Enter,
  42: Key.LeftShift, 29: Key.LeftControl, 56: Key.LeftAlt,
  58: Key.CapsLock, 57: Key.Space, 1: Key.Escape,
  57419: Key.Left, 57416: Key.Up, 57421: Key.Right, 57424: Key.Down,
  3655: Key.Home, 3667: Key.Delete, 3666: Key.Insert, 3657: Key.PageUp,
  3665: Key.PageDown, 3663: Key.End,
  39: Key.Minus, 13: Key.Equal, 51: Key.Comma,
  52: Key.Period, 53: Key.Slash, 26: Key.LeftBracket,
  27: Key.RightBracket, 43: Key.Backslash, 41: Key.Grave,
};

ipcMain.on('key-press', async (_e, keycode: number) => {
  try {
    const key = keycodeToKey[keycode];
    if (key !== undefined) {
      await keyboard.pressKey(key);
      await keyboard.releaseKey(key);
    }
  } catch (err) { console.error('key-press error:', err); }
});

// ============ T2: плавающее окно чата у клиента ============
let mainWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
const chatQueue: { from: string; text: string }[] = [];

function createChatWindow(): BrowserWindow {
  if (chatWindow && !chatWindow.isDestroyed()) return chatWindow;
  const work = screen.getPrimaryDisplay().workAreaSize;
  const W = 320, H = 440;
  chatWindow = new BrowserWindow({
    width: W,
    height: H,
    x: Math.max(0, work.width - W - 20),
    y: Math.max(0, work.height - H - 20),
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    title: 'Чат поддержки',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  chatWindow.setAlwaysOnTop(true, 'screen-saver');
  chatWindow.loadFile(path.join(__dirname, '../../resources/chat.html'));
  chatWindow.webContents.on('did-finish-load', () => {
    while (chatQueue.length && chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('chat-display', chatQueue.shift());
    }
  });
  chatWindow.on('closed', () => { chatWindow = null; });
  return chatWindow;
}

// Клиент получил сообщение от сотрудника → показать в плавающем окне
ipcMain.on('chat-show', (_e, msg: { from: string; text: string }) => {
  const w = createChatWindow();
  if (w.webContents.isLoadingMainFrame()) chatQueue.push(msg);
  else w.webContents.send('chat-display', msg);
  if (!w.isVisible()) w.showInactive();
  w.setAlwaysOnTop(true, 'screen-saver');
});

ipcMain.on('chat-hide', () => {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.hide();
});

// Пользователь набрал сообщение в плавающем окне → передать в окно приложения (DataChannel)
ipcMain.on('chat-send', (_e, text: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat-outgoing', text);
});

// ============ CLIENT WINDOW ============
async function createWindow() {
  mouse.config.autoDelayMs = 0;
  Menu.setApplicationMenu(null);

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, callback) => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 320, height: 240 },
      });
      if (sources.length > 0) {
        callback({ video: sources[0], audio: 'loopback' } as any);
      }
    },
    { useSystemPicker: true } as any,
  );

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 750,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'RemoteDeskPBX Client',
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.env.NODE_ENV === 'development') {
    await mainWindow.loadURL('http://localhost:8080');
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../client/index.html'));
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});