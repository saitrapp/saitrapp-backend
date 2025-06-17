// electron/fxify/fxify-mode-manager.js
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { FXIFYRulesEngine } = require('./fxify-rules-engine');

/**
 * FXIFYModeManager
 * Central controller for FXIFY mode operations
 */
class FXIFYModeManager {
  /**
   * Create a new FXIFY Mode Manager instance
   * @param {Object} config - Optional configuration
   * @param {string} config.dataPath - Path to store FXIFY profiles
   */
  constructor(config = {}) {
    this.isActive = false;
    this.userProfiles = new Map();
    this.activeProfile = null;
    this.rulesEngine = new FXIFYRulesEngine();
    this.statusListeners = [];
    this.eventEmitter = new EventEmitter();
    
    // Configuration
    this.dataPath = config.dataPath || path.join(process.env.APPDATA || process.env.HOME, 'saitrapp', 'fxify');
  }
  
  /**
   * Initialize the FXIFY Mode Manager
   * @returns {Promise<void>} 
   */
  async initialize() {
    try {
      // Ensure data directory exists
      await this.ensureDataDirectory();
      
      // Load saved profiles
      await this.loadProfiles();
      
      // Initialize rules engine
      await this.rulesEngine.initialize();
      
      console.log('FXIFY Mode Manager initialized successfully');
      return true;
    } catch (error) {
      console.error('Failed to initialize FXIFY Mode Manager:', error);
      return false;
    }
  }
  
