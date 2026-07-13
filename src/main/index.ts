import { app, BrowserWindow, desktopCapturer, session } from 'electron';
import path from 'path';

// ============ CLIENT MODE ============
async function createWindow() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, callback) => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 320, height: 240 },
      });
      if (sources.length > 0) {
        callback({ video: sources[0], audio: 'disable' } as any);
      }
    },
    { useSystemPicker: true } as any,
  );

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'RemoteDeskPBX Client',
  });

  if (process.env.NODE_ENV === 'development') {
    await mainWindow.loadURL('http://localhost:8080');
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });