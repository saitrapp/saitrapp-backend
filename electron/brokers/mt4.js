// electron/brokers/mt4.js
const { EventEmitter } = require('events');
const net = require('net');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * MetaTrader 4 broker adapter for SAITRAPP
 * Interfaces with MT4 using ZMQ or direct socket connections
 */
class MT4BrokerAdapter extends EventEmitter {
  /**
   * Create a new MT4 adapter instance
   */
  constructor() {
    super();
    this.connected = false;
    this.socket = null;
    this.pingInterval = null;
    this.connectionConfig = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000;
    this.lastMessageTime = 0;
    this.messageQueue = [];
    this.processingQueue = false;
    this.requestId = 1;
    this.callbacks = new Map();
    this.positions = new Map();
    this.orders = new Map();
    this.accountInfo = {};
    this.terminalInfo = {};
    this.symbolInfo = new Map();
  }

  /**
   * Connect to MT4 server
   * @param {Object} config - Connection configuration
   * @param {string} config.host - Host address (default: localhost)
   * @param {number} config.port - Port number (default: 5555)
   * @param {string} config.password - Connection password (optional)
   * @param {string} config.account - MT4 account number (optional)
   * @param {string} config.terminalPath - Path to MT4 terminal (optional)
   * @returns {Promise<Object>} - Connection result
   */
  async connect(config = {}) {
    if (this.connected) {
      return { success: true, message: 'Already connected' };
    }

    try {
      const host = config.host || 'localhost';
      const port = config.port || 5555;
      
      // Store config for reconnection attempts
      this.connectionConfig = { ...config };

      return new Promise((resolve, reject) => {
        // Create socket
        this.socket = new net.Socket();
        
        // Set connection timeout
        const connectionTimeout = setTimeout(() => {
          this.socket?.destroy();
          reject(new Error('Connection timeout'));
        }, 15000);
        
        // Set up event handlers
        this.socket.on('connect', () => {
          clearTimeout(connectionTimeout);
          this._setupConnection();
          
          // Send authentication if password provided
          if (config.password) {
            this._sendCommand('AUTH', { password: config.password })
              .then(result => {
                if (!result.success) {
                  this.socket.destroy();
                  reject(new Error('Authentication failed: ' + result.message));
                  return;
                }
                
                this._completeConnection(resolve);
              })
              .catch(error => {
                this.socket.destroy();
                reject(new Error('Authentication error: ' + error.message));
              });
          } else {
            // No authentication needed
            this._completeConnection(resolve);
          }
        });
        
        this.socket.on('data', (data) => {
          this._handleData(data);
        });
        
        this.socket.on('error', (error) => {
          console.error('MT4 socket error:', error);
          if (!this.connected) {
            clearTimeout(connectionTimeout);
            reject(new Error(`Connection error: ${error.message}`));
          } else {
            this.emit('error', { message: error.message });
          }
        });
        
        this.socket.on('close', () => {
          this._handleDisconnect();
        });
        
        // Attempt connection
        this.socket.connect(port, host);
      });
    } catch (error) {
      console.error('MT4 connection error:', error);
      throw error;
    }
  }

  /**
   * Complete the connection setup
   * @private
   * @param {Function} resolve - Promise resolve function
   */
  async _completeConnection(resolve) {
    // Get terminal info
    try {
      this.terminalInfo = await this._sendCommand('TERMINAL_INFO');
      
      // Start heartbeat interval
      this.pingInterval = setInterval(() => {
        this._ping();
      }, 30000);
      
      // Mark as connected
      this.connected = true;
      this.reconnectAttempts = 0;
      
      // Subscribe to terminal events
      this._subscribe();
      
      // Start processing queue
      this._processQueue();
      
      // Resolve with success
      resolve({ 
        success: true, 
        message: 'Connected to MT4',
        terminalInfo: this.terminalInfo
      });
    } catch (error) {
      this.socket?.destroy();
      throw new Error(`Failed to initialize connection: ${error.message}`);
    }
  }

