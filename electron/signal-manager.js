// electron/signal-manager.js
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

/**
 * SignalManager handles trading signal processing, storage, and execution
 * Acts as central hub for signals from multiple strategies/sources
 */
class SignalManager extends EventEmitter {
  /**
   * Create a new SignalManager instance
   * @param {DatabaseManager} dbManager - Database manager instance
   * @param {BrokerManager} brokerManager - Broker manager instance for executing trades
   */
  constructor(dbManager, brokerManager) {
    super();
    this.dbManager = dbManager;
    this.brokerManager = brokerManager;
    
    // Cache recent signals
    this.activeSignals = new Map(); // Keyed by signal ID
    
    // Signal state transitions
    this.validTransitions = {
      'pending': ['active', 'rejected', 'expired'],
      'active': ['filled', 'cancelled', 'expired'],
      'rejected': [],
      'filled': ['closed'],
      'cancelled': [],
      'expired': [],
      'closed': []
    };
    
    // Reliability thresholds
    this.reliabilityThresholds = {
      low: 30,
      medium: 60,
      high: 80
    };
  }
  
  /**
   * Initialize the signal manager
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      // Load active signals from database
      const activeSignals = await this.dbManager.executeSelect(
        "SELECT * FROM trading_signals WHERE status IN ('pending', 'active')"
      );
      
      // Add to cache
      activeSignals.forEach(signal => {
        this.activeSignals.set(signal.id, signal);
      });
      
      console.log(`Loaded ${activeSignals.length} active signals from database`);
      
      return true;
    } catch (error) {
      console.error('Failed to initialize signal manager:', error);
      return false;
    }
  }
  
  /**
   * Add a new trading signal
   * @param {Object} signalData - Trading signal data
   * @returns {Promise<Object>} Created signal
   */
  async addSignal(signalData) {
    try {
      // Generate ID if not provided
      const signalId = signalData.id || `sig_${uuidv4()}`;
      
      // Structure the signal with required fields
      const signal = {
        id: signalId,
        symbol: signalData.symbol,
        direction: signalData.direction?.toUpperCase() || 'BUY',
        price: signalData.price || null,
        stopLoss: signalData.stopLoss || null,
        takeProfit: signalData.takeProfit || null,
        timestamp: signalData.timestamp || new Date().toISOString(),
        status: signalData.status || 'pending',
        strategy: signalData.strategy || 'manual',
        reasoning: signalData.reasoning || '',
        reliability: signalData.reliability || 50 // default medium reliability
      };
      
      // Validate signal
      this._validateSignal(signal);
      
      // Save to database
      await this.dbManager.saveSignal(signal);
      
      // Add to active signals if relevant
      if (['pending', 'active'].includes(signal.status)) {
        this.activeSignals.set(signalId, signal);
      }
      
      // Emit event
      this.emit('signal-added', signal);
      
      // Log the event
      await this.dbManager.logEvent('info', `New trading signal added: ${signal.symbol} ${signal.direction}`, {
        signalId,
        strategy: signal.strategy
      });
      
      return signal;
    } catch (error) {
      console.error('Failed to add trading signal:', error);
      throw error;
    }
  }
  
  /**
   * Validate a signal before adding to the system
   * @private
   * @param {Object} signal - Signal to validate
   * @throws {Error} If signal is invalid
   */
  _validateSignal(signal) {
    // Check required fields
    if (!signal.symbol) throw new Error('Signal must have a symbol');
    if (!signal.direction) throw new Error('Signal must have a direction');
    
    // Validate direction
    if (!['BUY', 'SELL'].includes(signal.direction)) {
      throw new Error('Signal direction must be BUY or SELL');
    }
    
    // Validate price logic if provided
    if (signal.stopLoss && signal.price) {
      if (signal.direction === 'BUY' && signal.stopLoss >= signal.price) {
        throw new Error('For BUY signals, stop loss must be below entry price');
      } else if (signal.direction === 'SELL' && signal.stopLoss <= signal.price) {
        throw new Error('For SELL signals, stop loss must be above entry price');
      }
    }
    
    // Validate take profit logic if provided
    if (signal.takeProfit && signal.price) {
      if (signal.direction === 'BUY' && signal.takeProfit <= signal.price) {
        throw new Error('For BUY signals, take profit must be above entry price');
      } else if (signal.direction === 'SELL' && signal.takeProfit >= signal.price) {
        throw new Error('For SELL signals, take profit must be below entry price');
      }
    }
    
    // Validate reliability range
    if (signal.reliability < 0 || signal.reliability > 100) {
      throw new Error('Reliability must be between 0 and 100');
    }
  }
  
