// electron/fxify/fxify-rules-engine.js
const { EventEmitter } = require('events');
const { DrawdownMonitor } = require('./drawdown-monitor');
const path = require('path');
const fs = require('fs').promises;

/**
 * FXIFYRulesEngine
 * Enforces FXIFY-specific trading rules
 */
class FXIFYRulesEngine {
  /**
   * Create a new FXIFY Rules Engine instance
   */
  constructor() {
    this.drawdownMonitor = new DrawdownMonitor();
    this.tradingCalendar = null; // Will be initialized later
    this.ruleEvaluators = new Map();
    this.activeProfile = null;
    this.eventEmitter = new EventEmitter();
    this.tradingDaysHistory = [];
    this.initialBalance = 0;
    this.currentBalance = 0;
    this.currentEquity = 0;
    this.warnings = [];
    
    // Counters for trading activity
    this.dailyTradeCount = 0;
    this.weeklyTradeCount = 0;
    this.tradingDaysCompleted = 0;
    
    // Initialize rule evaluators
    this._initializeRuleEvaluators();
  }
  
  /**
   * Initialize the Rules Engine
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      // Initialize the trading calendar (will be implemented later)
      // this.tradingCalendar = new TradingCalendar();
      // await this.tradingCalendar.initialize();
      
      return true;
    } catch (error) {
      console.error('Failed to initialize FXIFY Rules Engine:', error);
      return false;
    }
  }
  
  /**
   * Initialize rule evaluators
   * @private
   */
  _initializeRuleEvaluators() {
    // Define rule evaluators for different rule types
    
    // Drawdown limit rule
    this.ruleEvaluators.set('drawdown_limit', {
      evaluate: (request, profile) => {
        const drawdownStatus = this.drawdownMonitor.getStatus();
        
        if (drawdownStatus.dailyLimitExceeded) {
          return {
            valid: false,
            rule: 'drawdown_limit',
            severity: 'error',
            message: `Daily drawdown limit of ${profile.maxDailyDrawdown * 100}% has been exceeded (current: ${(drawdownStatus.dailyDrawdown * 100).toFixed(2)}%)`,
            details: { type: 'daily', current: drawdownStatus.dailyDrawdown, limit: profile.maxDailyDrawdown }
          };
        }
        
        if (drawdownStatus.totalLimitExceeded) {
          return {
            valid: false,
            rule: 'drawdown_limit',
            severity: 'error',
            message: `Total drawdown limit of ${profile.maxTotalDrawdown * 100}% has been exceeded (current: ${(drawdownStatus.totalDrawdown * 100).toFixed(2)}%)`,
            details: { type: 'total', current: drawdownStatus.totalDrawdown, limit: profile.maxTotalDrawdown }
          };
        }
        
        // Check if the potential loss from this trade would exceed limits
        if (request.potentialLoss) {
          const potentialDailyDrawdown = drawdownStatus.dailyDrawdown + (request.potentialLoss / this.drawdownMonitor.startOfDayBalance);
          const potentialTotalDrawdown = drawdownStatus.totalDrawdown + (request.potentialLoss / this.drawdownMonitor.initialBalance);
          
          if (potentialDailyDrawdown > profile.maxDailyDrawdown) {
            return {
              valid: false,
              rule: 'drawdown_limit',
              severity: 'error',
              message: `This trade could exceed daily drawdown limit of ${profile.maxDailyDrawdown * 100}% (potential: ${(potentialDailyDrawdown * 100).toFixed(2)}%)`,
              details: { type: 'daily_potential', current: drawdownStatus.dailyDrawdown, potential: potentialDailyDrawdown, limit: profile.maxDailyDrawdown }
            };
          }
          
          if (potentialTotalDrawdown > profile.maxTotalDrawdown) {
            return {
              valid: false,
              rule: 'drawdown_limit',
              severity: 'error',
              message: `This trade could exceed total drawdown limit of ${profile.maxTotalDrawdown * 100}% (potential: ${(potentialTotalDrawdown * 100).toFixed(2)}%)`,
              details: { type: 'total_potential', current: drawdownStatus.totalDrawdown, potential: potentialTotalDrawdown, limit: profile.maxTotalDrawdown }
            };
          }
        }
        
        // Check for approaching drawdown limits (warning level)
        if (drawdownStatus.warningLevel === 'critical') {
          return {
            valid: true,
            rule: 'drawdown_limit',
            severity: 'warning',
            message: `Approaching drawdown limits: daily ${(drawdownStatus.dailyDrawdown * 100).toFixed(2)}% of ${profile.maxDailyDrawdown * 100}%, total ${(drawdownStatus.totalDrawdown * 100).toFixed(2)}% of ${profile.maxTotalDrawdown * 100}%`,
            details: { warningLevel: 'critical' }
          };
        }
        
        return { valid: true };
      }
    });
    
    // Trade size limit rule
    this.ruleEvaluators.set('trade_size_limit', {
      evaluate: (request, profile) => {
        if (!profile.tradeSizeLimit || !request.volume) {
          return { valid: true };
        }
        
        if (request.volume > profile.tradeSizeLimit) {
          return {
            valid: false,
            rule: 'trade_size_limit',
            severity: 'error',
            message: `Trade size exceeds limit of ${profile.tradeSizeLimit} lots (requested: ${request.volume})`,
            details: { requested: request.volume, limit: profile.tradeSizeLimit }
          };
        }
        
        return { valid: true };
      }
    });
    
    // News trading rule
    this.ruleEvaluators.set('news_trading', {
      evaluate: (request, profile) => {
        // If news trading is allowed, skip this rule
        if (profile.allowNewsTrading) {
          return { valid: true };
        }
        
        // If we have a trading calendar and symbol, check for news events
        if (this.tradingCalendar && request.symbol) {
          const isHighImpactActive = this.tradingCalendar ? this.tradingCalendar.isHighImpactEventActive(request.symbol) : false;
          
          if (isHighImpactActive) {
            return {
              valid: false,
              rule: 'news_trading',
              severity: 'error',
              message: `Trading during high-impact news events is not allowed for ${request.symbol}`,
              details: { symbol: request.symbol }
            };
          }
        }
        
        return { valid: true };
      }
    });
    
    // Trading days rule
    this.ruleEvaluators.set('trading_days', {
      evaluate: (request, profile) => {
        // This rule only applies when trying to finalize/complete a challenge
        // and won't prevent regular trading, so always return valid
        return { valid: true };
      }
    });
  }
  
