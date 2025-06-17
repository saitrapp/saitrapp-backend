// electron/fxify/drawdown-monitor.js
/**
 * DrawdownMonitor
 * Specialized component for tracking drawdown limits
 */
class DrawdownMonitor {
  /**
   * Create a new DrawdownMonitor instance
   */
  constructor() {
    this.dailyDrawdowns = new Map();
    this.maxDailyDrawdown = 0.03; // Default 3%
    this.totalDrawdown = 0;
    this.maxTotalDrawdown = 0.06; // Default 6%
    this.initialBalance = 0;
    this.startOfDayBalance = 0;
    this.currentBalance = 0;
    this.currentEquity = 0;
    this.peakBalance = 0;
    this.drawdownHistory = [];
    this.lastUpdate = new Date();
  }
  
  /**
   * Initialize the drawdown monitor with initial values
   * @param {number} initialBalance - Initial account balance
   * @param {number} maxDaily - Maximum daily drawdown (0-1)
   * @param {number} maxTotal - Maximum total drawdown (0-1)
   * @returns {void}
   */
  initialize(initialBalance, maxDaily = 0.03, maxTotal = 0.06) {
    this.initialBalance = initialBalance;
    this.startOfDayBalance = initialBalance;
    this.currentBalance = initialBalance;
    this.currentEquity = initialBalance;
    this.peakBalance = initialBalance;
    this.maxDailyDrawdown = maxDaily;
    this.maxTotalDrawdown = maxTotal;
    this.dailyDrawdowns.clear();
    this.drawdownHistory = [];
    
    // Register start of day
    this.registerDayStart();
    
    console.log(`DrawdownMonitor initialized: initial balance ${initialBalance}, daily limit ${maxDaily * 100}%, total limit ${maxTotal * 100}%`);
  }
  
  /**
   * Update account balance
   * @param {number} newBalance - Current account balance
   * @param {number} equity - Current account equity (including floating P/L)
   * @returns {void}
   */
  updateBalance(newBalance, equity = null) {
    this.currentBalance = newBalance;
    this.currentEquity = equity !== null ? equity : newBalance;
    
    // Update peak balance if this is a new peak
    if (newBalance > this.peakBalance) {
      this.peakBalance = newBalance;
    }
    
    // Check if a new day has started since last update
    const today = new Date().toISOString().split('T')[0];
    const lastUpdateDay = this.lastUpdate.toISOString().split('T')[0];
    
    if (today !== lastUpdateDay) {
      this.registerDayStart();
    }
    
    // Calculate current drawdowns
    this._calculateDrawdowns();
    
    // Add to drawdown history
    this._updateDrawdownHistory();
    
    // Update last update timestamp
    this.lastUpdate = new Date();
  }
  
  /**
   * Register the start of a new trading day
   * @returns {void}
   */
  registerDayStart() {
    const today = new Date().toISOString().split('T')[0];
    
    // Save the balance at the start of the day
    this.startOfDayBalance = this.currentBalance;
    
    // Initialize today's drawdown
    this.dailyDrawdowns.set(today, 0);
    
    console.log(`New trading day registered: ${today}, starting balance: ${this.startOfDayBalance}`);
  }
  
  /**
   * Calculate current daily and total drawdowns
   * @private
   */
  _calculateDrawdowns() {
    const today = new Date().toISOString().split('T')[0];
    
    // Calculate daily drawdown (using equity for real-time monitoring)
    let dailyDrawdown = 0;
    if (this.startOfDayBalance > 0) {
      dailyDrawdown = Math.max(0, (this.startOfDayBalance - this.currentEquity) / this.startOfDayBalance);
    }
    
    // Update daily drawdown for today
    this.dailyDrawdowns.set(today, dailyDrawdown);
    
    // Calculate total drawdown from peak balance
    if (this.peakBalance > 0) {
      this.totalDrawdown = Math.max(0, (this.peakBalance - this.currentEquity) / this.peakBalance);
    } else if (this.initialBalance > 0) {
      // Fallback to initial balance if no peak balance is set
      this.totalDrawdown = Math.max(0, (this.initialBalance - this.currentEquity) / this.initialBalance);
    }
  }
  
