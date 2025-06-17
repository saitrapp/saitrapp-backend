// electron/main.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const url = require('url');
const fs = require('fs');
// crypto is used indirectly by services
const { autoUpdater } = require('electron-updater');
const DatabaseManager = require('./database-manager');
const CredentialStore = require('./credential-store');
const EncryptionService = require('./encryption-service');
const TrayManager = require('./tray-manager');
const MT5FXIFYAdapter = require('./brokers/fxify-mt5');

// Keep a global reference of the window object to avoid garbage collection
let mainWindow = null;
let authWindow = null;
let splashWindow = null;
let isAppQuitting = false;

// Constants for app directories
const USER_DATA_PATH = app.getPath('userData');
const DB_PATH = path.join(USER_DATA_PATH, 'saitrapp.db');
const CONFIG_PATH = path.join(USER_DATA_PATH, 'config.json');

// Global instances
let dbManager = null;
let credStore = null;
let encryptionService = null;
let trayManager = null;
let brokerManager = null;
let signalManager = null;
let externalSignalManager = null;
let fxifyModeManager = null;
let mt5FXIFYAdapter = null;

// Initialize application controller
const ApplicationController = {
  init: async () => {
    try {
      // Create user data directory if it doesn't exist
      if (!fs.existsSync(USER_DATA_PATH)) {
        fs.mkdirSync(USER_DATA_PATH, { recursive: true });
      }
      
      // Initialize encryption service
      encryptionService = new EncryptionService();
      
      // Show splash screen
      await createSplashWindow();
      
      // Check for user account
      // Use setTimeout directly in Node.js environment
      setTimeout(() => {
        createAuthWindow();
      }, 2000);
      
      // Check for updates
      autoUpdater.checkForUpdatesAndNotify();
    } catch (error) {
      console.error('Error initializing application:', error);
      dialog.showErrorBox('Initialization Error', 'Could not initialize SAITRAPP.');
      app.quit();
    }
  },
  
  initializeDatabase: async (masterKey) => {
    try {
      // Create and initialize database manager
      dbManager = new DatabaseManager(DB_PATH);
      await dbManager.initialize(masterKey);
      
      // Initialize credential store
      credStore = new CredentialStore('SAITRAPP', masterKey);
      await credStore.initialize(masterKey);
      
      // Initialize broker manager with database and credential store
      const BrokerManager = require('./broker-manager');
      brokerManager = new BrokerManager(dbManager, credStore);
      
      // Initialize signal manager
      const SignalManager = require('./signal-manager');
      signalManager = new SignalManager(dbManager, brokerManager);
      await signalManager.initialize();
      
      // Initialize external signal manager
      const ExternalSignalManager = require('./external-signal-manager');
      externalSignalManager = new ExternalSignalManager(dbManager, signalManager);
      await externalSignalManager.initialize();
      
      // Set up signal manager event listeners
      signalManager.on('signal-added', (signal) => {
        if (mainWindow) {
          mainWindow.webContents.send('app:signal-added', signal);
        }
      });
      
      signalManager.on('signal-updated', (data) => {
        if (mainWindow) {
          mainWindow.webContents.send('app:signal-updated', data);
        }
      });
      
      // Set up external signal manager event listeners
      externalSignalManager.on('external-signal-received', (data) => {
        if (mainWindow) {
          mainWindow.webContents.send('app:external-signal-received', data);
        }
      });
      
      externalSignalManager.on('signal-source-updated', (data) => {
        if (mainWindow) {
          mainWindow.webContents.send('app:signal-source-updated', data);
        }
      });
      
      // Log successful initialization
      await dbManager.logEvent('info', 'Application services initialized successfully');
      
      return true;
    } catch (error) {
      console.error('Failed to initialize database:', error);
      return false;
    }
  },
  
  shutdown: async () => {
    console.log('Shutting down application...');
    
    // Process final signals if needed
    if (signalManager) {
      try {
        await signalManager.processSignals();
        console.log('Final signal processing complete');
      } catch (err) {
        console.error('Error during signal processing shutdown:', err);
      }
    }

    // Log shutdown event
    if (dbManager) {
      await dbManager.logEvent('info', 'Application shutdown initiated');
    }
    
    // Close database connection and optimize
    if (dbManager) {
      try {
        const optimizationResult = await dbManager.optimize();
        console.log('Database optimization result:', optimizationResult);
        await dbManager.closeDatabase();
      } catch (err) {
        console.error('Error during database shutdown:', err);
      }
    }
    
    // Clean up tray
    if (trayManager) {
      trayManager.destroy();
    }
    
    // Close all windows
    if (mainWindow) {
      mainWindow.destroy();
    }
    if (authWindow) {
      authWindow.destroy();
    }
    if (splashWindow) {
      splashWindow.destroy();
    }
    
    console.log('Application shutdown complete');
  }
};

