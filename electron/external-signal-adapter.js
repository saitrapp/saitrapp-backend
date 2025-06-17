// electron/external-signal-adapter.js

const path = require('path');

/**
 * ExternalSignalAdapter manages different types of external signal sources
 * Acts as a factory to create appropriate signal provider instances
 */
class ExternalSignalAdapter {
  /**
   * Create an adapter for a specific signal source type
   * @param {string} sourceType - Type of signal source
   * @param {string} sourceId - ID of the signal source
   * @param {Object} config - Configuration for the source
   * @param {Function} signalHandler - Callback for handling received signals
   * @returns {Object} Signal provider instance
   */
  static createAdapter(sourceType, sourceId, config, signalHandler) {
    try {
      let providerModule;
      
      switch (sourceType) {
        case 'webhook':
          providerModule = require('./signal-providers/webhook-provider');
          break;
        case 'telegram':
          providerModule = require('./signal-providers/telegram-provider');
          break;
        case 'email':
          providerModule = require('./signal-providers/email-provider');
          break;
        default:
          console.error(`Unsupported signal source type: ${sourceType}`);
          return null;
      }
      
      // Create the provider instance
      return new providerModule(sourceId, config, signalHandler);
    } catch (error) {
      console.error(`Failed to create signal adapter for ${sourceType}:`, error);
      return null;
    }
  }
  
  /**
   * Get standardized status for a signal source
   * @param {Object} adapter - Signal provider adapter
   * @returns {Object} Status object
   */
  static getProviderStatus(adapter) {
    if (!adapter) {
      return { status: 'disconnected', lastUpdate: null };
    }
    
    return adapter.getStatus();
  }
}

module.exports = ExternalSignalAdapter;