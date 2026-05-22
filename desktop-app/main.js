const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } = require('electron');
const path = require('path');

let mainWindow;
let tray;
let isQuitting = false;

const fs = require('fs');

// Create the main application window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 800,
    minHeight: 600,
    title: "Vệ Binh Cyber-Shield - Aegis Command Center",
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      webSecurity: false // Allow loading remote assets from VPS
    }
  });

  // Check if there is a saved VPS IP config
  const configPath = path.join(__dirname, 'vps_config.json');
  let startUrl = null;
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.vpsIp) {
        startUrl = config.vpsIp;
      }
    } catch (e) {
      console.error('Error reading vps_config.json:', e);
    }
  }

  if (startUrl && startUrl.startsWith('http')) {
    console.log('[Electron] Loading saved VPS URL directly:', startUrl);
    mainWindow.loadURL(startUrl);
  } else {
    console.log('[Electron] Loading bridge configuration page.');
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
  }

  // Handle remote URL load failures (fallback to local config page if VPS is down or IP changed)
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    if (validatedURL && validatedURL.startsWith('http')) {
      console.log('[Electron] Failed to load remote VPS URL, falling back to local bridge configuration.');
      mainWindow.loadFile(path.join(__dirname, 'index.html'));
    }
  });

  // Custom application menu
  const menuTemplate = [
    {
      label: 'Ứng dụng',
      submenu: [
        {
          label: 'Cấu hình lại VPS',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => {
            mainWindow.loadFile(path.join(__dirname, 'index.html'));
          }
        },
        { type: 'separator' },
        {
          label: 'Reload trang',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            mainWindow.webContents.reload();
          }
        },
        {
          label: 'Mở DevTools',
          accelerator: 'F12',
          click: () => {
            mainWindow.webContents.toggleDevTools();
          }
        },
        { type: 'separator' },
        {
          label: 'Thu nhỏ xuống khay',
          click: () => {
            mainWindow.hide();
          }
        },
        {
          label: 'Thoát',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Chỉnh sửa',
      submenu: [
        { label: 'Undo', role: 'undo' },
        { label: 'Redo', role: 'redo' },
        { type: 'separator' },
        { label: 'Cắt', role: 'cut' },
        { label: 'Sao chép', role: 'copy' },
        { label: 'Dán', role: 'paste' },
        { label: 'Chọn tất cả', role: 'selectall' }
      ]
    },
    {
      label: 'Trợ giúp',
      submenu: [
        {
          label: 'Tài liệu hướng dẫn',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://github.com');
          }
        },
        {
          label: 'Thông tin phiên bản',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Vệ Binh Cyber-Shield - Aegis Command Center',
              message: 'Vệ Binh Cyber-Shield - Hệ Thống Livestream YT',
              detail: 'Phiên bản 1.0.0\nĐược phát triển bởi Antigravity.'
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  // Capture close event and hide to system tray instead of exiting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Create the System Tray icon and menu
function createTray() {
  // Use a generic beautiful dot icon or custom icon if exists
  const iconPath = path.join(__dirname, 'icon.png');
  let trayImage;
  
  try {
    trayImage = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch (e) {
    // Fallback if icon is missing
    trayImage = nativeImage.createEmpty();
  }

  tray = new Tray(trayImage);
  tray.setToolTip('Vệ Binh Cyber-Shield Command Center');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Hiển thị bảng điều khiển',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: 'Cấu hình lại VPS',
      click: () => {
        mainWindow.show();
        mainWindow.loadFile(path.join(__dirname, 'index.html'));
      }
    },
    { type: 'separator' },
    {
      label: 'Thoát hoàn toàn',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Double click tray icon to restore window
  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

// Manage lifecycle
app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Auto-start configuration IPC handlers if needed
ipcMain.on('set-auto-start', (event, enable) => {
  app.setLoginItemSettings({
    openAtLogin: enable,
    path: app.getPath('exe')
  });
});

// IPC handler to return to the local connection bridge configuration page
ipcMain.on('go-to-config', () => {
  if (mainWindow) {
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
  }
});

