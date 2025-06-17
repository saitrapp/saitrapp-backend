// electron/fxify/pre-execution-validator.js
/**
 * PreExecutionValidator
 * Validates trade requests against FXIFY rules before execution
 */
class PreExecutionValidator {
  /**
   * Create a new PreExecutionValidator instance
   * @param {FXIFYModeManager} fxifyModeManager - FXIFY Mode Manager instance
   */
  constructor(fxifyModeManager) {
    this.fxifyModeManager = fxifyModeManager;
  }
  
  /**
   * Validate an order against FXIFY rules
   * @param {Object} order - Order to validate
   * @returns {Promise<Object>} - Validation result
   */
  async validateOrder(order) {
    // If FXIFY mode is not active, allow all orders
    if (!this.fxifyModeManager.isFXIFYModeActive()) {
      return { valid: true, rules: [] };
    }
    
    try {
      // Get active profile
      const profile = this.fxifyModeManager.getActiveProfile();
      if (!profile) {
        return { valid: true, rules: [] };
      }
      
      // Calculate potential loss
      let potentialLoss = 0;
      
      if (order.volume && order.stopLoss) {
        // Calculate potential loss in account currency based on stop loss
        const pipValue = order.pipValue || 10; // Default pip value if not provided
        const stopLossPips = Math.abs(order.price - order.stopLoss) / (order.pipSize || 0.0001);
        potentialLoss = order.volume * stopLossPips * pipValue;
      } else {
        // If no stop loss is specified, use a percentage of account balance as estimated loss
        const accountSize = await this._getAccountSize();
        potentialLoss = accountSize * 0.01; // Assume 1% risk if no stop loss
      }
      
      // Add potential loss to order for rules engine evaluation
      const orderWithRisk = {
        ...order,
        potentialLoss
      };
      
      // Check drawdown limits
      const drawdownCheck = await this.checkDrawdownLimits(potentialLoss);
      if (!drawdownCheck.valid) {
        return drawdownCheck;
      }
      
      // Check trading hours
      const tradingHoursCheck = await this.checkTradingHours(order.symbol);
      if (!tradingHoursCheck.valid) {
        return tradingHoursCheck;
      }
      
      // Check news events
      const newsEventsCheck = await this.checkNewsEvents(order.symbol);
      if (!newsEventsCheck.safeToTrade) {
        return {
          valid: false,
          rules: [{
            rule: 'news_trading',
            severity: 'error',
            message: `Trading during high-impact news events is not allowed for ${order.symbol}`,
            details: { 
              symbol: order.symbol,
              events: newsEventsCheck.activeEvents
            }
          }]
        };
      }
      
      // Forward to FXIFY rules engine for comprehensive check
      return await this.fxifyModeManager.validateTradeAgainstRules(orderWithRisk);
      
    } catch (error) {
      console.error('Error validating order:', error);
      return {
        valid: false,
        rules: [{
          rule: 'validation_error',
          severity: 'error',
          message: `Order validation error: ${error.message}`
        }]
      };
    }
  }
  
  /**
   * Validate position modification against FXIFY rules
   * @param {string} positionId - Position ID to modify
   * @param {Object} modifications - Modifications to apply
   * @returns {Promise<Object>} - Validation result
   */
  async validatePositionModification(positionId, modifications) {
    // If FXIFY mode is not active, allow all modifications
    if (!this.fxifyModeManager.isFXIFYModeActive()) {
      return { valid: true, rules: [] };
    }
    
    try {
      // Get active profile
      const profile = this.fxifyModeManager.getActiveProfile();
      if (!profile) {
        return { valid: true, rules: [] };
      }
      
      // For stop loss modifications, always allow as they reduce risk
      if (modifications.stopLoss && (modifications.type === 'MODIFY_SL' || modifications.stopLossOnly)) {
        return { valid: true, rules: [] };
      }
      
      // For take profit modifications, always allow as they lock in profit
      if (modifications.takeProfit && (modifications.type === 'MODIFY_TP' || modifications.takeProfitOnly)) {
        return { valid: true, rules: [] };
      }
      
      // For volume increases, validate as a new trade
      if (modifications.volume && modifications.increasingVolume) {
        // Create a simulated order for the volume increase
        const simulatedOrder = {
          symbol: modifications.symbol,
          volume: modifications.volumeIncrease || 0.01,
          direction: modifications.direction,
          stopLoss: modifications.stopLoss,
          takeProfit: modifications.takeProfit
        };
        
        // Validate as a new order
        return await this.validateOrder(simulatedOrder);
      }
      
      // For other modifications, allow by default but perform basic checks
      return { valid: true, rules: [] };
      
    } catch (error) {
      console.error('Error validating position modification:', error);
      return {
        valid: false,
        rules: [{
          rule: 'validation_error',
          severity: 'error',
          message: `Position modification validation error: ${error.message}`
        }]
      };
    }
  }
  