// Create splash screen window
async function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 500,
    height: 300,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../public/assets/icons/icon.png')
  });
  
  await splashWindow.loadFile(path.join(__dirname, '../public/splash.html'));
}

// Create authentication window
function createAuthWindow() {
  authWindow = new BrowserWindow({
    width: 400,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../public/assets/icons/icon.png'),
    show: false
  });
  
  authWindow.loadFile(path.join(__dirname, '../public/auth.html'));
  
  authWindow.once('ready-to-show', () => {
    if (splashWindow) {
      splashWindow.close();
      splashWindow = null;
    }
    authWindow.show();
  });
  
  authWindow.on('closed', () => {
    authWindow = null;
    if (!mainWindow && !isAppQuitting) {
      app.quit();
    }
  });
}

// Create main application window
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../public/assets/icons/icon.png'),
    show: false,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#2f3241',
      symbolColor: '#ffffff'
    }
  });
  
  // Load the main application
  const startUrl = process.env.ELECTRON_START_URL || url.format({
    pathname: path.join(__dirname, '../dist/index.html'),
    protocol: 'file:',
    slashes: true
  });
  
  mainWindow.loadURL(startUrl);
  
  // Hide menu bar in production
  if (app.isPackaged) {
    mainWindow.setMenuBarVisibility(false);
  } else {
    mainWindow.webContents.openDevTools();
  }
  
  // Initialize system tray
  trayManager = new TrayManager(mainWindow, path.join(__dirname, '../public/assets/icons/tray-icon.png'));
  trayManager.init();
  
  // Wait until the app is ready before showing
  mainWindow.once('ready-to-show', () => {
    if (authWindow) {
      authWindow.close();
      authWindow = null;
    }
    mainWindow.show();
    mainWindow.maximize();
    
    // Update tray with initial status
    trayManager.updateStatus('Trading Platform Ready');
  });
  
  // When main window is closed, handle with tray behavior
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (isAppQuitting) {
      app.quit();
    }
  });
  
  // Handle window close button - minimize to tray instead of quitting
  mainWindow.on('close', (event) => {
    // Only prevent default if we're not actually quitting
    if (!isAppQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
    return true;
  });
}

