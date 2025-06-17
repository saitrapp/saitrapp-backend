// electron/broker-adapter.js
const path = require('path');
const { EventEmitter } = require('events');

// Import broker implementations
const MT5BrokerAdapter = require('./brokers/mt5');

/**
 * BrokerAdapter serves as the main interface for interacting with different broker implementations
 * It manages broker-specific implementations and provides a unified API for the application
 */
class BrokerAdapter extends EventEmitter {
  /**
   * Create a new BrokerAdapter instance
   * @param {Object} config - Adapter configuration
   */
  constructor(config = {}) {
    super();
    this.brokers = new Map();
    this.activeConnections = new Map();
    this.config = config;
    
    // Register supported broker adapters
    this.registerBrokerImplementations();
  }
  
  /**
   * Register all supported broker implementations
   */
  registerBrokerImplementations() {
    // Built-in adapters
    this.registerBrokerAdapter('mt5', MT5BrokerAdapter);
    
    // Explicitly load MT4 adapter
    try {
      const MT4BrokerAdapter = require('./brokers/mt4');
      this.registerBrokerAdapter('mt4', MT4BrokerAdapter);
    } catch (error) {
      console.log('MT4 broker implementation not available');
    }
    
    // Explicitly load FOREX.com adapter
    try {
      const ForexDotComAdapter = require('./brokers/forexdotcom');
      this.registerBrokerAdapter('forex-com', ForexDotComAdapter);
    } catch (error) {
      console.log('FOREX.com broker implementation not available');
    }
    
    // Dynamically load other adapters if available
    const brokerTypes = ['interactive-brokers', 'fxify'];
    
    brokerTypes.forEach(brokerType => {
      try {
        // Attempt to load the broker implementation
        const BrokerImpl = require(`./brokers/${brokerType}`);
        this.registerBrokerAdapter(brokerType, BrokerImpl);
      } catch (error) {
        // Skip if implementation is not available
        console.log(`Broker implementation not available: ${brokerType}`);
      }
    });
  }
  
  /**
   * Register a broker adapter implementation
   * @param {string} brokerType - Broker type identifier
   * @param {Class} BrokerImpl - Broker implementation class
   */
  registerBrokerAdapter(brokerType, BrokerImpl) {
    this.brokers.set(brokerType, BrokerImpl);
  }
  
  /**
   * Get a list of supported broker types
   * @returns {Array<string>} - List of supported broker types
   */
  getSupportedBrokers() {
    return Array.from(this.brokers.keys());
  }
  
  /**
   * Create a new broker connection
   * @param {string} brokerType - Broker type
   * @param {string} connectionId - Unique connection identifier
   * @param {Object} config - Connection configuration
   * @returns {Object} - Broker connection instance
   */
  createConnection(brokerType, connectionId, config) {
    if (!this.brokers.has(brokerType)) {
      throw new Error(`Unsupported broker type: ${brokerType}`);
    }
    
    // Create new instance of broker adapter
    const BrokerImpl = this.brokers.get(brokerType);
    const brokerAdapter = new BrokerImpl();
    
    // Set up event forwarding
    brokerAdapter.on('error', (error) => {
      this.emit('connection:error', { connectionId, error });
    });
    
    brokerAdapter.on('disconnected', () => {
      this.emit('connection:disconnected', { connectionId });
    });
    
    // Forward specific events with connection context
    const eventsToForward = ['tick', 'position', 'order', 'account'];
    eventsToForward.forEach(eventName => {
      brokerAdapter.on(eventName, (data) => {
        this.emit(`${connectionId}:${eventName}`, data);
        this.emit(eventName, { connectionId, ...data });
      });
    });
    
    // Store the connection
    this.activeConnections.set(connectionId, {
      instance: brokerAdapter,
      type: brokerType,
      config,
      connected: false
    });
    
    return brokerAdapter;
  }
  
