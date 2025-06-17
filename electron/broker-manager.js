// electron/broker-manager.js
const { v4: uuidv4 } = require('uuid');
const BrokerAdapter = require('./broker-adapter');
const path = require('path');

/**
 * BrokerManager handles secure storage and management of broker connections
 * Provides interfaces for CRUD operations on broker API credentials
 * and manages active broker connections
 */
class BrokerManager {
  /**
   * Create a new BrokerManager instance
   * @param {DatabaseManager} dbManager - Database manager instance
   * @param {CredentialStore} credentialStore - Credential store instance
   */
  constructor(dbManager, credentialStore) {
    this.dbManager = dbManager;
    this.credentialStore = credentialStore;
    
    // List of supported brokers
    this.supportedBrokers = [
      { id: 'mt5', name: 'MetaTrader 5', apiKeyRequired: false, apiSecretRequired: false },
      { id: 'mt4', name: 'MetaTrader 4', apiKeyRequired: false, apiSecretRequired: false },
      { id: 'interactive_brokers', name: 'Interactive Brokers', apiKeyRequired: true, apiSecretRequired: true },
      { id: 'tdameritrade', name: 'TD Ameritrade', apiKeyRequired: true, apiSecretRequired: true },
      { id: 'oanda', name: 'Oanda', apiKeyRequired: true, apiSecretRequired: false },
      { id: 'fxify', name: 'FXIFY', apiKeyRequired: true, apiSecretRequired: true },
      { id: 'forex-com', name: 'FOREX.com', apiKeyRequired: false, apiSecretRequired: false, mt5Required: true },
      { id: 'binance', name: 'Binance', apiKeyRequired: true, apiSecretRequired: true },
      { id: 'demo', name: 'Demo Account', apiKeyRequired: false, apiSecretRequired: false }
    ];
    
    // Initialize broker adapter
    this.brokerAdapter = new BrokerAdapter();
    
    // Cache active connections
    this.activeConnections = new Map();
  }
  
  /**
   * Get list of supported brokers
   * @returns {Array<Object>} List of supported brokers and their requirements
   */
  getSupportedBrokers() {
    return [...this.supportedBrokers];
  }
  