  /**
   * Initialize the rules engine for a specific profile
   * @param {Object} profile - FXIFY profile to use
   * @returns {Promise<void>}
   */
  async initializeForProfile(profile) {
    this.activeProfile = profile;
    
    // Reset counters and status
    this.warnings = [];
    this.dailyTradeCount = 0;
    this.weeklyTradeCount = 0;
    
    // We'll initialize drawdown monitor later when we have the initial balance
  }
  
  /**
   * Initialize drawdown monitor with initial balance
   * @param {number} initialBalance - Initial account balance
   * @param {number} maxDailyDrawdown - Maximum daily drawdown percentage (0-1)
   * @param {number} maxTotalDrawdown - Maximum total drawdown percentage (0-1)
   * @returns {Promise<void>}
   */
  async initializeDrawdownMonitor(initialBalance, maxDailyDrawdown = null, maxTotalDrawdown = null) {
    if (!this.activeProfile) {
      throw new Error('No active FXIFY profile set');
    }
    
    // Use profile values if not explicitly provided
    const dailyLimit = maxDailyDrawdown !== null ? maxDailyDrawdown : this.activeProfile.maxDailyDrawdown;
    const totalLimit = maxTotalDrawdown !== null ? maxTotalDrawdown : this.activeProfile.maxTotalDrawdown;
    
    this.initialBalance = initialBalance;
    this.currentBalance = initialBalance;
    this.currentEquity = initialBalance;
    
    // Initialize the drawdown monitor
    this.drawdownMonitor.initialize(initialBalance, dailyLimit, totalLimit);
  }
  