  /**
   * Get an existing broker connection
   * @param {string} connectionId - Connection identifier
   * @returns {Object} - Broker connection instance
   */
  getConnection(connectionId) {
    const connection = this.activeConnections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection not found: ${connectionId}`);
    }
    return connection.instance;
  }
  
  /**
   * Check if a connection exists
   * @param {string} connectionId - Connection identifier
   * @returns {boolean} - True if connection exists
   */
  hasConnection(connectionId) {
    return this.activeConnections.has(connectionId);
  }
  
  /**
   * Connect to a broker
   * @param {string} connectionId - Connection identifier
   * @param {Object} config - Connection configuration
   * @returns {Promise<Object>} - Connection result
   */
  async connect(connectionId, config) {
    try {
      const connection = this.activeConnections.get(connectionId);
      if (!connection) {
        throw new Error(`Connection not found: ${connectionId}`);
      }
      
      // Merge connection config with connect-specific config
      const connectConfig = { ...connection.config, ...config };
      
      // Connect to broker
      const result = await connection.instance.connect(connectConfig);
      
      // Update connection status
      if (result.success) {
        connection.connected = true;
        this.emit('connection:connected', { connectionId, brokerType: connection.type });
      }
      
      return result;
    } catch (error) {
      this.emit('connection:error', { 
        connectionId, 
        error: error.message || 'Connection error' 
      });
      throw error;
    }
  }
  
  /**
   * Disconnect from a broker
   * @param {string} connectionId - Connection identifier
   * @returns {Promise<Object>} - Disconnect result
   */
  async disconnect(connectionId) {
    try {
      const connection = this.activeConnections.get(connectionId);
      if (!connection) {
        throw new Error(`Connection not found: ${connectionId}`);
      }
      
      // Disconnect from broker
      const result = await connection.instance.disconnect();
      
      // Update connection status
      connection.connected = false;
      
      return result;
    } catch (error) {
      this.emit('connection:error', { 
        connectionId, 
        error: error.message || 'Disconnection error' 
      });
      throw error;
    }
  }
  
  /**
   * Remove a broker connection
   * @param {string} connectionId - Connection identifier
   * @returns {boolean} - Success status
   */
  removeConnection(connectionId) {
    const connection = this.activeConnections.get(connectionId);
    if (!connection) {
      return false;
    }
    
    // Disconnect if connected
    if (connection.connected) {
      try {
        connection.instance.disconnect();
      } catch (error) {
        console.error(`Error disconnecting from ${connectionId}:`, error);
      }
    }
    
    // Remove connection
    this.activeConnections.delete(connectionId);
    return true;
  }
  
  /**
   * Execute a method on a broker connection
   * @param {string} connectionId - Connection identifier
   * @param {string} method - Method name
   * @param {Array} args - Method arguments
   * @returns {Promise<any>} - Method result
   */
  async executeMethod(connectionId, method, ...args) {
    const connection = this.activeConnections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection not found: ${connectionId}`);
    }
    
    if (!connection.connected) {
      throw new Error(`Connection not active: ${connectionId}`);
    }
    
    if (typeof connection.instance[method] !== 'function') {
      throw new Error(`Method not supported: ${method}`);
    }
    
    try {
      return await connection.instance[method](...args);
    } catch (error) {
      this.emit('connection:error', { 
        connectionId, 
        method,
        error: error.message || `Error executing ${method}`
      });
      throw error;
    }
  }
  
  /**
   * Get all active connections
   * @returns {Array<Object>} - List of active connections
   */
  getActiveConnections() {
    const connections = [];
    this.activeConnections.forEach((connection, connectionId) => {
      connections.push({
        id: connectionId,
        type: connection.type,
        connected: connection.connected
      });
    });
    return connections;
  }
  
  /**
   * Check if a connection is active
   * @param {string} connectionId - Connection identifier
   * @returns {boolean} - Connection status
   */
  isConnectionActive(connectionId) {
    const connection = this.activeConnections.get(connectionId);
    return connection ? connection.connected : false;
  }
}

module.exports = BrokerAdapter;