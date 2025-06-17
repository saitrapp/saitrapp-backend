// electron/credential-store.js
const keytar = require('keytar');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * CredentialStore class for secure storage of user credentials and API keys
 * Uses system keychain (via keytar) for maximum security
 * Falls back to encrypted file storage if keychain is not available
 */
class CredentialStore {
  /**
   * Create a new CredentialStore instance
   * @param {string} appName - Application name for keychain service
   * @param {string} encryptionKey - Master key for encrypting credentials
   */
  constructor(appName, encryptionKey) {
    this.appName = appName || 'SAITRAPP';
    this.encryptionKey = encryptionKey;
    this.fallbackStorePath = path.join(app.getPath('userData'), 'credentials.enc');
    this.useSecureEnclave = true; // By default try to use system secure storage
  }

  /**
   * Initializes the credential store
   * @param {string} masterPassword - Master password for encryption
   * @returns {Promise<boolean>} Success status
   */
  async initialize(masterPassword) {
    try {
      // Generate encryption key from master password if not provided
      if (!this.encryptionKey && masterPassword) {
        const salt = crypto.randomBytes(16);
        this.encryptionKey = crypto.pbkdf2Sync(masterPassword, salt, 10000, 32, 'sha256').toString('hex');
      }
      
      // Test keychain availability
      try {
        await keytar.setPassword('SAITRAPP-test', 'test-account', 'test-value');
        await keytar.deletePassword('SAITRAPP-test', 'test-account');
        this.useSecureEnclave = true;
        console.log('Using system keychain for credential storage');
      } catch (error) {
        console.warn('System keychain not available, falling back to encrypted file storage:', error.message);
        this.useSecureEnclave = false;
        
        // If fallback store exists, test decryption to validate encryption key
        if (fs.existsSync(this.fallbackStorePath)) {
          try {
            await this._readEncryptedStore();
          } catch (err) {
            return false; // Invalid encryption key
          }
        } else {
          // Create empty encrypted store if it doesn't exist
          await this._writeEncryptedStore({});
        }
      }
      return true;
    } catch (error) {
      console.error('Failed to initialize credential store:', error);
      return false;
    }
  }

  /**
   * Store a credential securely
   * @param {string} service - Service name (e.g., 'broker-binance')
   * @param {string} account - Account identifier
   * @param {string} password - Secret value to store
   * @returns {Promise<boolean>} Success status
   */
  async storeCredential(service, account, password) {
    try {
      if (this.useSecureEnclave) {
        await keytar.setPassword(`${this.appName}-${service}`, account, password);
      } else {
        const store = await this._readEncryptedStore();
        if (!store[service]) store[service] = {};
        store[service][account] = password;
        await this._writeEncryptedStore(store);
      }
      return true;
    } catch (error) {
      console.error(`Failed to store credential for ${service}:${account}:`, error);
      return false;
    }
  }

  /**
   * Retrieve a credential
   * @param {string} service - Service name
   * @param {string} account - Account identifier
   * @returns {Promise<string|null>} Retrieved credential or null if not found
   */
  async getCredential(service, account) {
    try {
      if (this.useSecureEnclave) {
        return await keytar.getPassword(`${this.appName}-${service}`, account);
      } else {
        const store = await this._readEncryptedStore();
        return store[service]?.[account] || null;
      }
    } catch (error) {
      console.error(`Failed to get credential for ${service}:${account}:`, error);
      return null;
    }
  }

  /**
   * Delete a credential
   * @param {string} service - Service name
   * @param {string} account - Account identifier
   * @returns {Promise<boolean>} Success status
   */
  async deleteCredential(service, account) {
    try {
      if (this.useSecureEnclave) {
        return await keytar.deletePassword(`${this.appName}-${service}`, account);
      } else {
        const store = await this._readEncryptedStore();
        if (store[service] && store[service][account]) {
          delete store[service][account];
          // Clean up empty service objects
          if (Object.keys(store[service]).length === 0) {
            delete store[service];
          }
          await this._writeEncryptedStore(store);
          return true;
        }
        return false;
      }
    } catch (error) {
      console.error(`Failed to delete credential for ${service}:${account}:`, error);
      return false;
    }
  }

  /**
   * Find all credentials for a service
   * @param {string} service - Service name
   * @returns {Promise<Array<{account: string, password: string}>>} List of credentials
   */
  async findCredentials(service) {
    try {
      if (this.useSecureEnclave) {
        return await keytar.findCredentials(`${this.appName}-${service}`);
      } else {
        const store = await this._readEncryptedStore();
        if (!store[service]) return [];
        
        return Object.entries(store[service]).map(([account, password]) => ({
          account,
          password
        }));
      }
    } catch (error) {
      console.error(`Failed to find credentials for ${service}:`, error);
      return [];
    }
  }

  /**
   * Change the encryption key
   * @param {string} oldKey - Old encryption key
   * @param {string} newKey - New encryption key
   * @returns {Promise<boolean>} Success status
   */
  async changeEncryptionKey(oldKey, newKey) {
    if (this.useSecureEnclave) {
      // No need to change encryption key when using system keychain
      return true;
    }
    
    try {
      // Backup current key
      const currentKey = this.encryptionKey;
      
      // Verify old key
      if (oldKey && oldKey !== currentKey) {
        return false;
      }
      
      // Read current store with old key
      const store = await this._readEncryptedStore();
      
      // Update key and rewrite
      this.encryptionKey = newKey;
      await this._writeEncryptedStore(store);
      
      return true;
    } catch (error) {
      // Restore original key on failure
      this.encryptionKey = currentKey;
      console.error('Failed to change encryption key:', error);
      return false;
    }
  }

  /**
   * Read the encrypted credential store from disk
   * @private
   * @returns {Promise<Object>} Decrypted credential store
   */
  async _readEncryptedStore() {
    try {
      if (!fs.existsSync(this.fallbackStorePath)) {
        return {};
      }
      
      const encryptedData = fs.readFileSync(this.fallbackStorePath, 'utf8');
      const [ivHex, authTagHex, encryptedText] = encryptedData.split(':');
      
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const key = Buffer.from(this.encryptionKey.slice(0, 32), 'utf8');
      
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return JSON.parse(decrypted);
    } catch (error) {
      console.error('Failed to read encrypted store:', error);
      throw error;
    }
  }

  /**
   * Write the credential store to disk in encrypted form
   * @private
   * @param {Object} data - Data to encrypt and store
   * @returns {Promise<void>}
   */
  async _writeEncryptedStore(data) {
    try {
      const iv = crypto.randomBytes(16);
      const key = Buffer.from(this.encryptionKey.slice(0, 32), 'utf8');
      
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag();
      
      // Store as iv:authTag:encryptedData
      const encryptedStore = `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
      
      // Ensure directory exists
      const dir = path.dirname(this.fallbackStorePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(this.fallbackStorePath, encryptedStore, 'utf8');
    } catch (error) {
      console.error('Failed to write encrypted store:', error);
      throw error;
    }
  }
}

module.exports = CredentialStore;