// electron/brokers/fxify-mt5.js
const MT5BrokerAdapter = require('./mt5');
const { EventEmitter } = require('events');
const { FXIFYModeManager } = require('../fxify/fxify-mode-manager');
const { PreExecutionValidator } = require('../fxify/pre-execution-validator');

/**
 * MT5FXIFYAdapter extends the MT5BrokerAdapter to support FXIFY mode
 * Implements special rules and constraints for FXIFY trading
 */
class MT5FXIFYAdapter extends MT5BrokerAdapter {
  /**
   * Create a new MT5FXIFYAdapter instance
   * @param {Object} config - Optional configuration
   */
  constructor(config = {}) {
    super(config);
    this.fxifyModeManager = new FXIFYModeManager();
    this.preExecutionValidator = new PreExecutionValidator(this.fxifyModeManager);
    this.eventEmitter = new EventEmitter();
    this.isInitialized = false;
  }
  
  /**
   * Initialize the FXIFY adapter
   * @returns {Promise<void>}
   */
  async initialize() {
    if (!this.isInitialized) {
      await this.fxifyModeManager.initialize();
      this.isInitialized = true;
    }
  }
  
  /**
   * Connect to MT5 terminal via bridge with FXIFY support
   * @param {Object} config - Connection configuration
   * @returns {Promise<Object>} - Connection result
   */
  async connect(config) {
    // Initialize FXIFY components if not already done
    await this.initialize();
    
    // Connect using parent method
    const connectionResult = await super.connect(config);
    
    if (connectionResult.success && this.isFXIFYModeActive()) {
      // If connection successful and FXIFY mode is active, get account info
      // to initialize drawdown monitoring
      try {
        const accountInfo = await super.getAccountInfo();
        await this.fxifyModeManager.initializeDrawdownMonitor(accountInfo.balance);
      } catch (error) {
        console.error('Failed to initialize FXIFY drawdown monitoring:', error);
      }
    }
    
    return connectionResult;
  }
  
  /**
   * Execute an order with FXIFY rule validation
   * @param {Object} orderParams - Order parameters
   * @returns {Promise<Object>} - Order result
   */
  async placeMarketOrder(orderParams) {
    if (!this.isFXIFYModeActive()) {
      // If FXIFY mode is not active, use standard execution
      return super.placeMarketOrder(orderParams);
    }
    
    try {
      // Validate order against FXIFY rules
      const validationResult = await this.validateAgainstFXIFYRules(orderParams);
      
      if (!validationResult.valid) {
        // Handle rule violations
        this.handleRuleViolation(validationResult.rules);
        return {
          success: false,
          message: `FXIFY rule violation: ${validationResult.rules[0].message}`,
          violations: validationResult.rules
        };
      }
      
      // Apply any constraints or adjustments required by FXIFY
      const adjustedOrder = this.applyFXIFYConstraints(orderParams);
      
      // Execute the order using parent method
      const orderResult = await super.placeMarketOrder(adjustedOrder);
      
      // If order was successful, update drawdown monitor with new balance
      if (orderResult.success) {
        try {
          const accountInfo = await super.getAccountInfo();
          await this.fxifyModeManager.updateBalance(accountInfo.balance, accountInfo.equity);
        } catch (error) {
          console.error('Failed to update FXIFY drawdown monitoring:', error);
        }
      }
      
      return orderResult;
    } catch (error) {
      console.error('Error in FXIFY order execution:', error);
      throw error;
    }
  }
  
  /**
   * Execute a pending order with FXIFY rule validation
   * @param {Object} orderParams - Order parameters
   * @returns {Promise<Object>} - Order result
   */
  async placePendingOrder(orderParams) {
    if (!this.isFXIFYModeActive()) {
      // If FXIFY mode is not active, use standard execution
      return super.placePendingOrder(orderParams);
    }
    
    try {
      // Validate order against FXIFY rules
      const validationResult = await this.validateAgainstFXIFYRules(orderParams);
      
      if (!validationResult.valid) {
        // Handle rule violations
        this.handleRuleViolation(validationResult.rules);
        return {
          success: false,
          message: `FXIFY rule violation: ${validationResult.rules[0].message}`,
          violations: validationResult.rules
        };
      }
      
      // Apply any constraints or adjustments required by FXIFY
      const adjustedOrder = this.applyFXIFYConstraints(orderParams);
      
      // Execute the order using parent method
      return await super.placePendingOrder(adjustedOrder);
    } catch (error) {
      console.error('Error in FXIFY pending order execution:', error);
      throw error;
    }
  }
  
  /**
   * Modify an order with FXIFY rule validation
   * @param {Object} orderParams - Order parameters
   * @returns {Promise<Object>} - Modification result
   */
  async modifyOrder(orderParams) {
    if (!this.isFXIFYModeActive()) {
      // If FXIFY mode is not active, use standard execution
      return super.modifyOrder(orderParams);
    }
    
    try {
      // Validate modification against FXIFY rules
      const validationResult = await this.preExecutionValidator.validatePositionModification(
        orderParams.orderId,
        orderParams
      );
      
      if (!validationResult.valid) {
        // Handle rule violations
        this.handleRuleViolation(validationResult.rules);
        return {
          success: false,
          message: `FXIFY rule violation: ${validationResult.rules[0].message}`,
          violations: validationResult.rules
        };
      }
      
      // Apply any constraints required by FXIFY
      const adjustedParams = this.applyFXIFYConstraints(orderParams);
      
      // Execute the modification using parent method
      return await super.modifyOrder(adjustedParams);
    } catch (error) {
      console.error('Error in FXIFY order modification:', error);
      throw error;
    }
  }
  
