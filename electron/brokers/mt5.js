// electron/brokers/mt5.js
const { EventEmitter } = require('events');
const net = require('net');
const path = require('path');
const fs = require('fs');

/**
 * MetaTrader 5 broker integration
 * Connects to MT5 terminal via a custom bridge application
 */
class MT5BrokerAdapter {
  /**
   * Create a new MT5 broker adapter instance
   */
  constructor() {
    this.socket = null;
    this.connected = false;
    this.messageQueue = [];
    this.callbacks = new Map();
    this.nextRequestId = 1;
    this.eventEmitter = new EventEmitter();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;
    
    // Internal tracking of account info
    this.accountInfo = null;
    this.positions = [];
    this.orders = [];
    this.lastQuotes = {};
  }
  
  /**
   * Connect to MT5 terminal via bridge
   * @param {Object} config - Connection configuration
   * @param {string} config.host - Host address (default: localhost)
   * @param {number} config.port - Port number 
   * @param {boolean} config.secure - Use secure connection
   * @returns {Promise<Object>} - Connection result
   */
  async connect(config) {
    if (this.connected) {
      return { success: true, message: 'Already connected' };
    }
    
    try {
      const host = config.host || 'localhost';
      const port = config.port || 8222;
      
      return new Promise((resolve, reject) => {
        // Create socket connection
        this.socket = new net.Socket();
        
        // Set up connection timeout
        const connectionTimeout = setTimeout(() => {
          this.socket.destroy();
          reject({ success: false, message: 'Connection timeout' });
        }, 10000);
        
        // Connection event handlers
        this.socket.on('connect', () => {
          clearTimeout(connectionTimeout);
          this.connected = true;
          this.reconnectAttempts = 0;
          
          console.log(`Connected to MT5 bridge at ${host}:${port}`);
          
          // Authenticate if credentials provided
          if (config.login && config.password) {
            this._sendCommand('AUTHORIZE', {
              login: config.login,
              password: config.password
            })
            .then(response => {
              if (response.status === 'ok') {
                this.accountInfo = response.data;
                resolve({ 
                  success: true, 
                  message: 'Connected and authorized', 
                  accountInfo: this.accountInfo 
                });
              } else {
                this.disconnect();
                reject({ 
                  success: false, 
                  message: `Authorization failed: ${response.message}` 
                });
              }
            })
            .catch(error => {
              this.disconnect();
              reject({ 
                success: false, 
                message: `Authorization error: ${error.message}` 
              });
            });
          } else {
            resolve({ 
              success: true, 
              message: 'Connected to MT5 bridge' 
            });
          }
        });
        
        // Handle incoming data
        this.socket.on('data', (data) => {
          try {
            const messages = data.toString().split('\n');
            
            messages.forEach(message => {
              if (!message.trim()) return;
              
              try {
                const response = JSON.parse(message);
                
                // Handle response to a specific request
                if (response.requestId && this.callbacks.has(response.requestId)) {
                  const { resolve, reject } = this.callbacks.get(response.requestId);
                  this.callbacks.delete(response.requestId);
                  
                  if (response.error) {
                    reject(new Error(response.error));
                  } else {
                    resolve(response);
                  }
                } 
                // Handle server push notifications
                else if (response.event) {
                  this._handleEvent(response);
                }
              } catch (err) {
                console.error('Error parsing MT5 message:', err, message);
              }
            });
          } catch (err) {
            console.error('Error processing MT5 data:', err);
          }
        });
        
        // Handle errors
        this.socket.on('error', (error) => {
          console.error('MT5 connection error:', error);
          if (!this.connected) {
            clearTimeout(connectionTimeout);
            reject({ success: false, message: `Connection error: ${error.message}` });
          } else {
            this.eventEmitter.emit('error', error);
          }
        });
        
        // Handle connection close
        this.socket.on('close', () => {
          console.log('MT5 connection closed');
          const wasConnected = this.connected;
          this.connected = false;
          
          // Clean up callbacks
          this.callbacks.forEach((cb) => {
            cb.reject(new Error('Connection closed'));
          });
          this.callbacks.clear();
          
          if (wasConnected) {
            this.eventEmitter.emit('disconnected');
            
            // Try to reconnect
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
              this.reconnectAttempts++;
              console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
              
              setTimeout(() => {
                this.connect(config).catch(err => {
                  console.error('Reconnection failed:', err);
                });
              }, this.reconnectDelay * this.reconnectAttempts);
            }
          }
        });
        
        // Connect to the bridge
        this.socket.connect(port, host);
      });
    } catch (error) {
      console.error('MT5 connect error:', error);
      return { success: false, message: `MT5 connection error: ${error.message}` };
    }
  }
  
  /**
   * Disconnect from MT5
   * @returns {Promise<Object>} - Disconnect result
   */
  async disconnect() {
    if (!this.connected || !this.socket) {
      return { success: true, message: 'Not connected' };
    }
    
    return new Promise((resolve) => {
      // Prevent reconnection attempts on manual disconnect
      this.reconnectAttempts = this.maxReconnectAttempts;
      
      this.socket.once('close', () => {
        resolve({ success: true, message: 'Disconnected' });
      });
      
      this.socket.end();
    });
  }
  
  /**
   * Get account information
   * @returns {Promise<Object>} - Account information
   */
  async getAccountInfo() {
    if (!this.connected) {
      throw new Error('Not connected to MT5');
    }
    
    try {
      const response = await this._sendCommand('GET_ACCOUNT_INFO');
      this.accountInfo = response.data;
      return this.accountInfo;
    } catch (error) {
      console.error('Error getting account info:', error);
      throw error;
    }
  }
  
  /**
   * Get open positions
   * @returns {Promise<Array>} - List of open positions
   */
  async getPositions() {
    if (!this.connected) {
      throw new Error('Not connected to MT5');
    }
    
    try {
      const response = await this._sendCommand('GET_POSITIONS');
      this.positions = response.data;
      return this.positions;
    } catch (error) {
      console.error('Error getting positions:', error);
      throw error;
    }
  }
  
  /**
   * Get pending orders
   * @returns {Promise<Array>} - List of pending orders
   */
  async getOrders() {
    if (!this.connected) {
      throw new Error('Not connected to MT5');
    }
    
    try {
      const response = await this._sendCommand('GET_ORDERS');
      this.orders = response.data;
      return this.orders;
    } catch (error) {
      console.error('Error getting orders:', error);
      throw error;
    }
  }
  
  /**
   * Get market data for specified symbols
   * @param {Array<string>} symbols - List of symbols to get data for
   * @returns {Promise<Object>} - Market data
   */
  async getMarketData(symbols) {
    if (!this.connected) {
      throw new Error('Not connected to MT5');
    }
    
    try {
      const response = await this._sendCommand('GET_MARKET_DATA', { symbols });
      
      // Update last quotes
      if (response.data) {
        for (const symbol in response.data) {
          this.lastQuotes[symbol] = response.data[symbol];
        }
      }
      
      return response.data;
    } catch (error) {
      console.error('Error getting market data:', error);
      throw error;
    }
  }
  
  /**
   * Subscribe to market data updates
   * @param {Array<string>} symbols - List of symbols to subscribe to
   * @returns {Promise<Object>} - Subscription result
   */
  async subscribeMarketData(symbols) {
    if (!this.connected) {
      throw new Error('Not connected to MT5');
    }
    
    try {
      return await this._sendCommand('SUBSCRIBE_MARKET_DATA', { symbols });
    } catch (error) {
      console.error('Error subscribing to market data:', error);
      throw error;
    }
  }
  
  /**
   * Unsubscribe from market data updates
   * @param {Array<string>} symbols - List of symbols to unsubscribe from
   * @returns {Promise<Object>} - Unsubscription result
   */
  async unsubscribeMarketData(symbols) {
    if (!this.connected) {
      throw new Error('Not connected to MT5');
    }
    
    try {
      return await this._sendCommand('UNSUBSCRIBE_MARKET_DATA', { symbols });
    } catch (error) {
      console.error('Error unsubscribing from market data:', error);
      throw error;
    }
  }
  
  /**
   * Place a new market order
   * @param {Object} orderParams - Order parameters
   * @returns {Promise<Object>} - Order result
   */
  async placeMarketOrder(orderParams) {
    if (!this.connected) {
      throw new Error('Not connected to MT5');
    }
    
    try {
      const params = {
        type: 'MARKET',
        symbol: orderParams.symbol,
        volume: orderParams.volume,
        direction: orderParams.direction.toUpperCase(),
        stopLoss: orderParams.stopLoss,
        takeProfit: orderParams.takeProfit,
        comment: orderParams.comment || 'SAITRAPP'
      };
      
      const response = await this._sendCommand('PLACE_ORDER', params);
      return response.data;
    } catch (error) {
      console.error('Error placing market order:', error);
      throw error;
    }
  }
  
  /**
   * Place a new pending order
   * @param {Object} orderParams - Order parameters
   * @returns {Promise<Object>} - Order result
   */
  async placePendingOrder(orderParams) {
    if (!this.connected) {
      throw new Error('Not connected to MT5');
    }
    
    try {
      const params = {
        type: orderParams.type, // 'LIMIT', 'STOP', 'STOP_LIMIT'
        symbol: orderParams.symbol,
        volume: orderParams.volume,
        direction: orderParams.direction.toUpperCase(),
        price: orderParams.price,
        stopLoss: orderParams.stopLoss,
        takeProfit: orderParams.takeProfit,
        expirationTime: orderParams.expirationTime,
        comment: orderParams.comment || 'SAITRAPP'
      };
      
      const response = await this._sendCommand('PLACE_ORDER', params);
      return response.data;
    } catch (error) {
      console.error('Error placing pending order:', error);
      throw error;
    }
  }
  
  /**
   * Modify an existing order
   * @param {Object} orderParams - Order parameters
   * @returns {Promise<Object>} - Order result
   */
  async modifyOrder(orderParams) {
    if (!this.connected) {
      throw new Error('Not connected to MT5');
    }
    
    try {
      const response = await this._sendCommand('MODIFY_ORDER', orderParams);
      return response.data;
    } catch (error) {
      console.error('Error modifying order:', error);
      throw error;
    }
  }
  
  /**
   * Cancel an order
   * @param {number} orderId - Order ID to cancel
   * @returns {Promise<Object>} - Cancellation result
   */
  async cancelOrder(orderId) {
    if (!this.connected) {
      throw new Error('Not connected to MT5');
    }
    
    try {
      const response = await this._sendCommand('CANCEL_ORDER', { orderId });
      return response.data;
    } catch (error) {
      console.error('Error cancelling order:', error);
      throw error;
    }
  }
  
  /**
   * Close a position
   * @param {number} positionId - Position ID to close
   * @param {number} volume - Volume to close (partial close if less than position volume)
   * @returns {Promise<Object>} - Close result
   */
  async closePosition(positionId, volume = null) {
    if (!this.connected) {
      throw new Error('Not connected to MT5');
    }
    
    try {
      const params = { positionId };
      if (volume !== null) {
        params.volume = volume;
      }
      
      const response = await this._sendCommand('CLOSE_POSITION', params);
      return response.data;
    } catch (error) {
      console.error('Error closing position:', error);
      throw error;
    }
  }
  
  /**
   * Get historical data for a symbol
   * @param {Object} params - Query parameters
   * @param {string} params.symbol - Symbol to get data for
   * @param {string} params.timeframe - Timeframe (M1, M5, M15, H1, D1, etc.)
   * @param {number} params.count - Number of bars to get
   * @param {Date|string} params.from - Start date
   * @param {Date|string} params.to - End date
   * @returns {Promise<Array>} - Historical bars
   */
  async getHistoricalData(params) {
    if (!this.connected) {
      throw new Error('Not connected to MT5');
    }
    
    try {
      const response = await this._sendCommand('GET_HISTORICAL_DATA', params);
      return response.data;
    } catch (error) {
      console.error('Error getting historical data:', error);
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
  
  /**
   * Send command to MT5 bridge
   * @private
   * @param {string} command - Command name
   * @param {Object} params - Command parameters
   * @returns {Promise<Object>} - Command result
   */
  _sendCommand(command, params = {}) {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('Not connected to MT5'));
    }
    
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++;
      
      const message = {
        requestId,
        command,
        params
      };
      
      this.callbacks.set(requestId, { resolve, reject });
      
      // Set timeout for request
      const timeout = setTimeout(() => {
        if (this.callbacks.has(requestId)) {
          this.callbacks.delete(requestId);
          reject(new Error(`MT5 request timeout: ${command}`));
        }
      }, 30000);
      
      // Send the message
      try {
        this.socket.write(JSON.stringify(message) + '\n');
      } catch (err) {
        clearTimeout(timeout);
        this.callbacks.delete(requestId);
        reject(err);
      }
    });
  }
  
  /**
   * Handle event from MT5 bridge
   * @private
   * @param {Object} event - Event object
   */
  _handleEvent(event) {
    switch (event.event) {
      case 'TICK':
        // Update last quotes
        this.lastQuotes[event.data.symbol] = event.data;
        this.eventEmitter.emit('tick', event.data);
        break;
        
      case 'POSITION_CHANGED':
        this.eventEmitter.emit('position', event.data);
        break;
        
      case 'ORDER_CHANGED':
        this.eventEmitter.emit('order', event.data);
        break;
        
      case 'ACCOUNT_CHANGED':
        this.accountInfo = event.data;
        this.eventEmitter.emit('account', event.data);
        break;
        
      default:
        this.eventEmitter.emit(event.event.toLowerCase(), event.data);
        break;
    }
  }
}

module.exports = MT5BrokerAdapter;