  /**
   * Check if potential loss would exceed drawdown limits
   * @param {number} potentialLoss - Potential loss amount
   * @returns {Promise<Object>} - Validation result
   */
  async checkDrawdownLimits(potentialLoss) {
    // If FXIFY mode is not active, allow all trades
    if (!this.fxifyModeManager.isFXIFYModeActive()) {
      return { valid: true };
    }
    
    try {
      const profile = this.fxifyModeManager.getActiveProfile();
      if (!profile) {
        return { valid: true };
      }
      
      // Get current drawdown status
      const rulesEngine = this.fxifyModeManager.rulesEngine;
      const drawdownStatus = rulesEngine.getDrawdownStatus();
      
      // Get account size
      const accountSize = await this._getAccountSize();
      
      // Calculate potential drawdown if this trade hits stop loss
      const potentialDailyDrawdownPercentage = drawdownStatus.dailyDrawdown + (potentialLoss / accountSize);
      const potentialTotalDrawdownPercentage = drawdownStatus.totalDrawdown + (potentialLoss / accountSize);
      
      // Check against limits
      if (potentialDailyDrawdownPercentage > profile.maxDailyDrawdown) {
        return {
          valid: false,
          rules: [{
            rule: 'drawdown_limit',
            severity: 'error',
            message: `This trade could exceed daily drawdown limit of ${(profile.maxDailyDrawdown * 100).toFixed(2)}% (potential: ${(potentialDailyDrawdownPercentage * 100).toFixed(2)}%)`,
            details: {
              type: 'daily_potential',
              current: drawdownStatus.dailyDrawdown,
              potential: potentialDailyDrawdownPercentage,
              limit: profile.maxDailyDrawdown
            }
          }]
        };
      }
      
      if (potentialTotalDrawdownPercentage > profile.maxTotalDrawdown) {
        return {
          valid: false,
          rules: [{
            rule: 'drawdown_limit',
            severity: 'error',
            message: `This trade could exceed total drawdown limit of ${(profile.maxTotalDrawdown * 100).toFixed(2)}% (potential: ${(potentialTotalDrawdownPercentage * 100).toFixed(2)}%)`,
            details: {
              type: 'total_potential',
              current: drawdownStatus.totalDrawdown,
              potential: potentialTotalDrawdownPercentage,
              limit: profile.maxTotalDrawdown
            }
          }]
        };
      }
      
      // Check if already at warning level
      if (drawdownStatus.warningLevel === 'critical') {
        return {
          valid: true,
          rules: [{
            rule: 'drawdown_warning',
            severity: 'warning',
            message: `You are approaching drawdown limits (daily: ${(drawdownStatus.dailyDrawdown * 100).toFixed(2)}%, total: ${(drawdownStatus.totalDrawdown * 100).toFixed(2)}%)`,
            details: { warningLevel: 'critical' }
          }]
        };
      }
      
      return { valid: true };
      
    } catch (error) {
      console.error('Error checking drawdown limits:', error);
      return { valid: true }; // Default to allowing trade on error
    }
  }
  
