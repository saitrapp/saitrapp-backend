// electron/tray-manager.js
const { app, Menu, Tray, BrowserWindow, shell } = require('electron');
const path = require('path');

/**
 * TrayManager handles the system tray integration for SAITRAPP
 * Provides quick access to common functions and minimizes to tray instead of closing
 */
class TrayManager {
  /**
   * Create a new TrayManager instance
   * @param {BrowserWindow} mainWindow - Reference to the main application window
   * @param {string} iconPath - Path to the tray icon
   */
  constructor(mainWindow, iconPath) {
    this.tray = null;
    this.mainWindow = mainWindow;
    this.iconPath = iconPath || path.join(__dirname, '../public/assets/icons/tray-icon.png');
    this.isQuitting = false;
  }
  
  /**
   * Initialize the system tray
   * @returns {void}
   */
  init() {
    if (this.tray) return;
    
    try {
      this.tray = new Tray(this.iconPath);
      this.tray.setToolTip('SAITRAPP - Intelligent Trading');
      this.createContextMenu();
      
      this.tray.on('click', () => {
        this.toggleMainWindow();
      });
      
      // Handle window behavior
      if (this.mainWindow) {
        this.mainWindow.on('close', (event) => {
          if (!this.isQuitting) {
            event.preventDefault();
            this.mainWindow.hide();
            return false;
          }
        });
      }
      
      app.on('before-quit', () => {
        this.isQuitting = true;
      });
      
      console.log('System tray initialized');
    } catch (error) {
      console.error('Failed to initialize system tray:', error);
    }
  }
  
  /**
   * Create the context menu for the tray icon
   * @private
   */
  createContextMenu() {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open SAITRAPP',
        click: () => {
          this.showMainWindow();
        }
      },
      { type: 'separator' },
      {
        label: 'Trading Status',
        submenu: [
          {
            label: 'Active Positions',
            click: () => {
              this.mainWindow.webContents.send('app:show-view', 'active-positions');
              this.showMainWindow();
            }
          },
          {
            label: 'Recent Signals',
            click: () => {
              this.mainWindow.webContents.send('app:show-view', 'signals');
              this.showMainWindow();
            }
          }
        ]
      },
      { type: 'separator' },
      {
        label: 'System',
        submenu: [
          {
            label: 'Check for Updates',
            click: () => {
              this.mainWindow.webContents.send('app:check-updates');
            }
          },
          {
            label: 'Open Log Files',
            click: () => {
              const logPath = path.join(app.getPath('userData'), 'logs');
              shell.openPath(logPath).catch(err => {
                console.error('Failed to open log path:', err);
              });
            }
          }
        ]
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          this.isQuitting = true;
          app.quit();
        }
      }
    ]);
    
    this.tray.setContextMenu(contextMenu);
  }
  
  /**
   * Show the main application window
   * @public
   */
  showMainWindow() {
    if (this.mainWindow) {
      if (!this.mainWindow.isVisible()) {
        this.mainWindow.show();
      }
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      this.mainWindow.focus();
    }
  }
  
  /**
   * Toggle the main window visibility
   * @public
   */
  toggleMainWindow() {
    if (this.mainWindow) {
      if (this.mainWindow.isVisible()) {
        this.mainWindow.hide();
      } else {
        this.showMainWindow();
      }
    }
  }
  
  /**
   * Update the tray tooltip with status information
   * @param {string} status - Status message to display
   * @public
   */
  updateStatus(status) {
    if (this.tray) {
      this.tray.setToolTip(`SAITRAPP - ${status}`);
    }
  }
  
  /**
   * Display a balloon notification
   * @param {string} title - Notification title
   * @param {string} content - Notification content
   * @public
   */
  showNotification(title, content) {
    if (this.tray && process.platform === 'win32') {
      this.tray.displayBalloon({
        title,
        content
      });
    }
  }
  
  /**
   * Clean up resources
   * @public
   */
  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = TrayManager;