  /**
   * Handle disconnect events
   * @private
   */
  _handleDisconnect() {
    // Clear ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    const wasConnected = this.connected;
    this.connected = false;
    
    // Clear callbacks
    this.callbacks.forEach(callback => {
      callback.reject(new Error('Connection closed'));
    });
    this.callbacks.clear();
    
    if (wasConnected) {
      this.emit('disconnected');
      
      // Try to reconnect if not explicitly disconnected
      if (!this.explicitDisconnect && this.connectionConfig && 
          this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        console.log(`Attempting to reconnect to MT4 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        setTimeout(() => {
          this.connect(this.connectionConfig).catch(err => {
            console.error('MT4 reconnection failed:', err);
          });
        }, this.reconnectDelay * this.reconnectAttempts);
      }
    }
  }

  /**
   * Setup the connection and socket options
   * @private
   */
  _setupConnection() {
    // Set socket options
    this.socket.setKeepAlive(true, 60000);
    this.socket.setNoDelay(true);
    
    // Reset connection state
    this.lastMessageTime = Date.now();
    this.messageBuffer = Buffer.alloc(0);
  }

  /**
   * Send a ping to keep the connection alive
   * @private
   */
  async _ping() {
    if (!this.connected || !this.socket) {
      return;
    }
    
    // Check if we haven't received data for a while
    const now = Date.now();
    if (now - this.lastMessageTime > 120000) {
      // No response for 2 minutes, consider connection dead
      console.warn('MT4 connection timeout - no response for 2 minutes');
      this.socket.destroy();
      return;
    }
    
    try {
      await this._sendCommand('PING');
    } catch (error) {
      console.error('MT4 ping failed:', error);
    }
  }

  /**
   * Subscribe to MT4 events
   * @private
   */
  async _subscribe() {
    if (!this.connected) return;
    
    try {
      // Subscribe to terminal events
      await this._sendCommand('SUBSCRIBE', {
        events: ['TICK', 'ACCOUNT_UPDATE', 'POSITIONS_UPDATE', 'ORDERS_UPDATE']
      });
    } catch (error) {
      console.error('Error subscribing to MT4 events:', error);
      this.emit('error', { message: `Subscription error: ${error.message}` });
    }
  }

  /**
   * Disconnect from MT4
   * @returns {Promise<Object>} - Disconnect result
   */
  async disconnect() {
    if (!this.connected || !this.socket) {
      return { success: true, message: 'Not connected' };
    }
    
    this.explicitDisconnect = true;
    
    return new Promise((resolve) => {
      // Clean up ping interval
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      
      // Send a proper disconnect command if possible
      if (this.connected && this.socket) {
        try {
          this._sendRawMessage(JSON.stringify({
            command: 'DISCONNECT',
            requestId: this._generateRequestId()
          }));
        } catch (e) {
          // Ignore errors when disconnecting
        }
      }
      
      // Set event handler for connection close
      const onClose = () => {
        this.socket.removeListener('close', onClose);
        this.connected = false;
        resolve({ success: true, message: 'Disconnected from MT4' });
      };
      
      this.socket.once('close', onClose);
      
      // Close the socket
      this.socket.end();
      
      // Force close after 5 seconds if socket doesn't close gracefully
      setTimeout(() => {
        if (this.socket) {
          this.socket.destroy();
        }
      }, 5000);
    });
  }

  /**
   * Get account information
   * @returns {Promise<Object>} - Account information
   */
  async getAccountInfo() {
    if (!this.connected) {
      throw new Error('Not connected to MT4');
    }
    
    try {
      const result = await this._sendCommand('ACCOUNT_INFO');
      
      // Store account info
      this.accountInfo = result;
      
      // Emit account update event
      this.emit('account', result);
      
      return result;
    } catch (error) {
      console.error('Failed to get account info:', error);
      throw error;
    }
  }

  /**
   * Get open positions
   * @returns {Promise<Array>} - List of open positions
   */
  async getPositions() {
    if (!this.connected) {
      throw new Error('Not connected to MT4');
    }
    
    try {
      const result = await this._sendCommand('GET_POSITIONS');
      
      // Update positions cache
      result.forEach(position => {
        this.positions.set(position.ticket, position);
      });
      
      return result;
    } catch (error) {
      console.error('Failed to get positions:', error);
      throw error;
    }
  }

  /**
   * Get pending orders
   * @returns {Promise<Array>} - List of pending orders
   */
  async getOrders() {
    if (!this.connected) {
      throw new Error('Not connected to MT4');
    }
    
    try {
      const result = await this._sendCommand('GET_ORDERS');
      
      // Update orders cache
      result.forEach(order => {
        this.orders.set(order.ticket, order);
      });
      
      return result;
    } catch (error) {
      console.error('Failed to get orders:', error);
      throw error;
    }
  }

  /**
   * Get market data for a symbol
   * @param {string} symbol - Symbol name
   * @returns {Promise<Object>} - Market data
   */
  async getMarketData(symbol) {
    if (!this.connected) {
      throw new Error('Not connected to MT4');
    }
    
    try {
      return await this._sendCommand('GET_MARKET_DATA', { symbol });
    } catch (error) {
      console.error(`Failed to get market data for ${symbol}:`, error);
      throw error;
    }
  }

  /**
   * Get symbol information
   * @param {string} symbol - Symbol name
   * @returns {Promise<Object>} - Symbol information
   */
  async getSymbolInfo(symbol) {
    if (!this.connected) {
      throw new Error('Not connected to MT4');
    }
    
    try {
      const result = await this._sendCommand('SYMBOL_INFO', { symbol });
      
      // Cache symbol info
      this.symbolInfo.set(symbol, result);
      
      return result;
    } catch (error) {
      console.error(`Failed to get symbol info for ${symbol}:`, error);
      throw error;
    }
  }

  /**
   * Get available symbols
   * @returns {Promise<Array<string>>} - List of available symbols
   */
  async getSymbols() {
    if (!this.connected) {
      throw new Error('Not connected to MT4');
    }
    
    try {
      return await this._sendCommand('GET_SYMBOLS');
    } catch (error) {
      console.error('Failed to get symbols list:', error);
      throw error;
    }
  }

  /**
   * Open a new position
   * @param {Object} params - Order parameters
   * @param {string} params.symbol - Symbol name
   * @param {string} params.type - Order type (BUY, SELL)
   * @param {number} params.volume - Order volume in lots
   * @param {number} params.price - Order price (0 for market orders)
   * @param {number} params.slippage - Maximum price slippage in points
   * @param {number} params.stopLoss - Stop loss level (0 if none)
   * @param {number} params.takeProfit - Take profit level (0 if none)
   * @param {string} params.comment - Order comment
   * @returns {Promise<Object>} - Order result
   */
  async openPosition(params) {
    if (!this.connected) {
      throw new Error('Not connected to MT4');
    }
    
    // Default parameters
    const orderParams = {
      symbol: params.symbol || 'EURUSD',
      type: (params.type || 'BUY').toUpperCase(),
      volume: params.volume || 0.01,
      price: params.price || 0, // 0 means market price
      slippage: params.slippage || 3,
      stopLoss: params.stopLoss || 0,
      takeProfit: params.takeProfit || 0,
      comment: params.comment || 'SAITRAPP'
    };
    
    try {
      return await this._sendCommand('OPEN_POSITION', orderParams);
    } catch (error) {
      console.error('Failed to open position:', error);
      throw error;
    }
  }

  /**
   * Close a position
   * @param {number} ticket - Position ticket
   * @param {number} volume - Volume to close (optional, if not specified, entire position will be closed)
   * @returns {Promise<Object>} - Close result
   */
  async closePosition(ticket, volume = 0) {
    if (!this.connected) {
      throw new Error('Not connected to MT4');
    }
    
    try {
      return await this._sendCommand('CLOSE_POSITION', {
        ticket,
        volume
      });
    } catch (error) {
      console.error(`Failed to close position ${ticket}:`, error);
      throw error;
    }
  }

  /**
   * Modify a position
   * @param {number} ticket - Position ticket
   * @param {number} stopLoss - New stop loss level
   * @param {number} takeProfit - New take profit level
   * @returns {Promise<Object>} - Modification result
   */
  async modifyPosition(ticket, stopLoss, takeProfit) {
    if (!this.connected) {
      throw new Error('Not connected to MT4');
    }
    
    try {
      return await this._sendCommand('MODIFY_POSITION', {
        ticket,
        stopLoss,
        takeProfit
      });
    } catch (error) {
      console.error(`Failed to modify position ${ticket}:`, error);
      throw error;
    }
  }

  /**
   * Send raw message to MT4
   * @private
   * @param {string} message - Message to send
   */
  _sendRawMessage(message) {
    if (!this.socket || !this.socket.writable) {
      throw new Error('Socket is not writable');
    }
    
    try {
      const messageBuffer = Buffer.from(message + '\n');
      this.socket.write(messageBuffer);
    } catch (error) {
      console.error('Error sending message to MT4:', error);
      throw error;
    }
  }

  /**
   * Send a command to MT4
   * @private
   * @param {string} command - Command name
   * @param {Object} params - Command parameters
   * @returns {Promise<any>} - Command result
   */
  _sendCommand(command, params = {}) {
    if (!this.connected && command !== 'AUTH') {
      // Allow AUTH commands before connected state
      throw new Error('Not connected to MT4');
    }
    
    return new Promise((resolve, reject) => {
      const requestId = this._generateRequestId();
      
      // Create message
      const message = {
        command,
        requestId,
        params
      };
      
      // Store callback
      this.callbacks.set(requestId, { resolve, reject, timestamp: Date.now() });
      
      // Add to message queue
      this.messageQueue.push(JSON.stringify(message));
      
      // Process queue
      if (!this.processingQueue) {
        this._processQueue();
      }
      
      // Set up timeout
      setTimeout(() => {
        if (this.callbacks.has(requestId)) {
          const callback = this.callbacks.get(requestId);
          this.callbacks.delete(requestId);
          reject(new Error(`Command ${command} timed out`));
        }
      }, 30000);
    });
  }

  /**
   * Process message queue
   * @private
   */
  async _processQueue() {
    if (this.processingQueue || this.messageQueue.length === 0 || !this.connected) {
      return;
    }
    
    this.processingQueue = true;
    
    try {
      while (this.messageQueue.length > 0) {
        const message = this.messageQueue.shift();
        this._sendRawMessage(message);
        
        // Small delay to prevent overwhelming the socket
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    } catch (error) {
      console.error('Error processing message queue:', error);
    } finally {
      this.processingQueue = false;
    }
  }

  /**
   * Generate a unique request ID
   * @private
   * @returns {number} - Request ID
   */
  _generateRequestId() {
    return this.requestId++;
  }

  /**
   * Handle incoming data from MT4
   * @private
   * @param {Buffer} data - Incoming data
   */
  _handleData(data) {
    this.lastMessageTime = Date.now();
    
    const messages = data.toString().split('\n');
    
    for (const message of messages) {
      if (!message) continue;
      
      try {
        const response = JSON.parse(message);
        
        // Handle response
        if (response.requestId && this.callbacks.has(response.requestId)) {
          const callback = this.callbacks.get(response.requestId);
          this.callbacks.delete(response.requestId);
          
          if (response.error) {
            callback.reject(new Error(response.error));
          } else {
            callback.resolve(response.result);
          }
        } 
        // Handle event
        else if (response.event) {
          this._handleEvent(response.event, response.data);
        }
      } catch (error) {
        console.error('Error parsing MT4 response:', error, message);
      }
    }
  }

  /**
   * Handle incoming events from MT4
   * @private
   * @param {string} eventType - Event type
   * @param {Object} data - Event data
   */
  _handleEvent(eventType, data) {
    switch (eventType) {
      case 'TICK':
        this.emit('tick', {
          symbol: data.symbol,
          bid: data.bid,
          ask: data.ask,
          time: data.time
        });
        break;
        
      case 'ACCOUNT_UPDATE':
        this.accountInfo = data;
        this.emit('account', data);
        break;
        
      case 'POSITION_UPDATE':
        // Update position in cache
        this.positions.set(data.ticket, data);
        this.emit('position', data);
        break;
        
      case 'ORDER_UPDATE':
        // Update order in cache
        this.orders.set(data.ticket, data);
        this.emit('order', data);
        break;
        
      case 'POSITION_CLOSE':
        // Remove from cache
        this.positions.delete(data.ticket);
        this.emit('position:close', data);
        break;
        
      case 'ORDER_CLOSE':
        // Remove from cache
        this.orders.delete(data.ticket);
        this.emit('order:close', data);
        break;
        
      case 'ERROR':
        this.emit('error', { message: data.message });
        break;
        
      default:
        console.log(`Unhandled MT4 event: ${eventType}`, data);
    }
  }
}

module.exports = MT4BrokerAdapter;