  /**
   * Check if current time is within valid trading hours
   * @param {string} symbol - Symbol to check
   * @returns {Promise<Object>} - Validation result
   */
  async checkTradingHours(symbol) {
    // If FXIFY mode is not active, allow trading at any time
    if (!this.fxifyModeManager.isFXIFYModeActive()) {
      return { valid: true };
    }
    
    try {
      const profile = this.fxifyModeManager.getActiveProfile();
      if (!profile) {
        return { valid: true };
      }
      
      // Get current UTC time
      const now = new Date();
      const dayOfWeek = now.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
      const hours = now.getUTCHours();
      const minutes = now.getUTCMinutes();
      
      // Check if it's weekend (Sunday or Saturday)
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        return {
          valid: false,
          rules: [{
            rule: 'trading_hours',
            severity: 'error',
            message: 'Trading is not allowed during weekends',
            details: { dayOfWeek, hours, minutes }
          }]
        };
      }
      
      // For forex pairs, check if during market hours
      // Most forex markets are open 24/5, but we'll implement specific checks if needed
      if (symbol && this._isForexPair(symbol)) {
        // Allow forex trading 24/5
        return { valid: true };
      }
      
      // For stocks or other instruments, additional checks could be added here
      
      return { valid: true };
      
    } catch (error) {
      console.error('Error checking trading hours:', error);
      return { valid: true }; // Default to allowing trade on error
    }
  }
  
  /**
   * Check for high-impact news events for the symbol
   * @param {string} symbol - Symbol to check
   * @returns {Promise<Object>} - News event status
   */
  async checkNewsEvents(symbol) {
    // If FXIFY mode is not active or trading calendar not available, allow trading
    if (!this.fxifyModeManager.isFXIFYModeActive() || !this.fxifyModeManager.rulesEngine.tradingCalendar) {
      return { safeToTrade: true, upcomingEvents: [], activeEvents: [], recommendedAction: 'proceed' };
    }
    
    try {
      const profile = this.fxifyModeManager.getActiveProfile();
      
      // If profile allows news trading or symbol is not provided, skip check
      if (!profile || profile.allowNewsTrading || !symbol) {
        return { safeToTrade: true, upcomingEvents: [], activeEvents: [], recommendedAction: 'proceed' };
      }
      
      // If we have a trading calendar, check for high-impact events
      if (this.fxifyModeManager.rulesEngine.tradingCalendar) {
        const calendar = this.fxifyModeManager.rulesEngine.tradingCalendar;
        
        // Extract currency codes from the symbol
        const currencyCodes = this._extractCurrenciesFromSymbol(symbol);
        
        // Check for active high-impact events for these currencies
        const activeEvents = [];
        const upcomingEvents = [];
        
        // This is a placeholder since we don't have the full trading calendar implementation
        // In a complete implementation, we would query the calendar for events
        
        // For now, return safe to trade
        return {
          safeToTrade: true,
          upcomingEvents: [],
          activeEvents: [],
          recommendedAction: 'proceed'
        };
      }
      
      return { safeToTrade: true, upcomingEvents: [], activeEvents: [], recommendedAction: 'proceed' };
      
    } catch (error) {
      console.error('Error checking news events:', error);
      return { safeToTrade: true, upcomingEvents: [], activeEvents: [], recommendedAction: 'proceed' }; // Default to allowing trade on error
    }
  }
  
  /**
   * Get current account size (balance) for risk calculations
   * @private
   * @returns {Promise<number>} - Account balance
   */
  async _getAccountSize() {
    try {
      // In a real implementation, this would get the current account balance
      // from the broker adapter or rules engine
      
      const balance = this.fxifyModeManager.rulesEngine.currentBalance || 10000; // Default to 10000 if not available
      return balance;
    } catch (error) {
      console.error('Error getting account size:', error);
      return 10000; // Default fallback value
    }
  }
  
  /**
   * Check if symbol is a forex pair
   * @private
   * @param {string} symbol - Symbol to check
   * @returns {boolean} - True if symbol is a forex pair
   */
  _isForexPair(symbol) {
    // Common forex pairs follow the pattern of 6 letters (two 3-letter currency codes)
    // Sometimes separated by a slash or underscore
    const cleanSymbol = symbol.replace('/', '').replace('_', '').replace('-', '');
    const forexRegex = /^[A-Z]{6}$/;
    return forexRegex.test(cleanSymbol);
  }
  
  /**
   * Extract currency codes from a symbol
   * @private
   * @param {string} symbol - Symbol to extract from (e.g., "EURUSD", "EUR/USD")
   * @returns {Array<string>} - Array of currency codes
   */
  _extractCurrenciesFromSymbol(symbol) {
    const cleanSymbol = symbol.replace('/', '').replace('_', '').replace('-', '').toUpperCase();
    
    // For standard 6-character forex pairs
    if (cleanSymbol.length === 6) {
      return [cleanSymbol.substring(0, 3), cleanSymbol.substring(3, 6)];
    }
    
    // For other symbols, try to extract common currency codes
    const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];
    return currencies.filter(currency => cleanSymbol.includes(currency));
  }
}

module.exports = {
  PreExecutionValidator
};