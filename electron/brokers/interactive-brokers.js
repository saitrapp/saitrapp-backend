// electron/brokers/interactive-brokers.js
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const net = require('net');

/**
 * Interactive Brokers adapter for SAITRAPP
 * Uses the Interactive Brokers TWS API or IB Gateway
 */
class InteractiveBrokersAdapter {
  /**
   * Create a new IB adapter instance
   */
  constructor() {
    this.socket = null;
    this.connected = false;
    this.clientId = Math.floor(Math.random() * 9000) + 1000; // Random client ID
    this.nextRequestId = 1;
    this.callbacks = new Map();
    this.eventEmitter = new EventEmitter();
    this.messageBuffer = '';
    
    // Internal tracking of account and position data
    this.accountInfo = {};
    this.positions = [];
    this.orders = [];
    this.marketData = {};
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.reconnectDelay = 5000;
  }
  
  /**
   * Connect to Interactive Brokers TWS or Gateway
   * @param {Object} config - Connection configuration
   * @param {string} config.host - Host address (default: localhost)
   * @param {number} config.port - Port number (default: 7496 for TWS, 4001 for Gateway)
   * @returns {Promise<Object>} - Connection result
   */
  async connect(config) {
    if (this.connected) {
      return { success: true, message: 'Already connected' };
    }
    
    try {
      const host = config.host || 'localhost';
      const port = config.port || 7496;
      
      return new Promise((resolve, reject) => {
        // Create socket connection
        this.socket = new net.Socket();
        
        // Set up connection timeout
        const connectionTimeout = setTimeout(() => {
          this.socket?.destroy();
          reject({ success: false, message: 'Connection timeout' });
        }, 15000);
        
        // Connection event handlers
        this.socket.on('connect', () => {
          clearTimeout(connectionTimeout);
          console.log(`Connected to IB at ${host}:${port}`);
          
          // Set up API client version
          this._sendRawMessage('API\0v100...176'); // IB API version compatibility
          
          // Start the client
          this._sendRequest('startApi', {
            clientId: this.clientId,
            optionalCapabilities: ''
          });
          
          // Set connected state and reset reconnect attempts
          this.connected = true;
          this.reconnectAttempts = 0;
          
          // Resolve the promise with success
          resolve({ 
            success: true, 
            message: 'Connected to Interactive Brokers', 
            clientId: this.clientId 
          });
        });
        
        // Handle incoming data
        this.socket.on('data', (data) => {
          // Append to message buffer
          this.messageBuffer += data.toString();
          
          // Process complete messages
          this._processMessagesFromBuffer();
        });
        
        // Handle errors
        this.socket.on('error', (error) => {
          console.error('IB connection error:', error);
          if (!this.connected) {
            clearTimeout(connectionTimeout);
            reject({ success: false, message: `Connection error: ${error.message}` });
          } else {
            this.eventEmitter.emit('error', error);
          }
        });
        
        // Handle connection close
        this.socket.on('close', () => {
          console.log('IB connection closed');
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
            if (this.reconnectAttempts < this.maxReconnectAttempts && !this.manualDisconnect) {
              this.reconnectAttempts++;
              console.log(`Attempting to reconnect to IB (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
              
              setTimeout(() => {
                this.connect(config).catch(err => {
                  console.error('IB reconnection failed:', err);
                });
              }, this.reconnectDelay * this.reconnectAttempts);
            }
          }
        });
        
        // Connect to IB
        this.socket.connect(port, host);
      });
    } catch (error) {
      console.error('IB connect error:', error);
      return { success: false, message: `IB connection error: ${error.message}` };
    }
  }
  
  /**
   * Disconnect from Interactive Brokers
   * @returns {Promise<Object>} - Disconnect result
   */
  async disconnect() {
    if (!this.connected || !this.socket) {
      return { success: true, message: 'Not connected' };
    }
    
    return new Promise((resolve) => {
      this.manualDisconnect = true; // Flag to prevent auto reconnect
      
      this.socket.once('close', () => {
        resolve({ success: true, message: 'Disconnected from Interactive Brokers' });
      });
      
      // Send a disconnect message if possible
      try {
        if (this.connected) {
          this._sendRequest('cancelPositions');
          this._sendRequest('cancelAccountUpdates');
        }
      } catch (e) {
        console.log('Error sending disconnect commands:', e);
      }
      
      // Close socket
      this.socket.end();
    });
  }
  
  /**
   * Get account information
   * @param {string} account - Account ID
   * @returns {Promise<Object>} - Account information
   */
  async getAccountInfo(account) {
    if (!this.connected) {
      throw new Error('Not connected to Interactive Brokers');
    }
    
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++;
      let timeout;
      let completed = false;
      
      // Create a temporary event handler to collect account data
      const onAccountUpdate = (data) => {
        if (data.account === account || !account) {
          if (!this.accountInfo[data.account]) {
            this.accountInfo[data.account] = {};
          }
          
          this.accountInfo[data.account][data.key] = data.value;
        }
      };
      
      const onAccountUpdateEnd = (data) => {
        if (data.account === account || !account) {
          // Clean up
          this.eventEmitter.off('accountUpdate', onAccountUpdate);
          this.eventEmitter.off('accountUpdateEnd', onAccountUpdateEnd);
          clearTimeout(timeout);
          completed = true;
          
          // Return the account info
          resolve(account ? this.accountInfo[account] : this.accountInfo);
        }
      };
      
      // Set up event handlers
      this.eventEmitter.on('accountUpdate', onAccountUpdate);
      this.eventEmitter.on('accountUpdateEnd', onAccountUpdateEnd);
      
      // Set up timeout
      timeout = setTimeout(() => {
        if (!completed) {
          this.eventEmitter.off('accountUpdate', onAccountUpdate);
          this.eventEmitter.off('accountUpdateEnd', onAccountUpdateEnd);
          reject(new Error('Account info request timed out'));
        }
      }, 15000);
      
      // Request account updates
      this._sendRequest('reqAccountUpdates', {
        subscribe: true,
        accountId: account || ''
      });
    });
  }
  
  /**
   * Get open positions
   * @returns {Promise<Array>} - List of open positions
   */
  async getPositions() {
    if (!this.connected) {
      throw new Error('Not connected to Interactive Brokers');
    }
    
    return new Promise((resolve, reject) => {
      const positionsData = [];
      let timeout;
      let completed = false;
      
      // Create a temporary event handler to collect position data
      const onPosition = (data) => {
        positionsData.push(data);
      };
      
      const onPositionEnd = () => {
        // Clean up
        this.eventEmitter.off('position', onPosition);
        this.eventEmitter.off('positionEnd', onPositionEnd);
        clearTimeout(timeout);
        completed = true;
        
        // Store and return positions
        this.positions = positionsData;
        resolve(positionsData);
      };
      
      // Set up event handlers
      this.eventEmitter.on('position', onPosition);
      this.eventEmitter.on('positionEnd', onPositionEnd);
      
      // Set up timeout
      timeout = setTimeout(() => {
        if (!completed) {
          this.eventEmitter.off('position', onPosition);
          this.eventEmitter.off('positionEnd', onPositionEnd);
          reject(new Error('Positions request timed out'));
        }
      }, 15000);
      
      // Request positions
      this._sendRequest('reqPositions');
    });
  }
  
  /**
   * Get market data
   * @param {Object} contract - Contract details
   * @param {string} dataType - Type of market data to request
   * @returns {Promise<Object>} - Market data
   */
  async getMarketData(contract, dataType = 'TRADES') {
    if (!this.connected) {
      throw new Error('Not connected to Interactive Brokers');
    }
    
    const requestId = this.nextRequestId++;
    
    return new Promise((resolve, reject) => {
      const dataItems = [];
      let timeout;
      
      // Handle market data updates
      const onMarketData = (data) => {
        if (data.requestId === requestId) {
          dataItems.push(data);
          
          // For snapshot requests, resolve after first data point
          if (dataType === 'SNAPSHOT') {
            cleanup();
            resolve(data);
          }
        }
      };
      
      // Handle errors
      const onError = (error) => {
        if (error.requestId === requestId) {
          cleanup();
          reject(new Error(`Market data error: ${error.message}`));
        }
      };
      
      // Clean up event handlers
      const cleanup = () => {
        clearTimeout(timeout);
        this.eventEmitter.off('marketData', onMarketData);
        this.eventEmitter.off('error', onError);
      };
      
      // Set up event handlers
      this.eventEmitter.on('marketData', onMarketData);
      this.eventEmitter.on('error', onError);
      
      // Set up timeout
      timeout = setTimeout(() => {
        if (dataType !== 'REALTIME') { // Only timeout for non-streaming requests
          cleanup();
          reject(new Error('Market data request timed out'));
        } else {
          // For streaming data, return what we have so far
          resolve(dataItems);
        }
      }, 10000);
      
      // Request market data
      this._sendRequest('reqMktData', {
        requestId,
        contract,
        genericTickList: '',
        snapshot: dataType === 'SNAPSHOT',
        regulatorySnapshot: false
      });
    });
  }
  
  /**
   * Place an order
   * @param {Object} contract - Contract to trade
   * @param {Object} order - Order details
   * @returns {Promise<Object>} - Order result
   */
  async placeOrder(contract, order) {
    if (!this.connected) {
      throw new Error('Not connected to Interactive Brokers');
    }
    
    const orderId = this.nextRequestId++;
    
    // Create order object with default values
    const ibOrder = {
      orderId,
      clientId: this.clientId,
      permId: 0,
      action: order.direction.toUpperCase(),
      totalQuantity: order.quantity,
      orderType: order.orderType || 'MKT',
      lmtPrice: order.limitPrice || 0,
      auxPrice: order.stopPrice || 0,
      tif: order.timeInForce || 'DAY',
      ocaGroup: '',
      account: order.account || '',
      openClose: 'O',
      origin: 0,
      orderRef: order.orderRef || '',
      transmit: true,
      parentId: order.parentId || 0,
      blockOrder: false,
      sweepToFill: false,
      displaySize: 0,
      triggerMethod: 0,
      outsideRth: false,
      hidden: false
    };
    
    return new Promise((resolve, reject) => {
      let timeout;
      let orderStatus = {};
      
      // Handle order status updates
      const onOrderStatus = (status) => {
        if (status.orderId === orderId) {
          orderStatus = { ...orderStatus, ...status };
          
          // If order is filled or rejected, resolve
          if (['Filled', 'Cancelled', 'ApiCancelled', 'Rejected'].includes(status.status)) {
            cleanup();
            resolve(orderStatus);
          }
        }
      };
      
      // Handle errors
      const onError = (error) => {
        if (error.id === orderId) {
          cleanup();
          reject(new Error(`Order error: ${error.message}`));
        }
      };
      
      // Handle open order details
      const onOpenOrder = (data) => {
        if (data.orderId === orderId) {
          orderStatus = { ...orderStatus, ...data };
        }
      };
      
      // Clean up event handlers
      const cleanup = () => {
        clearTimeout(timeout);
        this.eventEmitter.off('orderStatus', onOrderStatus);
        this.eventEmitter.off('openOrder', onOpenOrder);
        this.eventEmitter.off('error', onError);
      };
      
      // Set up event handlers
      this.eventEmitter.on('orderStatus', onOrderStatus);
      this.eventEmitter.on('openOrder', onOpenOrder);
      this.eventEmitter.on('error', onError);
      
      // Set up timeout for initial acknowledgment (not for full execution)
      timeout = setTimeout(() => {
        // Don't reject, just clean up listeners
        this.eventEmitter.off('orderStatus', onOrderStatus);
        this.eventEmitter.off('openOrder', onOpenOrder);
        this.eventEmitter.off('error', onError);
        
        // Return the current status
        resolve({
          orderId,
          status: orderStatus.status || 'Submitted',
          message: 'Order submitted, but status updates timed out',
          ...orderStatus
        });
      }, 15000);
      
      // Place order
      this._sendRequest('placeOrder', {
        id: orderId,
        contract,
        order: ibOrder
      });
      
      // Immediately return the order ID
      resolve({
        orderId,
        status: 'Submitted',
        message: 'Order submitted'
      });
    });
  }
  
  /**
   * Cancel an order
   * @param {number} orderId - Order ID to cancel
   * @returns {Promise<Object>} - Cancellation result
   */
  async cancelOrder(orderId) {
    if (!this.connected) {
      throw new Error('Not connected to Interactive Brokers');
    }
    
    return new Promise((resolve, reject) => {
      let timeout;
      
      // Handle order status updates
      const onOrderStatus = (status) => {
        if (status.orderId === orderId && 
            ['Cancelled', 'ApiCancelled'].includes(status.status)) {
          cleanup();
          resolve({
            orderId,
            status: status.status,
            message: 'Order cancelled'
          });
        }
      };
      
      // Handle errors
      const onError = (error) => {
        if (error.id === orderId) {
          cleanup();
          reject(new Error(`Cancel error: ${error.message}`));
        }
      };
      
      // Clean up event handlers
      const cleanup = () => {
        clearTimeout(timeout);
        this.eventEmitter.off('orderStatus', onOrderStatus);
        this.eventEmitter.off('error', onError);
      };
      
      // Set up event handlers
      this.eventEmitter.on('orderStatus', onOrderStatus);
      this.eventEmitter.on('error', onError);
      
      // Set up timeout
      timeout = setTimeout(() => {
        cleanup();
        resolve({
          orderId,
          status: 'CancelRequested',
          message: 'Cancel requested, but confirmation timed out'
        });
      }, 10000);
      
      // Cancel order
      this._sendRequest('cancelOrder', { id: orderId });
      
      // Return immediate acknowledgment
      resolve({
        orderId,
        status: 'CancelRequested',
        message: 'Cancel requested'
      });
    });
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
   * Send a raw message to the IB API
   * @private
   * @param {string} message - Raw message string
   */
  _sendRawMessage(message) {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to Interactive Brokers');
    }
    
    try {
      this.socket.write(message);
    } catch (error) {
      console.error('Error sending raw message to IB:', error);
      throw error;
    }
  }
  
  /**
   * Send a request to the IB API
   * @private
   * @param {string} method - Request method
   * @param {Object} params - Request parameters
   * @returns {Promise<Object>} - Response
   */
  _sendRequest(method, params = {}) {
    // This would need to be implemented based on the TWS API protocol
    // The actual implementation would map these high-level methods to the low-level TWS API messages
    // For now, this is a simplified version that illustrates the concept
    
    // Example implementation for reqAccountUpdates
    if (method === 'reqAccountUpdates') {
      const msg = `reqAccountUpdates\0${params.subscribe ? 1 : 0}\0${params.accountId}\0`;
      this._sendRawMessage(msg);
    }
    // Additional method implementations would go here
  }
  
  /**
   * Process messages from the buffer
   * @private
   */
  _processMessagesFromBuffer() {
    // Find complete messages (terminated by null character)
    const messages = this.messageBuffer.split('\0');
    
    // Last element is either empty or an incomplete message
    this.messageBuffer = messages.pop() || '';
    
    // Process complete messages
    for (const message of messages) {
      if (message) {
        this._processMessage(message);
      }
    }
  }
  
  /**
   * Process a single message
   * @private
   * @param {string} message - Message string
   */
  _processMessage(message) {
    try {
      // Parse the message based on TWS API protocol
      // This is a simplified example that assumes a specific message format
      const parts = message.split('\t');
      const messageType = parts[0];
      
      // Handle different message types
      switch (messageType) {
        case 'connectionAck':
          console.log('IB connection acknowledged');
          break;
          
        case 'managedAccounts':
          this.eventEmitter.emit('managedAccounts', { accounts: parts[1].split(',') });
          break;
          
        case 'updateAccountValue':
          this.eventEmitter.emit('accountUpdate', {
            key: parts[1],
            value: parts[2],
            currency: parts[3],
            account: parts[4]
          });
          break;
          
        case 'updateAccountTime':
          this.eventEmitter.emit('accountUpdateTime', { time: parts[1] });
          break;
          
        case 'accountDownloadEnd':
          this.eventEmitter.emit('accountUpdateEnd', { account: parts[1] });
          break;
          
        case 'position':
          this.eventEmitter.emit('position', {
            account: parts[1],
            contract: {
              symbol: parts[2],
              secType: parts[3],
              exchange: parts[4],
              currency: parts[5]
            },
            position: parseFloat(parts[6]),
            avgCost: parseFloat(parts[7])
          });
          break;
          
        case 'positionEnd':
          this.eventEmitter.emit('positionEnd');
          break;
          
        case 'tickPrice':
          this.eventEmitter.emit('marketData', {
            requestId: parseInt(parts[1]),
            tickType: parseInt(parts[2]),
            price: parseFloat(parts[3]),
            size: parts.length > 4 ? parseInt(parts[4]) : 0,
            autoExecute: parts.length > 5 ? parts[5] === '1' : false
          });
          break;
          
        case 'orderStatus':
          this.eventEmitter.emit('orderStatus', {
            orderId: parseInt(parts[1]),
            status: parts[2],
            filled: parseFloat(parts[3]),
            remaining: parseFloat(parts[4]),
            avgFillPrice: parseFloat(parts[5]),
            permId: parseInt(parts[6]),
            parentId: parseInt(parts[7]),
            lastFillPrice: parseFloat(parts[8]),
            clientId: parseInt(parts[9]),
            whyHeld: parts.length > 10 ? parts[10] : ''
          });
          break;
          
        case 'openOrder':
          // Complex message parsing for open order details
          // Would need to be implemented based on the TWS API protocol
          break;
          
        case 'error':
          const id = parseInt(parts[1]);
          const code = parseInt(parts[2]);
          const message = parts[3];
          
          console.error(`IB error (${id}): ${code} - ${message}`);
          this.eventEmitter.emit('error', { id, code, message });
          break;
          
        default:
          console.log(`Unknown message type: ${messageType}`);
          break;
      }
    } catch (error) {
      console.error('Error processing IB message:', error, message);
    }
  }
}

module.exports = InteractiveBrokersAdapter;
