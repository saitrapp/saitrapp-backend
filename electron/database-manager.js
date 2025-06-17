// electron/database-manager.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class DatabaseManager {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.encryptionKey = null;
    this.isInitialized = false;
  }
  
  /**
   * Initialize the database
   * @param {string} encryptionKey - Key for encrypting sensitive data
   * @returns {Promise<boolean>} - Success status
   */
  async initialize(encryptionKey) {
    try {
      // Store encryption key for sensitive data
      this.encryptionKey = encryptionKey;
      
      // Check if database directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      
      // Create or open database
      await this.openDatabase();
      
      // Initialize database schema
      await this.initializeSchema();
      
      this.isInitialized = true;
      console.log('Database initialized successfully');
      return true;
    } catch (error) {
      console.error('Failed to initialize database:', error);
      return false;
    }
  }
  
  /**
   * Open the SQLite database connection
   * @returns {Promise<void>}
   */
  openDatabase() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          console.error('Could not open database:', err.message);
          reject(err);
        } else {
          console.log('Connected to the SQLite database.');
          resolve();
        }
      });
    });
  }
  
  /**
   * Close the database connection
   * @returns {Promise<void>}
   */
  closeDatabase() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            console.error('Could not close database:', err.message);
            reject(err);
          } else {
            console.log('Database connection closed.');
            this.db = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
  
  /**
   * Initialize the database schema
   * @returns {Promise<void>}
   */
  async initializeSchema() {
    const createTableQueries = [
      `CREATE TABLE IF NOT EXISTS user_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS broker_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        broker_type TEXT NOT NULL,
        api_key_encrypted TEXT,
        api_secret_encrypted TEXT,
        is_active INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_connected TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS trading_history (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        open_price REAL,
        close_price REAL,
        stop_loss REAL,
        take_profit REAL,
        lots REAL,
        profit REAL,
        open_time TIMESTAMP,
        close_time TIMESTAMP,
        strategy TEXT,
        status TEXT,
        broker_connection_id TEXT,
        FOREIGN KEY (broker_connection_id) REFERENCES broker_connections(id)
      )`,
      
      `CREATE TABLE IF NOT EXISTS trading_signals (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        price REAL,
        stop_loss REAL,
        take_profit REAL,
        timestamp TIMESTAMP,
        status TEXT,
        strategy TEXT,
        reasoning TEXT,
        reliability INTEGER
      )`,
      
      `CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT,
        message TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        context TEXT
      )`
    ];
    
    for (const query of createTableQueries) {
      await this.executeQuery(query);
    }
    
    // Create indexes
    const indexQueries = [
      `CREATE INDEX IF NOT EXISTS idx_trading_history_symbol ON trading_history(symbol)`,
      `CREATE INDEX IF NOT EXISTS idx_trading_history_status ON trading_history(status)`,
      `CREATE INDEX IF NOT EXISTS idx_trading_signals_symbol ON trading_signals(symbol)`,
      `CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level)`
    ];
    
    for (const query of indexQueries) {
      await this.executeQuery(query);
    }
  }
  
  /**
   * Execute a SQL query
   * @param {string} query - SQL query string
   * @param {Array} params - Query parameters
   * @returns {Promise<any>} - Query result
   */
  executeQuery(query, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(query, params, function(err) {
        if (err) {
          console.error('Query execution error:', err.message);
          reject(err);
        } else {
          resolve({ lastID: this.lastID, changes: this.changes });
        }
      });
    });
  }
  
  /**
   * Execute a SQL query and get results
   * @param {string} query - SQL query string
   * @param {Array} params - Query parameters
   * @returns {Promise<Array>} - Query results
   */
  executeSelect(query, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(query, params, (err, rows) => {
        if (err) {
          console.error('Query execution error:', err.message);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }
  
  /**
   * Begin a database transaction
   * @returns {Promise<void>}
   */
  beginTransaction() {
    return this.executeQuery('BEGIN TRANSACTION');
  }
  
  /**
   * Commit a database transaction
   * @returns {Promise<void>}
   */
  commitTransaction() {
    return this.executeQuery('COMMIT');
  }
  
  /**
   * Rollback a database transaction
   * @returns {Promise<void>}
   */
  rollbackTransaction() {
    return this.executeQuery('ROLLBACK');
  }
  
  /**
   * Create a backup of the database
   * @param {string} destination - Backup file path
   * @returns {Promise<object>} - Backup result
   */
  async backup(destination) {
    return new Promise((resolve, reject) => {
      // Ensure the backup directory exists
      const backupDir = path.dirname(destination);
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      
      // Create a backup by copying the database file
      const readStream = fs.createReadStream(this.dbPath);
      const writeStream = fs.createWriteStream(destination);
      
      readStream.on('error', (err) => {
        reject({ success: false, error: err.message });
      });
      
      writeStream.on('error', (err) => {
        reject({ success: false, error: err.message });
      });
      
      writeStream.on('finish', () => {
        resolve({ success: true, path: destination });
      });
      
      readStream.pipe(writeStream);
    });
  }
  
  /**
   * Restore database from backup
   * @param {string} source - Backup file path
   * @returns {Promise<object>} - Restore result
   */
  async restore(source) {
    try {
      // Close the current database connection
      await this.closeDatabase();
      
      // Replace the database file with the backup
      fs.copyFileSync(source, this.dbPath);
      
      // Reopen the database
      await this.openDatabase();
      
      return { success: true };
    } catch (error) {
      console.error('Database restore failed:', error);
      
      // Try to reopen the original database
      try {
        await this.openDatabase();
      } catch (reopenError) {
        console.error('Failed to reopen database after restore failure:', reopenError);
      }
      
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Optimize the database
   * @returns {Promise<object>} - Optimization result
   */
  async optimize() {
    try {
      // Run VACUUM to rebuild the database file and optimize it
      await this.executeQuery('VACUUM');
      
      // Run integrity check
      const integrityResult = await this.executeSelect('PRAGMA integrity_check');
      const isValid = integrityResult.length === 1 && integrityResult[0].integrity_check === 'ok';
      
      return { 
        success: isValid,
        message: isValid ? 'Database optimized successfully' : 'Database optimization completed with integrity issues',
        integrityResult
      };
    } catch (error) {
      console.error('Database optimization failed:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Encrypt sensitive data
   * @param {string} data - Data to encrypt
   * @returns {string} - Encrypted data
   */
  encryptData(data) {
    if (!this.encryptionKey || !data) return null;
    
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(this.encryptionKey), iv);
      let encrypted = cipher.update(data, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return `${iv.toString('hex')}:${encrypted}`;
    } catch (error) {
      console.error('Encryption error:', error);
      return null;
    }
  }
  
  /**
   * Decrypt sensitive data
   * @param {string} encryptedData - Data to decrypt
   * @returns {string} - Decrypted data
   */
  decryptData(encryptedData) {
    if (!this.encryptionKey || !encryptedData) return null;
    
    try {
      const [ivHex, encryptedText] = encryptedData.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(this.encryptionKey), iv);
      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      console.error('Decryption error:', error);
      return null;
    }
  }
  
  /**
   * Save a user setting
   * @param {string} key - Setting key
   * @param {any} value - Setting value
   * @returns {Promise<boolean>} - Success status
   */
  async saveSetting(key, value) {
    try {
      const serializedValue = JSON.stringify(value);
      await this.executeQuery(
        'INSERT OR REPLACE INTO user_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [key, serializedValue]
      );
      return true;
    } catch (error) {
      console.error('Failed to save setting:', error);
      return false;
    }
  }
  
  /**
   * Get a user setting
   * @param {string} key - Setting key
   * @param {any} defaultValue - Default value if setting not found
   * @returns {Promise<any>} - Setting value
   */
  async getSetting(key, defaultValue = null) {
    try {
      const rows = await this.executeSelect('SELECT value FROM user_settings WHERE key = ?', [key]);
      
      if (rows.length > 0) {
        return JSON.parse(rows[0].value);
      }
      
      return defaultValue;
    } catch (error) {
      console.error('Failed to get setting:', error);
      return defaultValue;
    }
  }
  
  /**
   * Save a trading signal to the database
   * @param {object} signal - Trading signal object
   * @returns {Promise<boolean>} - Success status
   */
  async saveSignal(signal) {
    try {
      await this.executeQuery(
        `INSERT INTO trading_signals 
        (id, symbol, direction, price, stop_loss, take_profit, timestamp, status, strategy, reasoning, reliability) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          signal.id || `sig_${Date.now()}`,
          signal.symbol,
          signal.direction,
          signal.price,
          signal.stopLoss,
          signal.takeProfit,
          signal.timestamp || new Date().toISOString(),
          signal.status || 'pending',
          signal.strategy,
          signal.reasoning,
          signal.reliability
        ]
      );
      return true;
    } catch (error) {
      console.error('Failed to save signal:', error);
      return false;
    }
  }
  
  /**
   * Save a trading position to history
   * @param {object} trade - Trading position object
   * @returns {Promise<boolean>} - Success status
   */
  async saveTradeHistory(trade) {
    try {
      await this.executeQuery(
        `INSERT INTO trading_history 
        (id, symbol, direction, open_price, close_price, stop_loss, take_profit, lots, profit, open_time, close_time, strategy, status, broker_connection_id) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          trade.id,
          trade.symbol,
          trade.direction,
          trade.openPrice,
          trade.closePrice,
          trade.stopLoss,
          trade.takeProfit,
          trade.lots,
          trade.profit,
          trade.openTime,
          trade.closeTime,
          trade.strategy,
          trade.status,
          trade.brokerConnectionId
        ]
      );
      return true;
    } catch (error) {
      console.error('Failed to save trade history:', error);
      return false;
    }
  }
  
  /**
   * Log system event
   * @param {string} level - Log level (info, warn, error)
   * @param {string} message - Log message
   * @param {object} context - Additional context
   * @returns {Promise<boolean>} - Success status
   */
  async logEvent(level, message, context = {}) {
    try {
      await this.executeQuery(
        'INSERT INTO system_logs (level, message, context) VALUES (?, ?, ?)',
        [level, message, JSON.stringify(context)]
      );
      return true;
    } catch (error) {
      console.error('Failed to log event:', error);
      return false;
    }
  }
}

module.exports = DatabaseManager;