// Handle user authentication
async function authenticateUser(username, password) {
  try {
    // Check if config exists
    const configExists = fs.existsSync(CONFIG_PATH);
    
    if (!configExists) {
      // First run - create new user
      
      // Generate a secure master key from password
      const masterKey = encryptionService.deriveKey(password).key.toString('hex');
      
      // Initialize database and credential store with this key
      const dbInitialized = await ApplicationController.initializeDatabase(masterKey);
      if (!dbInitialized) {
        console.error('Failed to initialize database with new credentials');
        return false;
      }
      
      // Create user config
      const { salt, hash } = encryptionService.createHash(password);
      const config = {
        user: {
          username,
          salt,
          hash,
          created: new Date().toISOString()
        },
        settings: {
          theme: 'light',
          autoUpdate: true,
          riskProfile: 'moderate'
        }
      };
      
      // Encrypt and save config
      const encryptedConfig = encryptionService.encrypt(JSON.stringify(config), masterKey);
      fs.writeFileSync(CONFIG_PATH, encryptedConfig);
      
      // Save master key in credential store
      await credStore.storeCredential('app', username, masterKey);
      
      // Log the successful account creation
      await dbManager.logEvent('info', `New user account created: ${username}`);
      
      return true;
    } else {
      // Existing user login
      try {
        // Try to load configuration
        const encryptedConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
        
        // First, try to get master key from credential store
        // This allows "remember me" functionality
        let masterKey = await credStore?.getCredential('app', username);
        let config;
        
        // If no stored credentials or they're invalid, derive from password
        if (!masterKey) {
          // Generate master key from password
          masterKey = encryptionService.deriveKey(password).key.toString('hex');
        }
        
        try {
          // Try to decrypt config with master key
          const decrypted = encryptionService.decrypt(encryptedConfig, masterKey).toString('utf8');
          config = JSON.parse(decrypted);
          
          // Initialize services with master key
          await ApplicationController.initializeDatabase(masterKey);
        } catch (decryptError) {
          // If decryption fails, the password was likely wrong
          console.error('Failed to decrypt configuration:', decryptError);
          return false;
        }
        
        // Final password verification using stored hash (double check)
        if (config && config.user) {
          const { salt, hash } = config.user;
          const isValid = encryptionService.verifyHash(password, hash, salt);
          
          if (isValid) {
            // Log successful login
            await dbManager?.logEvent('info', `User logged in: ${username}`);
            return true;
          }
        }
      } catch (err) {
        console.error('Error during authentication:', err);
      }
      
      return false;
    }
  } catch (error) {
    console.error('Authentication error:', error);
    return false;
  }
}

// Application lifecycle events
app.on('ready', () => {
  ApplicationController.init();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    ApplicationController.init();
  }
});

app.on('before-quit', () => {
  isAppQuitting = true;
});

// IPC event handlers for auth
ipcMain.handle('app:authenticate', async (event, { username, password }) => {
  try {
    console.log('Authenticating user:', username);
    const success = await authenticateUser(username, password);
    if (success) {
      console.log('Authentication successful, creating main window');
      createMainWindow();
      return { success: true };
    }
    console.log('Authentication failed');
    return { success: false, error: 'Invalid credentials' };
  } catch (error) {
    console.error('Authentication error:', error);
    return { success: false, error: 'Authentication error: ' + error.message };
  }
});

ipcMain.handle('app:create-account', async (event, { username, password }) => {
  const success = await authenticateUser(username, password);
  if (success) {
    createMainWindow();
    return { success: true };
  }
  return { success: false, error: 'Could not create account' };
});

// IPC handlers for main application
ipcMain.handle('app:get-user-info', async () => {
  try {
    // Get encrypted config
    const encryptedConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
    
    // Get current master key from credential store
    // We know this is valid because user is already authenticated
    const credentials = await credStore.findCredentials('app');
    if (!credentials || credentials.length === 0) {
      throw new Error('No valid credentials found');
    }
    
    const masterKey = credentials[0].password;
    const decrypted = encryptionService.decrypt(encryptedConfig, masterKey).toString('utf8');
    const config = JSON.parse(decrypted);
    
    // Return user info and settings
    return { 
      username: config.user.username,
      settings: config.settings,
      created: config.user.created
    };
  } catch (error) {
    console.error('Error getting user info:', error);
    return { error: 'Could not get user info' };
  }
});

// Save user settings
ipcMain.handle('app:save-settings', async (event, settings) => {
  try {
    // Get encrypted config
    const encryptedConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
    
    // Get current master key from credential store
    const credentials = await credStore.findCredentials('app');
    if (!credentials || credentials.length === 0) {
      throw new Error('No valid credentials found');
    }
    
    const masterKey = credentials[0].password;
    const decrypted = encryptionService.decrypt(encryptedConfig, masterKey).toString('utf8');
    const config = JSON.parse(decrypted);
    
    // Update settings
    config.settings = { ...config.settings, ...settings };
    
    // Save back encrypted
    const updatedEncrypted = encryptionService.encrypt(JSON.stringify(config), masterKey);
    fs.writeFileSync(CONFIG_PATH, updatedEncrypted);
    
    // Log the change
    await dbManager.logEvent('info', 'User settings updated', { changedKeys: Object.keys(settings) });
    
    return { success: true };
  } catch (error) {
    console.error('Error saving settings:', error);
    return { success: false, error: error.message };
  }
});

