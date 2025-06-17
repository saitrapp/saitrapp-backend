// electron/preload.js
const { contextBridge, ipcRenderer } = require('electron');
const os = require('os');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Authentication
  authenticate: (credentials) => ipcRenderer.invoke('app:authenticate', credentials),
  createAccount: (credentials) => ipcRenderer.invoke('app:create-account', credentials),
  
  // User info
  getUserInfo: () => ipcRenderer.invoke('app:get-user-info'),
  saveUserSettings: (settings) => ipcRenderer.invoke('app:save-settings', settings),
  logout: () => ipcRenderer.invoke('app:logout'),
  
  // System info
  getSystemInfo: () => ({
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMemory: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
    freeMemory: Math.round(os.freemem() / (1024 * 1024 * 1024)),
    version: '1.0.0',
    isElectron: true
  }),
  
  // Updates
  checkForUpdates: () => ipcRenderer.invoke('app:check-updates'),
  
  // External links
  openExternalLink: (url) => ipcRenderer.invoke('app:open-external-link', url),
  
  // Secure storage
  getSecureStorage: (key) => ipcRenderer.invoke('app:get-secure-storage', key),
  setSecureStorage: (key, value) => ipcRenderer.invoke('app:set-secure-storage', key, value),
  
  // Broker operations
  getSupportedBrokers: () => ipcRenderer.invoke('broker:get-supported-brokers'),
  getBrokerConnections: () => ipcRenderer.invoke('broker:get-connections'),
  addBrokerConnection: (params) => ipcRenderer.invoke('broker:add-connection', params),
  testBrokerConnection: (params) => ipcRenderer.invoke('broker:test-connection', params),
  
  // Signal operations
  getRecentSignals: (filters) => ipcRenderer.invoke('signals:get-recent', filters),
  addSignal: (signalData) => ipcRenderer.invoke('signals:add-signal', signalData),
  updateSignalStatus: (params) => ipcRenderer.invoke('signals:update-status', params),
  getSignalPerformance: () => ipcRenderer.invoke('signals:get-performance'),
  
  // Trading operations
  getTradingHistory: (filters) => ipcRenderer.invoke('trading:get-history', filters),
  
  // Event listeners
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('app:update-available', () => callback());
  },
  onUpdateReady: (callback) => {
    ipcRenderer.on('app:update-ready', () => callback());
  },
  onSignalAdded: (callback) => {
    ipcRenderer.on('app:signal-added', (_event, signal) => callback(signal));
  },
  onSignalUpdated: (callback) => {
    ipcRenderer.on('app:signal-updated', (_event, data) => callback(data));
  },
  
  // Remove event listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});