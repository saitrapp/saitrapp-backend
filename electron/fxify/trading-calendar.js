// electron/fxify/trading-calendar.js
const { EventEmitter } = require('events');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;

/**
 * TradingCalendar
 * Manages economic events calendar and provides news trading protection
 */
class TradingCalendar {
  /**
   * Create a new TradingCalendar instance
   * @param {Object} config - Optional configuration
   * @param {string} config.dataPath - Path to store calendar data
   * @param {string} config.dataSource - Data source URL or identifier
   */
  constructor(config = {}) {
    this.economicEvents = [];
    this.lastUpdate = new Date();
    this.dataSource = config.dataSource || 'default';
    this.eventListeners = [];
    this.eventEmitter = new EventEmitter();
    this.dataPath = config.dataPath || path.join(process.env.APPDATA || process.env.HOME, 'saitrapp', 'fxify', 'calendar');
    this.updateInterval = null;
    this.currencyMap = this._initializeCurrencyMap();
  }
  
  /**
   * Initialize the trading calendar
   * @returns {Promise<boolean>} - Success status
   */
  async initialize() {
    try {
      // Ensure data directory exists
      await this._ensureDataDirectory();
      
      // Load cached events
      await this._loadCachedEvents();
      
      // Refresh calendar
      await this.refreshCalendar();
      
      // Set up automatic updates (every 6 hours)
      this._setupAutomaticUpdates();
      
      return true;
    } catch (error) {
      console.error('Failed to initialize trading calendar:', error);
      return false;
    }
  }
  