  /**
   * Reset rules engine
   * @returns {Promise<void>}
   */
  async resetRules() {
    this.activeProfile = null;
    this.warnings = [];
    this.dailyTradeCount = 0;
    this.weeklyTradeCount = 0;
    this.drawdownMonitor.resetMonitor();
  }
  
  /**
   * Update account balance for monitoring
   * @param {number} balance - Current account balance
   * @param {number} equity - Current account equity (including floating P/L)
   * @returns {Promise<void>}
   */
  async updateBalance(balance, equity) {
    this.currentBalance = balance;
    this.currentEquity = equity;
    
    // Update drawdown monitor
    this.drawdownMonitor.updateBalance(balance, equity);
    
    // Check for drawdown violations
    this._checkDrawdownStatus();
  }
  
  /**
   * Evaluate a trade request against FXIFY rules
   * @param {Object} request - Trade request to evaluate
   * @param {Object} profile - FXIFY profile to use (defaults to active profile)
   * @returns {Object} - Evaluation result
   */
  evaluateTradeRequest(request, profile = null) {
    try {
      // Use active profile if none provided
      const activeProfile = profile || this.activeProfile;
      
      if (!activeProfile) {
        return { valid: true, rules: [] };
      }
      
      const ruleViolations = [];
      const warnings = [];
      
      // Evaluate all rules
      for (const [ruleName, evaluator] of this.ruleEvaluators) {
        const result = evaluator.evaluate(request, activeProfile);
        
        if (!result.valid) {
          // If rule is violated
          ruleViolations.push({
            rule: ruleName,
            severity: result.severity || 'error',
            message: result.message,
            details: result.details
          });
        } else if (result.severity === 'warning') {
          // If rule generates a warning
          warnings.push({
            rule: ruleName,
            severity: 'warning',
            message: result.message,
            details: result.details
          });
        }
      }
      
      // Combine violations and warnings
      const allIssues = [...ruleViolations, ...warnings];
      
      return {
        valid: ruleViolations.length === 0,
        rules: allIssues
      };
    } catch (error) {
      console.error('Error evaluating trade request:', error);
      return {
        valid: false,
        rules: [{
          rule: 'system_error',
          severity: 'error',
          message: `Error evaluating trade rules: ${error.message}`
        }]
      };
    }
  }
  
  /**
   * Evaluate position against FXIFY rules
   * @param {Object} position - Position to evaluate
   * @param {Object} profile - FXIFY profile to use
   * @returns {Object} - Evaluation result
   */
  evaluatePosition(position, profile = null) {
    // Similar to evaluateTradeRequest but for existing positions
    // For now, return a valid result as positions are already open
    return { valid: true, rules: [] };
  }
  