  /**
   * Close a position with FXIFY validation
   * @param {number} positionId - Position ID to close
   * @param {number} volume - Volume to close
   * @returns {Promise<Object>} - Close result
   */
  async closePosition(positionId, volume = null) {
    // Allow position closing even in FXIFY mode - this is always permitted
    // to prevent further losses if needed
    const closeResult = await super.closePosition(positionId, volume);
    
    // If in FXIFY mode, update the drawdown monitor
    if (this.isFXIFYModeActive() && closeResult.success) {
      try {
        const accountInfo = await super.getAccountInfo();
        await this.fxifyModeManager.updateBalance(accountInfo.balance, accountInfo.equity);
      } catch (error) {
        console.error('Failed to update FXIFY drawdown monitoring after close:', error);
      }
    }
    
    return closeResult;
  }
  
  /**
   * Close all positions (for emergency drawdown protection)
   * @param {string} reason - Reason for closing positions
   * @returns {Promise<Object>} - Close result
   */
  async closeAllPositions(reason = "FXIFY rule enforcement") {
    try {
      const positions = await super.getPositions();
      
      const results = await Promise.all(
        positions.map(async (position) => {
          try {
            const result = await super.closePosition(position.id);
            return { positionId: position.id, success: result.success };
          } catch (error) {
            return { positionId: position.id, success: false, error: error.message };
          }
        })
      );
      
      const successful = results.filter(r => r.success).length;
      
      // Update balance after closing positions
      if (successful > 0 && this.isFXIFYModeActive()) {
        try {
          const accountInfo = await super.getAccountInfo();
          await this.fxifyModeManager.updateBalance(accountInfo.balance, accountInfo.equity);
        } catch (error) {
          console.error('Failed to update FXIFY drawdown monitoring after emergency close:', error);
        }
      }
      
      return {
        success: successful === positions.length,
        closed: successful,
        total: positions.length,
        reason,
        details: results
      };
    } catch (error) {
      console.error('Error closing all positions:', error);
      return {
        success: false,
        reason: `Error closing positions: ${error.message}`,
        error: error.message
      };
    }
  }
  
  /**
   * Validate order against FXIFY rules
   * @protected
   * @param {Object} order - Order parameters
   * @returns {Promise<Object>} - Validation result
   */
  async validateAgainstFXIFYRules(order) {
    try {
      if (!this.isFXIFYModeActive()) {
        return { valid: true, rules: [] };
      }
      
      return await this.preExecutionValidator.validateOrder(order);
    } catch (error) {
      console.error('Error validating order against FXIFY rules:', error);
      return {
        valid: false,
        rules: [{ 
          rule: 'system_error',
          severity: 'error',
          message: `Validation error: ${error.message}`
        }]
      };
    }
  }
  
  /**
   * Apply FXIFY constraints to order
   * @protected
   * @param {Object} order - Order parameters
   * @returns {Object} - Adjusted order parameters
   */
  applyFXIFYConstraints(order) {
    // If FXIFY mode is not active, return original order
    if (!this.isFXIFYModeActive()) {
      return order;
    }
    
    // Create a copy of the order to avoid modifying the original
    const adjustedOrder = { ...order };
    
    // Get active profile from FXIFY mode manager
    const activeProfile = this.fxifyModeManager.getActiveProfile();
    if (!activeProfile) {
      return adjustedOrder;
    }
    
    // Apply trade size limit if specified in profile
    if (activeProfile.tradeSizeLimit && adjustedOrder.volume > activeProfile.tradeSizeLimit) {
      adjustedOrder.volume = activeProfile.tradeSizeLimit;
      console.log(`FXIFY constraint applied: Trade size limited to ${activeProfile.tradeSizeLimit}`);
    }
    
    // Always add FXIFY identifier to order comment
    adjustedOrder.comment = `FXIFY: ${adjustedOrder.comment || 'SAITRAPP'}`;
    
    return adjustedOrder;
  }
  
  /**
   * Handle rule violations by emitting events and logging
   * @protected
   * @param {Array<Object>} violations - Rule violations
   */
  handleRuleViolation(violations) {
    // Log all violations
    violations.forEach(violation => {
      console.warn(`FXIFY rule violation: ${violation.rule} - ${violation.message}`);
    });
    
    // Emit event with violations
    this.eventEmitter.emit('fxify:rule_violation', violations);
  }
  
  /**
   * Check if FXIFY mode is currently active
   * @protected
   * @returns {boolean} - True if FXIFY mode is active
   */
  isFXIFYModeActive() {
    return this.fxifyModeManager.isFXIFYModeActive();
  }
  
  /**
   * Get the FXIFY mode manager instance
   * @returns {FXIFYModeManager} - FXIFY mode manager
   */
  getFXIFYModeManager() {
    return this.fxifyModeManager;
  }
  
  /**
   * Subscribe to FXIFY events
   * @param {string} event - Event name
   * @param {Function} callback - Event callback
   */
  onFXIFY(event, callback) {
    this.eventEmitter.on(`fxify:${event}`, callback);
  }
  
  /**
   * Unsubscribe from FXIFY events
   * @param {string} event - Event name
   * @param {Function} callback - Event callback
   */
  offFXIFY(event, callback) {
    this.eventEmitter.off(`fxify:${event}`, callback);
  }
}

module.exports = MT5FXIFYAdapter;