  /**
   * Ensure data directory exists
   * @private
   * @returns {Promise<void>}
   */
  async _ensureDataDirectory() {
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
  
  /**
   * Set up automatic calendar updates
   * @private
   */
  _setupAutomaticUpdates() {
    // Clear any existing interval
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    // Set up new interval (6 hours)
    this.updateInterval = setInterval(() => {
      this.refreshCalendar().catch(error => {
        console.error('Error in automatic calendar update:', error);
      });
    }, 6 * 60 * 60 * 1000);
  }
  
  /**
   * Refresh the economic calendar with latest events
   * @returns {Promise<Array<Object>>} - List of economic events
   */
  async refreshCalendar() {
    try {
      // Get current date in YYYY-MM-DD format
      const today = new Date().toISOString().split('T')[0];
      
      // Calculate date one week from now
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      const nextWeekStr = nextWeek.toISOString().split('T')[0];
      
      // Fetch events from data source
      const events = await this._fetchEventsFromSource(today, nextWeekStr);
      
      // Update the events list
      this.economicEvents = events;
      this.lastUpdate = new Date();
      
      // Save to cache
      await this._saveEventsToCache(events);
      
      // Notify listeners
      this.eventEmitter.emit('calendar_updated', events);
      
      console.log(`Trading calendar updated with ${events.length} events`);
      
      return events;
    } catch (error) {
      console.error('Failed to refresh economic calendar:', error);
      throw error;
    }
  }
  
  /**
   * Fetch economic events from the data source
   * @private
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {Promise<Array<Object>>} - List of economic events
   */
  async _fetchEventsFromSource(startDate, endDate) {
    try {
      // In a real implementation, this would fetch from an economic calendar API
      // For now, use a simulated data source
      
      if (this.dataSource === 'api') {
        try {
          // Example of how a real API call might look
          const response = await axios.get('https://api.example.com/economic-calendar', {
            params: { startDate, endDate }
          });
          
          return response.data.events.map(event => this._normalizeEventData(event));
        } catch (apiError) {
          console.error('API request failed, using cached data:', apiError);
          return this.economicEvents;
        }
      } else {
        // For development/demo, use simulated data
        return this._generateSimulatedEvents(startDate, endDate);
      }
    } catch (error) {
      console.error('Error fetching events from source:', error);
      // Return existing events as fallback
      return this.economicEvents;
    }
  }
  
  /**
   * Generate simulated economic events for testing
   * @private
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {Array<Object>} - List of simulated events
   */
  _generateSimulatedEvents(startDate, endDate) {
    const events = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // Major currency codes
    const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];
    
    // Event types
    const eventTypes = [
      { name: 'Interest Rate Decision', impact: 'high' },
      { name: 'Non-Farm Payrolls', impact: 'high', currency: 'USD' },
      { name: 'CPI', impact: 'high' },
      { name: 'GDP', impact: 'high' },
      { name: 'Retail Sales', impact: 'medium' },
      { name: 'Trade Balance', impact: 'medium' },
      { name: 'Unemployment Rate', impact: 'high' },
      { name: 'Manufacturing PMI', impact: 'medium' },
      { name: 'Services PMI', impact: 'medium' },
      { name: 'Consumer Confidence', impact: 'medium' },
      { name: 'Building Permits', impact: 'low' },
      { name: 'Industrial Production', impact: 'low' }
    ];
    
    // Generate random events for each day
    for (let day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
      // Skip weekends
      if (day.getDay() === 0 || day.getDay() === 6) continue;
      
      // Generate 2-5 events per day
      const numEvents = Math.floor(Math.random() * 4) + 2;
      
      for (let i = 0; i < numEvents; i++) {
        // Pick a random currency and event type
        const currency = currencies[Math.floor(Math.random() * currencies.length)];
        const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
        
        // Use the event type's specific currency if defined
        const eventCurrency = eventType.currency || currency;
        
        // Generate a random time between 8:00 and 18:00
        const hour = Math.floor(Math.random() * 10) + 8;
        const minute = Math.floor(Math.random() * 60);
        
        // Create event date (clone the day date)
        const eventDate = new Date(day);
        eventDate.setHours(hour, minute, 0, 0);
        
        events.push({
          id: `sim_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          title: `${eventCurrency} ${eventType.name}`,
          date: eventDate.toISOString(),
          currency: eventCurrency,
          impact: eventType.impact,
          forecast: (Math.random() * 5).toFixed(1) + '%',
          previous: (Math.random() * 5).toFixed(1) + '%',
          description: `${eventCurrency} ${eventType.name} for ${eventDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
        });
      }
    }
    
    return events;
  }
  
  /**
   * Normalize event data from different sources
   * @private
   * @param {Object} event - Raw event data
   * @returns {Object} - Normalized event data
   */
  _normalizeEventData(event) {
    // Standardize event object properties across different data sources
    return {
      id: event.id || `event_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      title: event.title || event.name || 'Unnamed Economic Event',
      date: event.date || event.datetime || new Date().toISOString(),
      currency: event.currency || event.currencyCode || 'USD',
      impact: this._normalizeImpactLevel(event.impact || event.importance || 'low'),
      forecast: event.forecast || event.expected || 'N/A',
      previous: event.previous || event.prior || 'N/A',
      description: event.description || event.title || 'No description available'
    };
  }
  
  /**
   * Normalize impact level terminologies
   * @private
   * @param {string} impact - Raw impact level
   * @returns {string} - Normalized impact level: 'low', 'medium', or 'high'
   */
  _normalizeImpactLevel(impact) {
    impact = String(impact).toLowerCase();
    
    if (['high', 'major', '3', 'important', 'critical'].includes(impact)) {
      return 'high';
    } else if (['medium', 'moderate', '2', 'normal'].includes(impact)) {
      return 'medium';
    } else {
      return 'low';
    }
  }
  
  /**
   * Initialize currency code mapping
   * @private
   * @returns {Object} - Currency code mappings
   */
  _initializeCurrencyMap() {
    return {
      // ISO 4217 currency codes to common names
      USD: ['dollar', 'usd', 'us'],
      EUR: ['euro', 'eur'],
      GBP: ['pound', 'sterling', 'gbp', 'uk'],
      JPY: ['yen', 'jpy', 'japan', 'japanese'],
      AUD: ['aussie', 'australian', 'aud'],
      CAD: ['loonie', 'canadian', 'cad'],
      CHF: ['franc', 'swiss', 'chf'],
      NZD: ['kiwi', 'new zealand', 'nzd'],
      CNY: ['yuan', 'renminbi', 'cny', 'china', 'chinese'],
      MXN: ['peso', 'mexican', 'mxn'],
      
      // Currency pair reference
      EURUSD: ['EUR', 'USD'],
      GBPUSD: ['GBP', 'USD'],
      USDJPY: ['USD', 'JPY'],
      USDCHF: ['USD', 'CHF'],
      AUDUSD: ['AUD', 'USD'],
      USDCAD: ['USD', 'CAD'],
      NZDUSD: ['NZD', 'USD']
    };
  }
  
  /**
   * Save events to cache file
   * @private
   * @param {Array<Object>} events - Events to cache
   * @returns {Promise<void>}
   */
  async _saveEventsToCache(events) {
    try {
      const cacheFile = path.join(this.dataPath, 'events_cache.json');
      
      await fs.writeFile(
        cacheFile,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          events
        }, null, 2),
        'utf8'
      );
    } catch (error) {
      console.error('Failed to save events to cache:', error);
    }
  }
  
  /**
   * Load cached events from file
   * @private
   * @returns {Promise<void>}
   */
  async _loadCachedEvents() {
    try {
      const cacheFile = path.join(this.dataPath, 'events_cache.json');
      
      try {
        const data = await fs.readFile(cacheFile, 'utf8');
        const cache = JSON.parse(data);
        
        // Check if cache is still valid (less than 24 hours old)
        const cacheTime = new Date(cache.timestamp);
        const now = new Date();
        const hoursSinceCache = (now - cacheTime) / (1000 * 60 * 60);
        
        if (hoursSinceCache < 24 && Array.isArray(cache.events)) {
          this.economicEvents = cache.events;
          console.log(`Loaded ${this.economicEvents.length} events from cache`);
        } else {
          console.log('Cache is too old, will refresh calendar');
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.log('No cache file found, will create new one');
        } else {
          console.error('Error loading cached events:', error);
        }
      }
    } catch (error) {
      console.error('Failed to load cached events:', error);
    }
  }
  
  /**
   * Get events within a date range
   * @param {Date|string} start - Start date
   * @param {Date|string} end - End date
   * @returns {Array<Object>} - Events within the specified range
   */
  getEventsInRange(start, end) {
    const startDate = start instanceof Date ? start : new Date(start);
    const endDate = end instanceof Date ? end : new Date(end);
    
    return this.economicEvents.filter(event => {
      const eventDate = new Date(event.date);
      return eventDate >= startDate && eventDate <= endDate;
    });
  }
  
  /**
   * Get events for a specific currency
   * @param {string} currency - Currency code (e.g., 'USD')
   * @returns {Array<Object>} - Events for the specified currency
   */
  getEventsByCurrency(currency) {
    const currencyUpper = currency.toUpperCase();
    
    return this.economicEvents.filter(event => 
      event.currency === currencyUpper ||
      event.title.includes(currencyUpper) ||
      event.description.includes(currencyUpper)
    );
  }
  
  /**
   * Get events with minimum impact level
   * @param {string} minImpact - Minimum impact level ('low', 'medium', 'high')
   * @returns {Array<Object>} - Events with the specified minimum impact
   */
  getEventsByImpact(minImpact) {
    const impactLevels = { low: 1, medium: 2, high: 3 };
    const minLevel = impactLevels[minImpact.toLowerCase()] || 1;
    
    return this.economicEvents.filter(event => {
      const eventLevel = impactLevels[event.impact.toLowerCase()] || 1;
      return eventLevel >= minLevel;
    });
  }
  
  /**
   * Check if there's a high-impact event active or imminent for a symbol
   * @param {string} symbol - Symbol to check (e.g., 'EURUSD')
   * @returns {boolean} - True if a high-impact event is active
   */
  isHighImpactEventActive(symbol) {
    if (!symbol) return false;
    
    // Get currencies involved in this symbol
    const currencies = this._getCurrenciesForSymbol(symbol);
    if (!currencies.length) return false;
    
    // Get current time
    const now = new Date();
    
    // Check for events in the next 60 minutes
    const eventWindow = new Date(now);
    eventWindow.setMinutes(now.getMinutes() + 60);
    
    // Find high-impact events for these currencies
    const relevantEvents = this.economicEvents.filter(event => {
      // Check if the event is for a relevant currency
      const isRelevantCurrency = currencies.includes(event.currency);
      if (!isRelevantCurrency) return false;
      
      // Check if event is high-impact
      const isHighImpact = event.impact.toLowerCase() === 'high';
      if (!isHighImpact) return false;
      
      // Check if event is active or imminent (within the next hour)
      const eventTime = new Date(event.date);
      return eventTime >= now && eventTime <= eventWindow;
    });
    
    return relevantEvents.length > 0;
  }
  
  /**
   * Get the next significant event for a symbol
   * @param {string} symbol - Symbol to check (e.g., 'EURUSD')
   * @returns {Object|null} - Next significant event or null if none found
   */
  getNextSignificantEvent(symbol) {
    if (!symbol) return null;
    
    // Get currencies involved in this symbol
    const currencies = this._getCurrenciesForSymbol(symbol);
    if (!currencies.length) return null;
    
    // Get current time
    const now = new Date();
    
    // Find upcoming events for these currencies
    const relevantEvents = this.economicEvents.filter(event => {
      // Check if the event is for a relevant currency
      const isRelevantCurrency = currencies.includes(event.currency);
      if (!isRelevantCurrency) return false;
      
      // Check if event is in the future
      const eventTime = new Date(event.date);
      return eventTime >= now;
    });
    
    // Sort by date and importance
    relevantEvents.sort((a, b) => {
      // First by date
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      const dateDiff = dateA - dateB;
      if (dateDiff !== 0) return dateDiff;
      
      // Then by impact (high > medium > low)
      const impactLevels = { high: 3, medium: 2, low: 1 };
      const impactA = impactLevels[a.impact.toLowerCase()] || 0;
      const impactB = impactLevels[b.impact.toLowerCase()] || 0;
      return impactB - impactA;
    });
    
    // Return the first event (closest in time) or null if none
    return relevantEvents.length > 0 ? relevantEvents[0] : null;
  }
  
  /**
   * Get currencies involved in a symbol
   * @private
   * @param {string} symbol - Symbol to check (e.g., 'EURUSD', 'EUR/USD')
   * @returns {Array<string>} - Array of currency codes
   */
  _getCurrenciesForSymbol(symbol) {
    if (!symbol) return [];
    
    // Normalize symbol format
    const normalizedSymbol = symbol.replace(/[/\-_]/, '').toUpperCase();
    
    // Check if we have a direct mapping for this pair
    if (this.currencyMap[normalizedSymbol]) {
      return this.currencyMap[normalizedSymbol];
    }
    
    // For standard 6-character forex pairs
    if (normalizedSymbol.length === 6) {
      return [normalizedSymbol.substring(0, 3), normalizedSymbol.substring(3, 6)];
    }
    
    // For indices or commodities, try to extract related currencies
    const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];
    return currencies.filter(currency => normalizedSymbol.includes(currency));
  }
  
  /**
   * Add event listener for calendar events
   * @param {Object} listener - Event listener
   * @param {string} listener.event - Event name to listen for
   * @param {Function} listener.callback - Callback function
   * @returns {string} - Listener ID for removal
   */
  addEventListener(listener) {
    if (!listener || !listener.event || typeof listener.callback !== 'function') {
      throw new Error('Invalid event listener configuration');
    }
    
    const id = `listener_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    this.eventListeners.push({
      id,
      event: listener.event,
      callback: listener.callback
    });
    
    // Add to event emitter
    this.eventEmitter.on(listener.event, listener.callback);
    
    return id;
  }
  
  /**
   * Remove an event listener
   * @param {string} listenerId - Listener ID to remove
   * @returns {boolean} - Success status
   */
  removeEventListener(listenerId) {
    const index = this.eventListeners.findIndex(listener => listener.id === listenerId);
    
    if (index !== -1) {
      const listener = this.eventListeners[index];
      this.eventEmitter.off(listener.event, listener.callback);
      this.eventListeners.splice(index, 1);
      return true;
    }
    
    return false;
  }
  
  /**
   * Clean up resources when shutting down
   */
  dispose() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    this.eventEmitter.removeAllListeners();
    this.eventListeners = [];
  }
}

module.exports = {
  TradingCalendar
};