  /**
   * Ensure data directory exists
   * @private
   * @returns {Promise<void>}
   */
  async ensureDataDirectory() {
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
  
  /**
   * Activate FXIFY mode with specified profile
   * @param {string} profileId - Profile ID to activate (uses active profile if not specified)
   * @returns {Promise<boolean>} - Success status
   */
  async activateFXIFYMode(profileId) {
    try {
      // If profile ID is specified, set it as active profile
      if (profileId) {
        if (!this.userProfiles.has(profileId)) {
          console.error(`Profile ${profileId} not found`);
          return false;
        }
        this.activeProfile = this.userProfiles.get(profileId);
      } 
      // Otherwise use existing active profile or default
      else if (!this.activeProfile) {
        // If no active profile, use the first one or create a default
        if (this.userProfiles.size > 0) {
          this.activeProfile = [...this.userProfiles.values()][0];
        } else {
          // Create a default profile
          const defaultProfileId = await this.createDefaultProfile();
          this.activeProfile = this.userProfiles.get(defaultProfileId);
        }
      }
      
      // Initialize rules engine with active profile
      await this.rulesEngine.initializeForProfile(this.activeProfile);
      
      // Set mode as active
      this.isActive = true;
      
      // Notify listeners
      this.notifyStatusListeners();
      this.eventEmitter.emit('mode_activated', { profile: this.activeProfile });
      
      console.log('FXIFY mode activated with profile:', this.activeProfile.name);
      return true;
    } catch (error) {
      console.error('Failed to activate FXIFY mode:', error);
      return false;
    }
  }
  
  /**
   * Deactivate FXIFY mode
   * @returns {Promise<boolean>} - Success status
   */
  async deactivateFXIFYMode() {
    try {
      if (!this.isActive) {
        return true; // Already inactive
      }
      
      // Reset rules engine
      await this.rulesEngine.resetRules();
      
      // Set mode as inactive
      this.isActive = false;
      
      // Notify listeners
      this.notifyStatusListeners();
      this.eventEmitter.emit('mode_deactivated');
      
      console.log('FXIFY mode deactivated');
      return true;
    } catch (error) {
      console.error('Failed to deactivate FXIFY mode:', error);
      return false;
    }
  }
  
  /**
   * Check if FXIFY mode is active
   * @returns {boolean} - True if FXIFY mode is active
   */
  isFXIFYModeActive() {
    return this.isActive;
  }
  
  /**
   * Create a new FXIFY profile
   * @param {Object} profile - Profile data
   * @returns {Promise<string>} - Created profile ID
   */
  async createProfile(profile) {
    try {
      // Generate a unique ID if not provided
      const profileId = profile.id || `profile_${crypto.randomBytes(4).toString('hex')}`;
      
      // Create profile object
      const newProfile = {
        id: profileId,
        name: profile.name || 'New FXIFY Profile',
        accountType: profile.accountType || 'Evaluation',
        profitTarget: profile.profitTarget || 0.10, // 10% default
        maxDailyDrawdown: profile.maxDailyDrawdown || 0.03, // 3% default
        maxTotalDrawdown: profile.maxTotalDrawdown || 0.06, // 6% default
        minTradingDays: profile.minTradingDays || 5, // 5 days default
        tradeSizeLimit: profile.tradeSizeLimit || null,
        allowNewsTrading: profile.allowNewsTrading !== undefined ? profile.allowNewsTrading : false,
        customSettings: profile.customSettings || {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      // Add to profiles map
      this.userProfiles.set(profileId, newProfile);
      
      // Save to disk
      await this.saveProfiles();
      
      // Emit profile created event
      this.eventEmitter.emit('profile_created', newProfile);
      
      return profileId;
    } catch (error) {
      console.error('Failed to create FXIFY profile:', error);
      throw error;
    }
  }
  
  /**
   * Create a default profile
   * @private
   * @returns {Promise<string>} - Created profile ID
   */
  async createDefaultProfile() {
    return this.createProfile({
      name: 'Default FXIFY Profile',
      accountType: 'Evaluation',
      profitTarget: 0.10,
      maxDailyDrawdown: 0.03,
      maxTotalDrawdown: 0.06,
      minTradingDays: 5,
      tradeSizeLimit: null,
      allowNewsTrading: false
    });
  }
  
  /**
   * Update an existing FXIFY profile
   * @param {string} profileId - Profile ID to update
   * @param {Object} profile - Updated profile data
   * @returns {Promise<boolean>} - Success status
   */
  async updateProfile(profileId, profile) {
    try {
      if (!this.userProfiles.has(profileId)) {
        console.error(`Profile ${profileId} not found`);
        return false;
      }
      
      const currentProfile = this.userProfiles.get(profileId);
      
      // Update profile fields
      const updatedProfile = {
        ...currentProfile,
        name: profile.name || currentProfile.name,
        accountType: profile.accountType || currentProfile.accountType,
        profitTarget: profile.profitTarget !== undefined ? profile.profitTarget : currentProfile.profitTarget,
        maxDailyDrawdown: profile.maxDailyDrawdown !== undefined ? profile.maxDailyDrawdown : currentProfile.maxDailyDrawdown,
        maxTotalDrawdown: profile.maxTotalDrawdown !== undefined ? profile.maxTotalDrawdown : currentProfile.maxTotalDrawdown,
        minTradingDays: profile.minTradingDays !== undefined ? profile.minTradingDays : currentProfile.minTradingDays,
        tradeSizeLimit: profile.tradeSizeLimit !== undefined ? profile.tradeSizeLimit : currentProfile.tradeSizeLimit,
        allowNewsTrading: profile.allowNewsTrading !== undefined ? profile.allowNewsTrading : currentProfile.allowNewsTrading,
        customSettings: profile.customSettings || currentProfile.customSettings,
        updatedAt: new Date().toISOString()
      };
      
      // Update in profiles map
      this.userProfiles.set(profileId, updatedProfile);
      
      // If this is the active profile, update rules engine
      if (this.activeProfile && this.activeProfile.id === profileId && this.isActive) {
        this.activeProfile = updatedProfile;
        await this.rulesEngine.initializeForProfile(updatedProfile);
      }
      
      // Save to disk
      await this.saveProfiles();
      
      // Emit profile updated event
      this.eventEmitter.emit('profile_updated', updatedProfile);
      
      return true;
    } catch (error) {
      console.error(`Failed to update FXIFY profile ${profileId}:`, error);
      return false;
    }
  }
  
  /**
   * Delete a FXIFY profile
   * @param {string} profileId - Profile ID to delete
   * @returns {Promise<boolean>} - Success status
   */
  async deleteProfile(profileId) {
    try {
      if (!this.userProfiles.has(profileId)) {
        console.error(`Profile ${profileId} not found`);
        return false;
      }
      
      // Check if this is the active profile
      if (this.activeProfile && this.activeProfile.id === profileId) {
        // If FXIFY mode is active, deactivate it
        if (this.isActive) {
          await this.deactivateFXIFYMode();
        }
        this.activeProfile = null;
      }
      
      // Get profile for event
      const deletedProfile = this.userProfiles.get(profileId);
      
      // Remove from profiles map
      this.userProfiles.delete(profileId);
      
      // Save to disk
      await this.saveProfiles();
      
      // Emit profile deleted event
      this.eventEmitter.emit('profile_deleted', { id: profileId, name: deletedProfile.name });
      
      return true;
    } catch (error) {
      console.error(`Failed to delete FXIFY profile ${profileId}:`, error);
      return false;
    }
  }
  
  /**
   * Get the active profile
   * @returns {Object|null} - Active profile or null if none
   */
  getActiveProfile() {
    return this.activeProfile;
  }
  
  /**
   * Get all profiles
   * @returns {Array<Object>} - List of all profiles
   */
  getAllProfiles() {
    return Array.from(this.userProfiles.values());
  }
  
  /**
   * Validate a trade request against FXIFY rules
   * @param {Object} tradeRequest - Trade request to validate
   * @returns {Promise<Object>} - Validation result
   */
  async validateTradeAgainstRules(tradeRequest) {
    if (!this.isActive || !this.activeProfile) {
      return { valid: true, rules: [] };
    }
    
    return this.rulesEngine.evaluateTradeRequest(tradeRequest, this.activeProfile);
  }
  
  /**
   * Register status listener callback
   * @param {Function} listener - Status listener callback
   */
  registerStatusListener(listener) {
    if (typeof listener === 'function' && !this.statusListeners.includes(listener)) {
      this.statusListeners.push(listener);
    }
  }
  
  /**
   * Remove status listener callback
   * @param {Function} listener - Status listener callback
   */
  removeStatusListener(listener) {
    const index = this.statusListeners.indexOf(listener);
    if (index !== -1) {
      this.statusListeners.splice(index, 1);
    }
  }
  
  /**
   * Notify all status listeners
   * @private
   */
  notifyStatusListeners() {
    const status = this.getCurrentStatus();
    
    this.statusListeners.forEach(listener => {
      try {
        listener(status);
      } catch (error) {
        console.error('Error in FXIFY status listener:', error);
      }
    });
  }
  
  /**
   * Get current FXIFY status
   * @returns {Object} - FXIFY status
   */
  getCurrentStatus() {
    const status = {
      active: this.isActive,
      currentProfile: this.activeProfile ? this.activeProfile.id : null,
      dailyDrawdown: 0,
      totalDrawdown: 0,
      tradingDaysCompleted: 0,
      currentProfit: 0,
      warnings: []
    };
    
    // If active, get additional status from rules engine
    if (this.isActive && this.activeProfile) {
      const drawdownStatus = this.rulesEngine.getDrawdownStatus();
      status.dailyDrawdown = drawdownStatus.dailyDrawdown;
      status.totalDrawdown = drawdownStatus.totalDrawdown;
      status.tradingDaysCompleted = this.rulesEngine.getTradingDaysCompleted();
      status.currentProfit = this.rulesEngine.getCurrentProfit();
      status.warnings = this.rulesEngine.getActiveWarnings();
    }
    
    return status;
  }
  
  /**
   * Initialize drawdown monitor with initial balance
   * @param {number} initialBalance - Initial account balance
   * @returns {Promise<void>}
   */
  async initializeDrawdownMonitor(initialBalance) {
    if (this.isActive && this.activeProfile) {
      await this.rulesEngine.initializeDrawdownMonitor(
        initialBalance,
        this.activeProfile.maxDailyDrawdown,
        this.activeProfile.maxTotalDrawdown
      );
    }
  }
  
  /**
   * Update account balance for drawdown monitoring
   * @param {number} balance - Current account balance
   * @param {number} equity - Current account equity
   * @returns {Promise<void>}
   */
  async updateBalance(balance, equity) {
    if (this.isActive) {
      await this.rulesEngine.updateBalance(balance, equity);
      
      // Check for rule violations and notify listeners
      this.checkForDrawdownViolations();
      
      // Update all listeners with new status
      this.notifyStatusListeners();
    }
  }
  
  /**
   * Check for drawdown violations and emit events
   * @private
   * @returns {void}
   */
  checkForDrawdownViolations() {
    if (!this.isActive) return;
    
    const drawdownStatus = this.rulesEngine.getDrawdownStatus();
    
    if (drawdownStatus.dailyLimitExceeded) {
      this.eventEmitter.emit('daily_drawdown_exceeded', drawdownStatus);
    }
    else if (drawdownStatus.totalLimitExceeded) {
      this.eventEmitter.emit('total_drawdown_exceeded', drawdownStatus);
    }
    else if (drawdownStatus.warningLevel === 'critical') {
      this.eventEmitter.emit('drawdown_critical', drawdownStatus);
    }
    else if (drawdownStatus.warningLevel === 'warning') {
      this.eventEmitter.emit('drawdown_warning', drawdownStatus);
    }
  }
  
  /**
   * Save profiles to disk
   * @private
   * @returns {Promise<void>}
   */
  async saveProfiles() {
    try {
      const profilesArray = Array.from(this.userProfiles.values());
      const profilesFile = path.join(this.dataPath, 'profiles.json');
      
      await fs.writeFile(
        profilesFile,
        JSON.stringify(profilesArray, null, 2),
        'utf8'
      );
    } catch (error) {
      console.error('Failed to save FXIFY profiles:', error);
      throw error;
    }
  }
  
  /**
   * Load profiles from disk
   * @private
   * @returns {Promise<void>}
   */
  async loadProfiles() {
    try {
      const profilesFile = path.join(this.dataPath, 'profiles.json');
      
      try {
        const data = await fs.readFile(profilesFile, 'utf8');
        const profiles = JSON.parse(data);
        
        // Clear existing profiles
        this.userProfiles.clear();
        
        // Load profiles into map
        profiles.forEach(profile => {
          this.userProfiles.set(profile.id, profile);
        });
        
        console.log(`Loaded ${profiles.length} FXIFY profiles`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // File doesn't exist, create default profile
          await this.createDefaultProfile();
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error('Failed to load FXIFY profiles:', error);
      throw error;
    }
  }
  
  /**
   * Subscribe to events
   * @param {string} event - Event name
   * @param {Function} callback - Event callback
   */
  on(event, callback) {
    this.eventEmitter.on(event, callback);
  }
  
  /**
   * Unsubscribe from events
   * @param {string} event - Event name
   * @param {Function} callback - Event callback
   */
  off(event, callback) {
    this.eventEmitter.off(event, callback);
  }
}

module.exports = {
  FXIFYModeManager
};