  /**
   * Update a signal's status
   * @param {string} signalId - Signal ID
   * @param {string} newStatus - New status value
   * @param {Object} [additionalData] - Additional data to update
   * @returns {Promise<Object>} Updated signal
   */
  async updateSignalStatus(signalId, newStatus, additionalData = {}) {
    try {
      // Get current signal data
      const signals = await this.dbManager.executeSelect(
        'SELECT * FROM trading_signals WHERE id = ?',
        [signalId]
      );
      
      if (signals.length === 0) {
        throw new Error(`Signal not found: ${signalId}`);
      }
      
      const signal = signals[0];
      const currentStatus = signal.status;
      
      // Validate status transition
      if (!this.validTransitions[currentStatus].includes(newStatus)) {
        throw new Error(`Invalid status transition: ${currentStatus} -> ${newStatus}`);
      }
      
      // Update fields
      const updateFields = ['status = ?'];
      const updateValues = [newStatus];
      
      // Add additional fields if provided
      Object.entries(additionalData).forEach(([key, value]) => {
        // Convert camelCase to snake_case for database
        const dbField = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        updateFields.push(`${dbField} = ?`);
        updateValues.push(value);
      });
      
      // Add signal ID for WHERE clause
      updateValues.push(signalId);
      
      // Execute update
      await this.dbManager.executeQuery(
        `UPDATE trading_signals SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
      
      // Update cache or remove if terminal state
      if (['pending', 'active'].includes(newStatus)) {
        // Get updated signal
        const updatedSignals = await this.dbManager.executeSelect(
          'SELECT * FROM trading_signals WHERE id = ?',
          [signalId]
        );
        
        this.activeSignals.set(signalId, updatedSignals[0]);
      } else {
        // Remove from active signals if in terminal state
        this.activeSignals.delete(signalId);
      }
      
      // Emit event
      this.emit('signal-updated', {
        signalId,
        previousStatus: currentStatus,
        newStatus,
        additionalData
      });
      
      // Log the event
      await this.dbManager.logEvent('info', `Signal ${signalId} status changed: ${currentStatus} -> ${newStatus}`);
      
      return { signalId, previousStatus: currentStatus, newStatus };
    } catch (error) {
      console.error(`Failed to update signal ${signalId}:`, error);
      throw error;
    }
  }
  
  /**
   * Process signals - execute or update based on conditions
   * @returns {Promise<Object>} Processing results
   */
  async processSignals() {
    try {
      const processed = {
        executed: 0,
        expired: 0,
        unchanged: 0
      };
      
      // Get active signals from cache
      const activeSignals = [...this.activeSignals.values()];
      
      // Process each signal
      for (const signal of activeSignals) {
        try {
          // Check if signal is expired
          const signalTime = new Date(signal.timestamp).getTime();
          const currentTime = Date.now();
          const signalAgeHours = (currentTime - signalTime) / (1000 * 60 * 60);
          
          // If signal is older than 24 hours and still pending, mark as expired
          if (signal.status === 'pending' && signalAgeHours > 24) {
            await this.updateSignalStatus(signal.id, 'expired');
            processed.expired++;
            continue;
          }
          
          // Handle pending signals that should be executed
          if (signal.status === 'pending' && signal.reliability >= this.reliabilityThresholds.medium) {
            const shouldExecute = await this._evaluateSignalExecution(signal);
            
            if (shouldExecute) {
              // In a real implementation, this would attempt to execute the trade
              // through the connected broker
              
              // For demo, just update status
              await this.updateSignalStatus(signal.id, 'active');
              processed.executed++;
              continue;
            }
          }
          
          processed.unchanged++;
        } catch (signalError) {
          console.error(`Error processing signal ${signal.id}:`, signalError);
          // Continue processing other signals
        }
      }
      
      return processed;
    } catch (error) {
      console.error('Failed to process signals:', error);
      throw error;
    }
  }
  
  /**
   * Evaluate if a signal should be executed based on market conditions
   * @private
   * @param {Object} signal - Signal to evaluate
   * @returns {Promise<boolean>} Whether signal should be executed
   */
  async _evaluateSignalExecution(signal) {
    // In a real implementation, this would check current market conditions,
    // account risk parameters, and other factors before deciding to execute
    
    // For demo purposes, return true for high reliability signals
    return signal.reliability >= this.reliabilityThresholds.high;
  }
  
  /**
   * Get recent signals
   * @param {Object} filters - Filter conditions
   * @returns {Promise<Array<Object>>} Matching signals
   */
  async getRecentSignals(filters = {}) {
    try {
      let query = 'SELECT * FROM trading_signals';
      const queryParams = [];
      
      // Build where clause based on filters
      const conditions = [];
      
      if (filters.symbol) {
        conditions.push('symbol = ?');
        queryParams.push(filters.symbol);
      }
      
      if (filters.status) {
        conditions.push('status = ?');
        queryParams.push(filters.status);
      }
      
      if (filters.strategy) {
        conditions.push('strategy = ?');
        queryParams.push(filters.strategy);
      }
      
      if (filters.dateFrom) {
        conditions.push('timestamp >= ?');
        queryParams.push(filters.dateFrom);
      }
      
      if (filters.dateTo) {
        conditions.push('timestamp <= ?');
        queryParams.push(filters.dateTo);
      }
      
      if (filters.minReliability) {
        conditions.push('reliability >= ?');
        queryParams.push(filters.minReliability);
      }
      
      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }
      
      // Order by timestamp, newest first
      query += ' ORDER BY timestamp DESC';
      
      // Add limit if specified
      if (filters.limit) {
        query += ' LIMIT ?';
        queryParams.push(filters.limit);
      }
      
      // Execute query
      const signals = await this.dbManager.executeSelect(query, queryParams);
      
      return signals;
    } catch (error) {
      console.error('Failed to get recent signals:', error);
      throw error;
    }
  }
  
  /**
   * Get signal details by ID
   * @param {string} signalId - Signal ID
   * @returns {Promise<Object>} Signal details
   */
  async getSignalDetails(signalId) {
    try {
      const signals = await this.dbManager.executeSelect(
        'SELECT * FROM trading_signals WHERE id = ?',
        [signalId]
      );
      
      if (signals.length === 0) {
        throw new Error(`Signal not found: ${signalId}`);
      }
      
      return signals[0];
    } catch (error) {
      console.error(`Failed to get signal ${signalId}:`, error);
      throw error;
    }
  }
  
  /**
   * Get signal performance stats by strategy
   * @returns {Promise<Object>} Performance statistics
   */
  async getSignalPerformanceStats() {
    try {
      // Get signal counts by strategy and status
      const results = await this.dbManager.executeSelect(`
        SELECT strategy, 
               COUNT(*) as total_signals,
               SUM(CASE WHEN status = 'filled' OR status = 'closed' THEN 1 ELSE 0 END) as executed,
               SUM(CASE WHEN status = 'rejected' OR status = 'expired' OR status = 'cancelled' THEN 1 ELSE 0 END) as rejected
        FROM trading_signals 
        GROUP BY strategy
      `);
      
      // Calculate performance metrics
      return results.map(row => {
        const executionRate = row.total_signals > 0 ? (row.executed / row.total_signals) * 100 : 0;
        
        return {
          strategy: row.strategy,
          totalSignals: row.total_signals,
          executed: row.executed,
          rejected: row.rejected,
          pending: row.total_signals - row.executed - row.rejected,
          executionRate: Math.round(executionRate * 100) / 100
        };
      });
    } catch (error) {
      console.error('Failed to get signal performance stats:', error);
      throw error;
    }
  }
  
  /**
   * Delete a signal
   * @param {string} signalId - Signal ID to delete
   * @returns {Promise<boolean>} Success status
   */
  async deleteSignal(signalId) {
    try {
      // Check if signal exists
      const signal = await this.getSignalDetails(signalId);
      
      // Remove from cache
      this.activeSignals.delete(signalId);
      
      // Remove from database
      await this.dbManager.executeQuery(
        'DELETE FROM trading_signals WHERE id = ?',
        [signalId]
      );
      
      // Log the event
      await this.dbManager.logEvent('info', `Signal deleted: ${signalId}`, {
        symbol: signal.symbol,
        strategy: signal.strategy
      });
      
      this.emit('signal-deleted', { signalId });
      
      return true;
    } catch (error) {
      console.error(`Failed to delete signal ${signalId}:`, error);
      throw error;
    }
  }
}

module.exports = SignalManager;