  /**
   * Add a new broker connection
   * @param {string} name - User-friendly name for this connection
   * @param {string} brokerType - Type of broker (must be in supportedBrokers)
   * @param {string} apiKey - API key for authentication
   * @param {string} apiSecret - API secret for authentication
   * @param {Object} additionalParams - Additional connection parameters
   * @returns {Promise<Object>} Created broker connection object
   */
  async addBrokerConnection(name, brokerType, apiKey, apiSecret, additionalParams = {}) {
    try {
      // Validate broker type
      const brokerInfo = this.supportedBrokers.find(b => b.id === brokerType);
      if (!brokerInfo) {
        throw new Error(`Unsupported broker type: ${brokerType}`);
      }
      
      // Validate required fields
      if (brokerInfo.apiKeyRequired && !apiKey) {
        throw new Error('API Key is required for this broker');
      }
      
      if (brokerInfo.apiSecretRequired && !apiSecret) {
        throw new Error('API Secret is required for this broker');
      }
      
      // Generate a unique ID for this connection
      const connectionId = `conn_${uuidv4()}`;
      
      // Store sensitive credentials in credential store
      if (apiKey) {
        await this.credentialStore.storeCredential(`broker-${brokerType}`, `${connectionId}_key`, apiKey);
      }
      
      if (apiSecret) {
        await this.credentialStore.storeCredential(`broker-${brokerType}`, `${connectionId}_secret`, apiSecret);
      }
      
      // Create database record with non-sensitive information
      const connectionData = {
        id: connectionId,
        name: name,
        broker_type: brokerType,
        api_key_encrypted: apiKey ? 'stored_in_credential_store' : null,
        api_secret_encrypted: apiSecret ? 'stored_in_credential_store' : null,
        created_at: new Date().toISOString(),
        is_active: 0,
        last_connected: null,
        additional_params: JSON.stringify(additionalParams)
      };
      
      // Insert into database
      await this.dbManager.executeQuery(
        `INSERT INTO broker_connections 
        (id, name, broker_type, api_key_encrypted, api_secret_encrypted, is_active, created_at, additional_params) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          connectionData.id,
          connectionData.name,
          connectionData.broker_type,
          connectionData.api_key_encrypted,
          connectionData.api_secret_encrypted,
          connectionData.is_active,
          connectionData.created_at,
          connectionData.additional_params
        ]
      );
      
      // Log the event
      await this.dbManager.logEvent('info', `New broker connection added: ${name} (${brokerType})`);
      
      return { success: true, connectionId, name, brokerType };
      
    } catch (error) {
      console.error('Failed to add broker connection:', error);
      await this.dbManager.logEvent('error', `Failed to add broker connection: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get all broker connections
   * @returns {Promise<Array<Object>>} List of broker connections (without sensitive data)
   */
  async getBrokerConnections() {
    try {
      const connections = await this.dbManager.executeSelect(
        'SELECT id, name, broker_type, is_active, created_at, last_connected FROM broker_connections ORDER BY name'
      );
      
      return connections.map(conn => ({
        id: conn.id,
        name: conn.name,
        brokerType: conn.broker_type,
        isActive: Boolean(conn.is_active),
        createdAt: conn.created_at,
        lastConnected: conn.last_connected,
        hasCredentials: Boolean(conn.api_key_encrypted)
      }));
    } catch (error) {
      console.error('Failed to get broker connections:', error);
      throw error;
    }
  }
  
  /**
   * Get a single broker connection by ID
   * @param {string} connectionId - Connection ID
   * @returns {Promise<Object>} Broker connection object (with credentials)
   */
  async getBrokerConnection(connectionId) {
    try {
      const connections = await this.dbManager.executeSelect(
        'SELECT id, name, broker_type, is_active, created_at, last_connected, additional_params FROM broker_connections WHERE id = ?',
        [connectionId]
      );
      
      if (connections.length === 0) {
        throw new Error(`Connection not found: ${connectionId}`);
      }
      
      const connection = connections[0];
      
      // Get credentials from credential store
      const apiKey = await this.credentialStore.getCredential(`broker-${connection.broker_type}`, `${connectionId}_key`);
      const apiSecret = await this.credentialStore.getCredential(`broker-${connection.broker_type}`, `${connectionId}_secret`);
      
      return {
        id: connection.id,
        name: connection.name,
        brokerType: connection.broker_type,
        isActive: Boolean(connection.is_active),
        createdAt: connection.created_at,
        lastConnected: connection.last_connected,
        apiKey,
        apiSecret,
        additionalParams: JSON.parse(connection.additional_params || '{}')
      };
    } catch (error) {
      console.error(`Failed to get broker connection ${connectionId}:`, error);
      throw error;
    }
  }
  
  /**
   * Update a broker connection
   * @param {string} connectionId - Connection ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated connection object
   */
  async updateBrokerConnection(connectionId, updates) {
    try {
      // Get current connection
      const connection = await this.getBrokerConnection(connectionId);
      
      const updateFields = [];
      const updateParams = [];
      
      // Update name if provided
      if (updates.name) {
        updateFields.push('name = ?');
        updateParams.push(updates.name);
      }
      
      // Update API key if provided
      if (updates.apiKey) {
        await this.credentialStore.storeCredential(`broker-${connection.brokerType}`, `${connectionId}_key`, updates.apiKey);
      }
      
      // Update API secret if provided
      if (updates.apiSecret) {
        await this.credentialStore.storeCredential(`broker-${connection.brokerType}`, `${connectionId}_secret`, updates.apiSecret);
      }
      
      // Update additional params if provided
      if (updates.additionalParams) {
        updateFields.push('additional_params = ?');
        updateParams.push(JSON.stringify(updates.additionalParams));
      }
      
      // Update active status if provided
      if (updates.isActive !== undefined) {
        updateFields.push('is_active = ?');
        updateParams.push(updates.isActive ? 1 : 0);
        
        // If activating, update last connected timestamp
        if (updates.isActive) {
          updateFields.push('last_connected = ?');
          updateParams.push(new Date().toISOString());
        }
      }
      
      // If there are fields to update, run the update query
      if (updateFields.length > 0) {
        updateParams.push(connectionId); // For the WHERE clause
        await this.dbManager.executeQuery(
          `UPDATE broker_connections SET ${updateFields.join(', ')} WHERE id = ?`,
          updateParams
        );
      }
      
      // Log the update
      await this.dbManager.logEvent('info', `Broker connection updated: ${connection.name}`);
      
      // Return the updated connection
      return await this.getBrokerConnection(connectionId);
    } catch (error) {
      console.error(`Failed to update broker connection ${connectionId}:`, error);
      throw error;
    }
  }
  
  /**
   * Delete a broker connection
   * @param {string} connectionId - Connection ID
   * @returns {Promise<boolean>} Success status
   */
  async deleteBrokerConnection(connectionId) {
    try {
      // Get connection details for logging
      const connection = await this.getBrokerConnection(connectionId);
      
      // Delete the credentials from credential store
      await this.credentialStore.deleteCredential(`broker-${connection.brokerType}`, `${connectionId}_key`);
      await this.credentialStore.deleteCredential(`broker-${connection.brokerType}`, `${connectionId}_secret`);
      
      // Delete from database
      await this.dbManager.executeQuery(
        'DELETE FROM broker_connections WHERE id = ?',
        [connectionId]
      );
      
      // Log the event
      await this.dbManager.logEvent('info', `Broker connection deleted: ${connection.name}`);
      
      return true;
    } catch (error) {
      console.error(`Failed to delete broker connection ${connectionId}:`, error);
      throw error;
    }
  }
  
  /**
   * Test a broker connection
   * @param {string} connectionId - Connection ID
   * @returns {Promise<Object>} Test result
   */
  async testBrokerConnection(connectionId) {
    try {
      // Get connection with credentials
      const connection = await this.getBrokerConnection(connectionId);
      
      // Create a broker adapter instance if needed
      if (!this.brokerAdapter.hasConnection(connectionId)) {
        this.brokerAdapter.createConnection(connection.brokerType, connectionId, {
          name: connection.name,
          apiKey: connection.apiKey,
          apiSecret: connection.apiSecret,
          ...connection.additionalParams
        });
      }
      
      // Test the connection through the broker adapter
      let testResult;
      try {
        // Connect to broker
        testResult = await this.brokerAdapter.connect(connectionId, {
          timeout: 10000 // 10 seconds timeout for test
        });
        
        // Disconnect after test
        await this.brokerAdapter.disconnect(connectionId);
      } catch (connError) {
        testResult = { 
          success: false, 
          message: `Connection error: ${connError.message || 'Unknown error'}` 
        };
      }
      
      // If successful, update last connected timestamp
      if (testResult.success) {
        await this.dbManager.executeQuery(
          'UPDATE broker_connections SET last_connected = ? WHERE id = ?',
          [new Date().toISOString(), connectionId]
        );
      }
      
      return testResult;
    } catch (error) {
      console.error(`Failed to test broker connection ${connectionId}:`, error);
      return { success: false, message: error.message };
    }
  }
  
  /**
   * Test connection to Binance API
   * @private
   * @param {Object} connection - Connection details
   * @returns {Promise<Object>} Test result
   */
  async _testBinanceConnection(connection) {
    try {
      // In a real implementation, this would use the Binance API SDK
      // to make a simple authenticated request
      
      // For demo purposes, just simulate a successful connection
      // if credentials are provided
      if (connection.apiKey && connection.apiSecret) {
        return {
          success: true,
          message: 'Successfully connected to Binance API',
          details: {
            accountType: 'spot',
            permissions: ['spot', 'margin', 'futures']
          }
        };
      }
      
      return {
        success: false,
        message: 'Missing API credentials for Binance'
      };
    } catch (error) {
      return {
        success: false,
        message: `Binance connection error: ${error.message}`
      };
    }
  }
  
  /**
   * Test connection to MT4 Bridge
   * @private
   * @param {Object} connection - Connection details
   * @returns {Promise<Object>} Test result
   */
  async _testMT4Connection(connection) {
    try {
      // In a real implementation, this would attempt to connect to the MT4 Bridge
      // via websocket or other method
      
      // For demo purposes, simulate a connection based on additional params
      const params = connection.additionalParams || {};
      if (params.hostAddress && params.port) {
        return {
          success: true,
          message: 'Successfully connected to MT4 Bridge',
          details: {
            version: '1.0.0',
            serverTime: new Date().toISOString()
          }
        };
      }
      
      return {
        success: false,
        message: 'Missing connection details for MT4 Bridge'
      };
    } catch (error) {
      return {
        success: false,
        message: `MT4 connection error: ${error.message}`
      };
    }
  }
  
  /**
   * Get active broker connection status
   * @returns {Promise<Array<Object>>} Active connection statuses
   */
  async getActiveConnectionStatus() {
    try {
      const activeConnections = await this.dbManager.executeSelect(
        'SELECT id, name, broker_type FROM broker_connections WHERE is_active = 1'
      );
      
      return Promise.all(activeConnections.map(async conn => {
        const status = this.activeConnections.get(conn.id) || { 
          status: 'disconnected', 
          lastUpdated: null 
        };
        
        return {
          id: conn.id,
          name: conn.name,
          brokerType: conn.broker_type,
          connectionStatus: status.status,
          lastUpdated: status.lastUpdated
        };
      }));
    } catch (error) {
      console.error('Failed to get active connection status:', error);
      throw error;
    }
  }
  
  /**
   * Update connection status in memory cache
   * @param {string} connectionId - Connection ID
   * @param {string} status - Connection status
   */
  updateConnectionStatus(connectionId, status) {
    this.activeConnections.set(connectionId, {
      status,
      lastUpdated: new Date().toISOString()
    });
  }
}

module.exports = BrokerManager;