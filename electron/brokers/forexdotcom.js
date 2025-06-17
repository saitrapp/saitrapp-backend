// electron/brokers/forexdotcom.js
const { EventEmitter } = require('events');
const MT5BrokerAdapter = require('./mt5');

/**
 * ForexDotComAdapter provides integration with FOREX.com broker services
 * This implementation leverages MT5 protocol since FOREX.com uses MT5 platform
 */
class ForexDotComAdapter extends EventEmitter {
  /**
   * Create a new FOREX.com adapter instance
   */
  constructor() {
    super();
    // Use MT5 adapter internally since FOREX.com uses MT5
    this.mt5Adapter = new MT5BrokerAdapter();
    
    // Forward all MT5 events
    const events = ['error', 'disconnected', 'tick', 'position', 'order', 'account'];
    events.forEach(event => {
      this.mt5Adapter.on(event, (data) => this.emit(event, data));
    });
  }
  
  /**
   * Connect to FOREX.com broker
   * @param {Object} config - Connection configuration containing MT5 credentials
   * @param {string} config.login - MT5 login/account number
   * @param {string} config.password - MT5 password
   * @param {string} config.server - MT5 server address (typically 'live' or 'demo')
   * @returns {Promise<Object>} - Connection result
   */
  async connect(config) {
    try {
      if (!config.login) {
        throw new Error('MT5 login is required for FOREX.com connection');
      }
      
      if (!config.password) {
        throw new Error('MT5 password is required for FOREX.com connection');
      }
      
      if (!config.server) {
        // Default to 'demo' if not specified
        config.server = 'demo';
      }
      
      // Map FOREX.com server names to actual MT5 server addresses if needed
      let mt5Server = config.server;
      if (config.server === 'live') {
        mt5Server = 'mt5.forex.com';
      } else if (config.server === 'demo') {
        mt5Server = 'mt5demo.forex.com';
      }
      
      // Connect to MT5 server with credentials
      const mt5Config = {
        login: config.login,
        password: config.password,
        server: mt5Server
      };
      
      const result = await this.mt5Adapter.connect(mt5Config);
      return result;
    } catch (error) {
      this.emit('error', error);
      return {
        success: false,
        error: error.message || 'Failed to connect to FOREX.com'
      };
    }
  }
  
  /**
   * Disconnect from broker
   * @returns {Promise<Object>} - Disconnect result
   */
  async disconnect() {
    try {
      const result = await this.mt5Adapter.disconnect();
      return result;
    } catch (error) {
      this.emit('error', error);
      return {
        success: false,
        error: error.message || 'Failed to disconnect from FOREX.com'
      };
    }
  }
  
  /**
   * Get account information
   * @returns {Promise<Object>} - Account information
   */
  async getAccountInfo() {
    try {
      return await this.mt5Adapter.getAccountInfo();
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Get open positions
   * @returns {Promise<Array>} - List of open positions
   */
  async getPositions() {
    try {
      return await this.mt5Adapter.getPositions();
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Get pending orders
   * @returns {Promise<Array>} - List of pending orders
   */
  async getOrders() {
    try {
      return await this.mt5Adapter.getOrders();
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Get historical orders
   * @param {Object} params - Query parameters
   * @returns {Promise<Array>} - List of historical orders
   */
  async getHistoricalOrders(params) {
    try {
      return await this.mt5Adapter.getHistoricalOrders(params);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Get historical trades/deals
   * @param {Object} params - Query parameters
   * @returns {Promise<Array>} - List of historical trades
   */
  async getHistoricalTrades(params) {
    try {
      return await this.mt5Adapter.getHistoricalTrades(params);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Place a new market order
   * @param {Object} orderParams - Order parameters
   * @returns {Promise<Object>} - Order result
   */
  async placeMarketOrder(orderParams) {
    try {
      return await this.mt5Adapter.placeMarketOrder(orderParams);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Place a new pending order
   * @param {Object} orderParams - Order parameters
   * @returns {Promise<Object>} - Order result
   */
  async placePendingOrder(orderParams) {
    try {
      return await this.mt5Adapter.placePendingOrder(orderParams);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Modify an existing order
   * @param {Object} orderParams - Order parameters
   * @returns {Promise<Object>} - Modification result
   */
  async modifyOrder(orderParams) {
    try {
      return await this.mt5Adapter.modifyOrder(orderParams);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Cancel/close an existing order
   * @param {Object} orderParams - Order parameters
   * @returns {Promise<Object>} - Cancellation result
   */
  async cancelOrder(orderParams) {
    try {
      return await this.mt5Adapter.cancelOrder(orderParams);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Close an existing position
   * @param {Object} positionParams - Position parameters
   * @returns {Promise<Object>} - Close result
   */
  async closePosition(positionParams) {
    try {
      return await this.mt5Adapter.closePosition(positionParams);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Get market data for a symbol
   * @param {string} symbol - Market symbol
   * @returns {Promise<Object>} - Market data
   */
  async getMarketData(symbol) {
    try {
      return await this.mt5Adapter.getMarketData(symbol);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Subscribe to market data for a symbol
   * @param {string} symbol - Market symbol
   * @returns {Promise<Object>} - Subscription result
   */
  async subscribeMarketData(symbol) {
    try {
      return await this.mt5Adapter.subscribeMarketData(symbol);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Unsubscribe from market data for a symbol
   * @param {string} symbol - Market symbol
   * @returns {Promise<Object>} - Unsubscription result
   */
  async unsubscribeMarketData(symbol) {
    try {
      return await this.mt5Adapter.unsubscribeMarketData(symbol);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Get available symbols
   * @returns {Promise<Array>} - List of available symbols
   */
  async getSymbols() {
    try {
      return await this.mt5Adapter.getSymbols();
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
}

module.exports = ForexDotComAdapter;