// Get trading history
ipcMain.handle('app:get-trading-history', async (event, filters = {}) => {
  try {
    let query = 'SELECT * FROM trading_history';
    const queryParams = [];
    
    // Build where clause based on filters
    if (Object.keys(filters).length > 0) {
      const conditions = [];
      
      if (filters.symbol) {
        conditions.push('symbol = ?');
        queryParams.push(filters.symbol);
      }
      
      if (filters.dateFrom) {
        conditions.push('open_time >= ?');
        queryParams.push(filters.dateFrom);
      }
      
      if (filters.dateTo) {
        conditions.push('open_time <= ?');
        queryParams.push(filters.dateTo);
      }
      
      if (filters.status) {
        conditions.push('status = ?');
        queryParams.push(filters.status);
      }
      
      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }
    }
    
    // Add ordering
    query += ' ORDER BY open_time DESC';
    
    // Execute query
    const results = await dbManager.executeSelect(query, queryParams);
    
    return { success: true, data: results };
  } catch (error) {
    console.error('Error fetching trading history:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('app:check-updates', async () => {
  autoUpdater.checkForUpdatesAndNotify();
  return { checking: true };
});

ipcMain.handle('app:open-external-link', (event, url) => {
  shell.openExternal(url);
});

// Handle logout request
ipcMain.handle('app:logout', async () => {
  try {
    // Clean up any active user sessions here
    // Log the logout event
    if (dbManager) {
      await dbManager.logEvent('info', 'User logged out');
    }
    
    // Return success response
    return { success: true };
  } catch (error) {
    console.error('Error during logout:', error);
    return { success: false, error: error.message };
  }
});

// Secure storage IPC handlers
ipcMain.handle('app:get-secure-storage', async (event, key) => {
  try {
    if (!credStore) {
      throw new Error('Credential store not initialized');
    }
    
    // Get the current authenticated user from config
    const encryptedConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
    const credentials = await credStore.findCredentials('app');
    if (!credentials || credentials.length === 0) {
      throw new Error('No valid credentials found');
    }
    
    const masterKey = credentials[0].password;
    const decrypted = encryptionService.decrypt(encryptedConfig, masterKey).toString('utf8');
    const config = JSON.parse(decrypted);
    const username = config.user.username;
    
    // Get the value using the credential store
    const value = await credStore.getCredential('user-data', `${username}:${key}`);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.error(`Error getting secure storage for key ${key}:`, error);
    return null;
  }
});

ipcMain.handle('app:set-secure-storage', async (event, key, value) => {
  try {
    if (!credStore) {
      throw new Error('Credential store not initialized');
    }
    
    // Get the current authenticated user from config
    const encryptedConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
    const credentials = await credStore.findCredentials('app');
    if (!credentials || credentials.length === 0) {
      throw new Error('No valid credentials found');
    }
    
    const masterKey = credentials[0].password;
    const decrypted = encryptionService.decrypt(encryptedConfig, masterKey).toString('utf8');
    const config = JSON.parse(decrypted);
    const username = config.user.username;
    
    // Store the value using the credential store
    const success = await credStore.storeCredential('user-data', `${username}:${key}`, JSON.stringify(value));
    return { success };
  } catch (error) {
    console.error(`Error setting secure storage for key ${key}:`, error);
    return { success: false, error: error.message };
  }
});

// Broker management IPC handlers
ipcMain.handle('broker:get-supported-brokers', async () => {
  try {
    return { success: true, data: brokerManager.getSupportedBrokers() };
  } catch (error) {
    console.error('Failed to get supported brokers:', error);
    return { success: false, error: error.message };
  }
});

// Handle broker connection request
ipcMain.handle('connectToBroker', async (_event, connectionParams) => {
  try {
    const { brokerId } = connectionParams;
    const brokerAdapter = brokerManager.brokerAdapter;

    // Generate a temporary connection ID for the session
    const connectionId = `temp_${require('uuid').v4()}`;
    
    // Create the broker connection with appropriate credentials
    if (brokerId === 'forex-com') {
      // Extract MT5 credentials for FOREX.com
      const { login, password, server } = connectionParams;
      brokerAdapter.createConnection(brokerId, connectionId, {
        login,
        password,
        server
      });
    } else {
      // Extract API credentials for other brokers
      const { apiKey, apiSecret } = connectionParams;
      brokerAdapter.createConnection(brokerId, connectionId, {
        apiKey,
        apiSecret
      });
    }
    
    // Connect to the broker
    const connectResult = await brokerAdapter.connect(connectionId);
    
    // If successful, update connection status
    if (connectResult.success) {
      brokerManager.updateConnectionStatus(connectionId, 'connected');
    }
    
    return connectResult;
  } catch (error) {
    console.error('Failed to connect to broker:', error);
    return { success: false, error: error.message || 'Unknown connection error' };
  }
});

ipcMain.handle('broker:get-connections', async () => {
  try {
    const connections = await brokerManager.getBrokerConnections();
    return { success: true, data: connections };
  } catch (error) {
    console.error('Failed to get broker connections:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('broker:add-connection', async (event, params) => {
  try {
    const result = await brokerManager.addBrokerConnection(
      params.name,
      params.brokerType,
      params.apiKey,
      params.apiSecret,
      params.additionalParams
    );
    return { success: true, data: result };
  } catch (error) {
    console.error('Failed to add broker connection:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('broker:test-connection', async (event, { connectionId }) => {
  try {
    const result = await brokerManager.testBrokerConnection(connectionId);
    return result;
  } catch (error) {
    console.error('Failed to test broker connection:', error);
    return { success: false, error: error.message };
  }
});

// Signal management IPC handlers
ipcMain.handle('signals:get-recent', async (event, filters) => {
  try {
    const signals = await signalManager.getRecentSignals(filters);
    return { success: true, data: signals };
  } catch (error) {
    console.error('Failed to get recent signals:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('signals:add-signal', async (event, signalData) => {
  try {
    const signal = await signalManager.addSignal(signalData);
    return { success: true, data: signal };
  } catch (error) {
    console.error('Failed to add signal:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('signals:update-status', async (event, { signalId, newStatus, additionalData }) => {
  try {
    const result = await signalManager.updateSignalStatus(signalId, newStatus, additionalData);
    return { success: true, data: result };
  } catch (error) {
    console.error('Failed to update signal status:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('signals:get-performance', async () => {
  try {
    const stats = await signalManager.getSignalPerformanceStats();
    return { success: true, data: stats };
  } catch (error) {
    console.error('Failed to get signal performance stats:', error);
    return { success: false, error: error.message };
  }
});

// External signal integration IPC handlers
ipcMain.handle('external-signals:get-sources', async () => {
  try {
    if (!externalSignalManager) {
      throw new Error('External signal manager not initialized');
    }
    
    const sources = await externalSignalManager.getAllSources();
    return { success: true, data: sources };
  } catch (error) {
    console.error('Failed to get external signal sources:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('external-signals:get-source', async (event, sourceId) => {
  try {
    if (!externalSignalManager) {
      throw new Error('External signal manager not initialized');
    }
    
    const source = await externalSignalManager.getSource(sourceId);
    if (!source) {
      return { success: false, error: 'Source not found' };
    }
    
    // Get the templates for this source
    const templates = await externalSignalManager.getTemplatesForSource(sourceId);
    source.templates = templates;
    
    // Get recent raw signals for this source
    const rawSignals = await externalSignalManager.getRecentRawSignals(sourceId, 10);
    
    return { success: true, data: source, rawSignals };
  } catch (error) {
    console.error(`Failed to get external signal source ${sourceId}:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('external-signals:add-source', async (event, sourceData) => {
  try {
    if (!externalSignalManager) {
      throw new Error('External signal manager not initialized');
    }
    
    const newSource = await externalSignalManager.addSource(
      sourceData.name,
      sourceData.sourceType,
      sourceData.config
    );
    
    return { success: true, data: newSource };
  } catch (error) {
    console.error('Failed to add external signal source:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('external-signals:update-source', async (event, sourceId, updates) => {
  try {
    if (!externalSignalManager) {
      throw new Error('External signal manager not initialized');
    }
    
    const result = await externalSignalManager.updateSource(sourceId, updates);
    return { success: true, data: result };
  } catch (error) {
    console.error(`Failed to update external signal source ${sourceId}:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('external-signals:delete-source', async (event, sourceId) => {
  try {
    if (!externalSignalManager) {
      throw new Error('External signal manager not initialized');
    }
    
    await externalSignalManager.deleteSource(sourceId);
    return { success: true };
  } catch (error) {
    console.error(`Failed to delete external signal source ${sourceId}:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('external-signals:test-source', async (event, sourceId) => {
  try {
    if (!externalSignalManager) {
      throw new Error('External signal manager not initialized');
    }
    
    const result = await externalSignalManager.testSource(sourceId);
    return result;
  } catch (error) {
    console.error(`Failed to test external signal source ${sourceId}:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('external-signals:add-template', async (event, sourceId, templateData) => {
  try {
    if (!externalSignalManager) {
      throw new Error('External signal manager not initialized');
    }
    
    const newTemplate = await externalSignalManager.addTemplate(sourceId, templateData);
    return { success: true, data: newTemplate };
  } catch (error) {
    console.error(`Failed to add template to source ${sourceId}:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('external-signals:delete-template', async (event, templateId) => {
  try {
    if (!externalSignalManager) {
      throw new Error('External signal manager not initialized');
    }
    
    await externalSignalManager.deleteTemplate(templateId);
    return { success: true };
  } catch (error) {
    console.error(`Failed to delete template ${templateId}:`, error);
    return { success: false, error: error.message };
  }
});

// Trading history IPC handlers
ipcMain.handle('trading:get-history', async (event, filters) => {
  try {
    let query = 'SELECT * FROM trading_history';
    const queryParams = [];
    
    // Build where clause based on filters
    if (filters && Object.keys(filters).length > 0) {
      const conditions = [];
      
      if (filters.symbol) {
        conditions.push('symbol = ?');
        queryParams.push(filters.symbol);
      }
      
      if (filters.dateFrom) {
        conditions.push('open_time >= ?');
        queryParams.push(filters.dateFrom);
      }
      
      if (filters.dateTo) {
        conditions.push('open_time <= ?');
        queryParams.push(filters.dateTo);
      }
      
      if (filters.status) {
        conditions.push('status = ?');
        queryParams.push(filters.status);
      }
      
      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }
    }
    
    // Add ordering
    query += ' ORDER BY open_time DESC';
    
    // Execute query
    const results = await dbManager.executeSelect(query, queryParams);
    
    return { success: true, data: results };
  } catch (error) {
    console.error('Error fetching trading history:', error);
    return { success: false, error: error.message };
  }
});

// Auto updater events
autoUpdater.on('update-available', () => {
  if (mainWindow) {
    mainWindow.webContents.send('app:update-available');
  }
});

autoUpdater.on('update-downloaded', () => {
  if (mainWindow) {
    mainWindow.webContents.send('app:update-ready');
    
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'A new version of SAITRAPP has been downloaded. Install now?',
      buttons: ['Install', 'Later']
    }).then(result => {
      if (result.response === 0) {
        isAppQuitting = true;
        autoUpdater.quitAndInstall();
      }
    });
  }
});