  /**
   * Evaluate account status against FXIFY rules
   * @param {Object} account - Account info to evaluate
   * @param {Object} profile - FXIFY profile to use
   * @returns {Object} - Evaluation result
   */
  evaluateAccount(account, profile = null) {
    try {
      // Use active profile if none provided
      const activeProfile = profile || this.activeProfile;
      
      if (!activeProfile) {
        return { valid: true, rules: [] };
      }
      
      const issues = [];
      
      // Check drawdown status
      const drawdownStatus = this.drawdownMonitor.getStatus();
      
      if (drawdownStatus.dailyLimitExceeded) {
        issues.push({
          rule: 'daily_drawdown_exceeded',
          severity: 'error',
          message: `Daily drawdown limit of ${activeProfile.maxDailyDrawdown * 100}% has been exceeded (current: ${(drawdownStatus.dailyDrawdown * 100).toFixed(2)}%)`,
          details: drawdownStatus
        });
      }
      
      if (drawdownStatus.totalLimitExceeded) {
        issues.push({
          rule: 'total_drawdown_exceeded',
          severity: 'error',
          message: `Total drawdown limit of ${activeProfile.maxTotalDrawdown * 100}% has been exceeded (current: ${(drawdownStatus.totalDrawdown * 100).toFixed(2)}%)`,
          details: drawdownStatus
        });
      }
      
      // Check profit targets
      const currentProfit = this.getCurrentProfit();
      const profitTarget = activeProfile.profitTarget;
      
      if (currentProfit >= profitTarget) {
        issues.push({
          rule: 'profit_target_reached',
          severity: 'info',
          message: `Profit target of ${profitTarget * 100}% has been reached (current: ${(currentProfit * 100).toFixed(2)}%)`,
          details: { target: profitTarget, current: currentProfit }
        });
      }
      
      // Check trading days requirement
      const remainingDays = this.getMinRemainingTradingDays(activeProfile);
      
      if (remainingDays > 0) {
        issues.push({
          rule: 'min_trading_days',
          severity: 'info',
          message: `Minimum trading days requirement not yet met (${this.tradingDaysCompleted} of ${activeProfile.minTradingDays} days)`,
          details: { completed: this.tradingDaysCompleted, required: activeProfile.minTradingDays, remaining: remainingDays }
        });
      }
      
      return {
        valid: !issues.some(issue => issue.severity === 'error'),
        rules: issues
      };
    } catch (error) {
      console.error('Error evaluating account:', error);
      return {
        valid: false,
        rules: [{
          rule: 'system_error',
          severity: 'error',
          message: `Error evaluating account: ${error.message}`
        }]
      };
    }
  }
  
  /**
   * Get current drawdown status
   * @returns {Object} - Drawdown status
   */
  getDrawdownStatus() {
    return this.drawdownMonitor.getStatus();
  }
  
  /**
   * Get minimum remaining trading days needed to meet requirement
   * @param {Object} profile - FXIFY profile to use
   * @returns {number} - Remaining trading days
   */
  getMinRemainingTradingDays(profile = null) {
    const activeProfile = profile || this.activeProfile;
    
    if (!activeProfile) {
      return 0;
    }
    
    const minDays = activeProfile.minTradingDays || 0;
    const remaining = Math.max(0, minDays - this.tradingDaysCompleted);
    return remaining;
  }
  
  /**
   * Check if positions should be closed to comply with rules
   * @returns {Object} - Close recommendations
   */
  shouldClosePositionsForRuleCompliance() {
    if (!this.activeProfile) {
      return { shouldClose: false };
    }
    
    const drawdownStatus = this.drawdownMonitor.getStatus();
    
    if (drawdownStatus.dailyLimitExceeded) {
      return {
        shouldClose: true,
        reason: 'Daily drawdown limit exceeded',
        details: drawdownStatus
      };
    }
    
    if (drawdownStatus.totalLimitExceeded) {
      return {
        shouldClose: true,
        reason: 'Total drawdown limit exceeded',
        details: drawdownStatus
      };
    }
    
    return { shouldClose: false };
  }
  
  /**
   * Generate a report on rule compliance
   * @returns {Object} - Rule compliance report
   */
  generateRuleComplianceReport() {
    if (!this.activeProfile) {
      return { compliant: false, message: 'No active FXIFY profile' };
    }
    
    const drawdownStatus = this.drawdownMonitor.getStatus();
    const profit = this.getCurrentProfit();
    const remainingDays = this.getMinRemainingTradingDays();
    
    // Check all rules
    const drawdownCompliant = !drawdownStatus.dailyLimitExceeded && !drawdownStatus.totalLimitExceeded;
    const profitCompliant = profit >= this.activeProfile.profitTarget;
    const daysCompliant = remainingDays === 0;
    
    // Create report
    const report = {
      timestamp: new Date().toISOString(),
      profileName: this.activeProfile.name,
      profileType: this.activeProfile.accountType,
      compliant: drawdownCompliant && (profitCompliant && daysCompliant),
      drawdown: {
        compliant: drawdownCompliant,
        dailyDrawdown: drawdownStatus.dailyDrawdown,
        totalDrawdown: drawdownStatus.totalDrawdown,
        dailyLimit: this.activeProfile.maxDailyDrawdown,
        totalLimit: this.activeProfile.maxTotalDrawdown
      },
      profit: {
        compliant: profitCompliant,
        current: profit,
        target: this.activeProfile.profitTarget
      },
      tradingDays: {
        compliant: daysCompliant,
        completed: this.tradingDaysCompleted,
        required: this.activeProfile.minTradingDays,
        remaining: remainingDays
      },
      warnings: this.warnings,
      recommendations: []
    };
    
    // Add recommendations
    if (!drawdownCompliant) {
      report.recommendations.push('Close all positions to prevent further drawdown violations');
    }
    
    if (!profitCompliant) {
      report.recommendations.push(`Continue trading to reach profit target of ${(this.activeProfile.profitTarget * 100).toFixed(0)}%`);
    }
    
    if (!daysCompliant) {
      report.recommendations.push(`Complete at least ${remainingDays} more trading days to meet minimum requirement`);
    }
    
    return report;
  }
  