  /**
   * Get current daily drawdown
   * @returns {number} - Current daily drawdown (0-1)
   */
  getCurrentDailyDrawdown() {
    const today = new Date().toISOString().split('T')[0];
    return this.dailyDrawdowns.get(today) || 0;
  }
  
  /**
   * Get current total drawdown
   * @returns {number} - Current total drawdown (0-1)
   */
  getCurrentTotalDrawdown() {
    return this.totalDrawdown;
  }
  
  /**
   * Check if daily drawdown limit is exceeded
   * @returns {boolean} - True if daily limit is exceeded
   */
  isDailyLimitExceeded() {
    return this.getCurrentDailyDrawdown() > this.maxDailyDrawdown;
  }
  
  /**
   * Check if total drawdown limit is exceeded
   * @returns {boolean} - True if total limit is exceeded
   */
  isTotalLimitExceeded() {
    return this.totalDrawdown > this.maxTotalDrawdown;
  }
  
  /**
   * Get current warning level based on drawdown percentages
   * @returns {string} - Warning level: 'safe', 'warning', or 'critical'
   */
  getWarningLevel() {
    const dailyDrawdownPercentage = this.getCurrentDailyDrawdown() / this.maxDailyDrawdown;
    const totalDrawdownPercentage = this.totalDrawdown / this.maxTotalDrawdown;
    
    // If either limit is exceeded, return 'critical'
    if (dailyDrawdownPercentage >= 1 || totalDrawdownPercentage >= 1) {
      return 'critical';
    }
    
    // If either drawdown is at 80% or more of its limit, return 'warning'
    if (dailyDrawdownPercentage >= 0.8 || totalDrawdownPercentage >= 0.8) {
      return 'warning';
    }
    
    return 'safe';
  }
  
  /**
   * Reset the drawdown monitor
   * @returns {void}
   */
  resetMonitor() {
    this.dailyDrawdowns.clear();
    this.totalDrawdown = 0;
    this.initialBalance = 0;
    this.startOfDayBalance = 0;
    this.currentBalance = 0;
    this.currentEquity = 0;
    this.peakBalance = 0;
    this.drawdownHistory = [];
    this.lastUpdate = new Date();
  }
  
  /**
   * Get drawdown history
   * @returns {Array<Object>} - Drawdown history items
   */
  getDrawdownHistory() {
    return [...this.drawdownHistory];
  }
  
  /**
   * Update drawdown history
   * @private
   */
  _updateDrawdownHistory() {
    const dailyDrawdown = this.getCurrentDailyDrawdown();
    
    this.drawdownHistory.push({
      date: new Date(),
      dailyDrawdown: dailyDrawdown,
      totalDrawdown: this.totalDrawdown,
      balance: this.currentBalance,
      equity: this.currentEquity
    });
    
    // Limit history size to prevent memory issues
    if (this.drawdownHistory.length > 1000) {
      this.drawdownHistory = this.drawdownHistory.slice(-1000);
    }
  }
  
  /**
   * Get current drawdown status
   * @returns {Object} - Drawdown status
   */
  getStatus() {
    return {
      dailyDrawdown: this.getCurrentDailyDrawdown(),
      totalDrawdown: this.totalDrawdown,
      dailyLimitExceeded: this.isDailyLimitExceeded(),
      totalLimitExceeded: this.isTotalLimitExceeded(),
      warningLevel: this.getWarningLevel(),
      currentBalance: this.currentBalance,
      currentEquity: this.currentEquity,
      initialBalance: this.initialBalance,
      startOfDayBalance: this.startOfDayBalance,
      peakBalance: this.peakBalance,
      maxDailyLimit: this.maxDailyDrawdown,
      maxTotalLimit: this.maxTotalDrawdown
    };
  }
}

module.exports = {
  DrawdownMonitor
};