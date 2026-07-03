const { app, BrowserWindow, Menu, shell, ipcMain, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Globals ───────────────────────────────────────────────────────────────────
let mainWindow = null;
const PORT     = 4788; // internal only — not exposed externally

// ── Start the embedded Express server ────────────────────────────────────────
function startServer() {
  // Set port BEFORE requiring server.js so it picks it up via process.env.PORT
  process.env.PORT = String(PORT);

  // server.js boots and calls server.listen() automatically
  try {
    require('./server.js');
    console.log(`[PetnanAI] Embedded server started on port ${PORT}`);
  } catch (err) {
    console.error('[PetnanAI] Server failed to start:', err.message);
  }
}

// ── Wait for the server to be ready ──────────────────────────────────────────
function waitForServer(url, maxMs = 8000) {
  return new Promise((resolve) => {
    const http     = require('http');
    const started  = Date.now();
    const interval = setInterval(() => {
      http.get(url, (res) => {
        if (res.statusCode < 500) {
          clearInterval(interval);
          resolve(true);
        }
        res.resume();
      }).on('error', () => {
        // Not ready yet
        if (Date.now() - started > maxMs) {
          clearInterval(interval);
          resolve(false); // open window anyway
        }
      });
    }, 150);
  });
}

// ── Create the main window ────────────────────────────────────────────────────
function createWindow() {
  nativeTheme.themeSource = 'dark';

  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const iconExists = fs.existsSync(iconPath);

  mainWindow = new BrowserWindow({
    width:           1200,
    height:          820,
    minWidth:        820,
    minHeight:       580,
    title:           'PetnanAI',
    backgroundColor: '#131314',
    // Custom titlebar — the HTML handles the title bar UI
    titleBarStyle:   process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform !== 'darwin' ? {
      color:       '#1e1f20',
      symbolColor: '#8ab4f8',
      height:      36,
    } : false,
    ...(iconExists ? { icon: iconPath } : {}),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${PORT}/petnan`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Application menu ──────────────────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{ label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ]}] : []),
    { label: 'File', submenu: [
      { label: 'New Conversation', accelerator: 'CmdOrCtrl+N',
        click: () => mainWindow?.webContents.executeJavaScript('newChat && newChat()') },
      { type: 'separator' },
      { label: 'Settings', accelerator: 'CmdOrCtrl+,',
        click: () => mainWindow?.webContents.executeJavaScript('openSettings && openSettings()') },
      { type: 'separator' },
      { label: 'Export Conversation',
        click: () => mainWindow?.webContents.executeJavaScript('exportConversation && exportConversation()') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit', label: 'Exit' },
    ]},
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn',  accelerator: 'CmdOrCtrl+=' },
      { role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { label: 'Developer Tools', accelerator: 'F12',
        click: () => mainWindow?.webContents.toggleDevTools() },
    ]},
    { label: 'Help', submenu: [
      { label: 'About PetnanAI', click: () => {
        dialog.showMessageBox(mainWindow, {
          type:    'info',
          title:   'About PetnanAI',
          message: 'PetnanAI — Version 1.0.0',
          detail:  'Your personal AI assistant that knows everything.\n\nPowered by Groq + Llama 3.3.',
          buttons: ['OK'],
        });
      }},
    ]},
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-app-path',    () => app.getPath('userData'));

ipcMain.handle('show-save-dialog', async (_, opts) => {
  return dialog.showSaveDialog(mainWindow, opts);
});

ipcMain.handle('save-file', async (_, { filePath, data }) => {
  try {
    fs.writeFileSync(filePath, data, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  startServer();
  await waitForServer(`http://localhost:${PORT}/api/health`);
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