  /**
   * Get current profit percentage
   * @returns {number} - Current profit percentage (0-1)
   */
  getCurrentProfit() {
    if (this.initialBalance === 0) return 0;
    
    return Math.max(0, (this.currentBalance - this.initialBalance) / this.initialBalance);
  }
  
  /**
   * Get number of trading days completed
   * @returns {number} - Trading days completed
   */
  getTradingDaysCompleted() {
    return this.tradingDaysCompleted;
  }
  
  /**
   * Get active warnings
   * @returns {Array<string>} - List of active warnings
   */
  getActiveWarnings() {
    const warnings = [...this.warnings];
    
    // Add drawdown warnings if needed
    const drawdownStatus = this.drawdownMonitor.getStatus();
    if (drawdownStatus.warningLevel === 'warning') {
      warnings.push(`Approaching drawdown limit: Daily ${(drawdownStatus.dailyDrawdown * 100).toFixed(2)}% of ${(this.activeProfile?.maxDailyDrawdown || 0) * 100}%`);
    } else if (drawdownStatus.warningLevel === 'critical') {
      warnings.push(`Critical drawdown level: Daily ${(drawdownStatus.dailyDrawdown * 100).toFixed(2)}% of ${(this.activeProfile?.maxDailyDrawdown || 0) * 100}%`);
    }
    
    return warnings;
  }
  
  /**
   * Register a new trading day (updates trading days counter)
   * @returns {void}
   */
  registerTradingDay() {
    // Don't count the same day twice
    const today = new Date().toISOString().split('T')[0];
    
    if (!this.tradingDaysHistory.includes(today)) {
      this.tradingDaysHistory.push(today);
      this.tradingDaysCompleted++;
      this.dailyTradeCount = 0; // Reset daily count
    }
  }
  
  /**
   * Increment trade count (daily and weekly)
   * @returns {void}
   */
  incrementTradeCount() {
    this.dailyTradeCount++;
    this.weeklyTradeCount++;
    
    // Register a new trading day when first trade of the day is made
    if (this.dailyTradeCount === 1) {
      this.registerTradingDay();
    }
  }
  
  /**
   * Reset weekly trade count (called at the start of each week)
   * @returns {void}
   */
  resetWeeklyTradeCount() {
    this.weeklyTradeCount = 0;
  }
  
  /**
   * Check drawdown status and update warnings
   * @private
   */
  _checkDrawdownStatus() {
    const drawdownStatus = this.drawdownMonitor.getStatus();
    
    if (drawdownStatus.warningLevel === 'critical' || drawdownStatus.warningLevel === 'warning') {
      this.eventEmitter.emit('drawdown_warning', drawdownStatus);
    }
    
    if (drawdownStatus.dailyLimitExceeded || drawdownStatus.totalLimitExceeded) {
      this.eventEmitter.emit('drawdown_exceeded', drawdownStatus);
    }
  }
}

module.exports = {
  FXIFYRulesEngine
};