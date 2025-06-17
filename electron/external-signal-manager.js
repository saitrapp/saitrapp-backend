// electron/external-signal-manager.js

const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const path = require('path');
const ExternalSignalAdapter = require('./external-signal-adapter');

/**
 * ExternalSignalManager handles configuration and integration of external signal sources
 * Manages the lifecycle of various signal providers and processes incoming signals
 */
class ExternalSignalManager extends EventEmitter {
  /**
   * Create a new ExternalSignalManager instance
   * @param {DatabaseManager} dbManager - Database manager instance
   * @param {SignalManager} signalManager - Signal manager for processing signals
   */
  constructor(dbManager, signalManager) {
    super();
    this.dbManager = dbManager;
    this.signalManager = signalManager;
    
    // Initialize adapters map
    this.adapters = new Map();
    
    // Supported signal source types
    this.supportedSourceTypes = [
      { id: 'webhook', name: 'Webhook API', description: 'Receive signals via HTTP webhooks' },
      { id: 'telegram', name: 'Telegram Bot', description: 'Receive signals through Telegram messages' },
      { id: 'email', name: 'Email Integration', description: 'Process signals from designated email accounts' }
    ];
  }
  
  /**
   * Initialize the external signal manager and update database schema
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      // Create necessary database tables if they don't exist
      await this._updateDatabaseSchema();
      
      // Load and initialize active signal sources
      await this.initializeActiveSources();
      
      console.log('External signal manager initialized successfully');
      return true;
    } catch (error) {
      console.error('Failed to initialize external signal manager:', error);
      return false;
    }
  }
  
  /**
   * Update database schema to include external signal source tables
   * @private
   * @returns {Promise<void>}
   */
  async _updateDatabaseSchema() {
    const createTableQueries = [
      // Table for external signal source configurations
      `CREATE TABLE IF NOT EXISTS external_signal_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        is_active INTEGER DEFAULT 0,
        config TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_signal_at TIMESTAMP,
        signal_count INTEGER DEFAULT 0
      )`,
      
      // Table for signal parsing templates
      `CREATE TABLE IF NOT EXISTS signal_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_id TEXT,
        pattern TEXT NOT NULL,
        symbol_field TEXT,
        direction_field TEXT,
        price_field TEXT,
        stop_loss_field TEXT,
        take_profit_field TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (source_id) REFERENCES external_signal_sources(id) ON DELETE CASCADE
      )`,
      
      // Table to store raw signals received from external sources
      `CREATE TABLE IF NOT EXISTS raw_signals (
        id TEXT PRIMARY KEY,
        source_id TEXT,
        content TEXT,
        received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed INTEGER DEFAULT 0,
        processed_at TIMESTAMP,
        processing_result TEXT,
        FOREIGN KEY (source_id) REFERENCES external_signal_sources(id) ON DELETE CASCADE
      )`
    ];
    
    // Create tables
    for (const query of createTableQueries) {
      await this.dbManager.executeQuery(query);
    }
    
    // Create indexes
    const indexQueries = [
      `CREATE INDEX IF NOT EXISTS idx_external_signal_sources_type ON external_signal_sources(source_type)`,
      `CREATE INDEX IF NOT EXISTS idx_external_signal_sources_active ON external_signal_sources(is_active)`,
      `CREATE INDEX IF NOT EXISTS idx_raw_signals_processed ON raw_signals(processed)`,
      `CREATE INDEX IF NOT EXISTS idx_raw_signals_source ON raw_signals(source_id)`
    ];
    
    for (const query of indexQueries) {
      await this.dbManager.executeQuery(query);
    }
  }
  
  /**
   * Get a list of supported external signal source types
   * @returns {Array<Object>} List of supported source types
   */
  getSupportedSourceTypes() {
    return [...this.supportedSourceTypes];
  }
  
  /**
   * Get all configured external signal sources
   * @returns {Promise<Array<Object>>} List of configured signal sources
   */
  async getSignalSources() {
    try {
      const sources = await this.dbManager.executeSelect(
        'SELECT id, name, source_type, is_active, created_at, last_signal_at, signal_count FROM external_signal_sources ORDER BY name'
      );
      
      return sources;
    } catch (error) {
      console.error('Failed to get signal sources:', error);
      throw error;
    }
  }
  
  /**
   * Get details of a specific signal source
   * @param {string} sourceId - Source ID
   * @returns {Promise<Object>} Signal source details
   */
  async getSignalSource(sourceId) {
    try {
      const sources = await this.dbManager.executeSelect(
        'SELECT * FROM external_signal_sources WHERE id = ?',
        [sourceId]
      );
      
      if (sources.length === 0) {
        throw new Error(`Signal source not found: ${sourceId}`);
      }
      
      const source = sources[0];
      
      // Parse config JSON
      source.config = JSON.parse(source.config || '{}');
      
      // Get templates associated with this source
      const templates = await this.dbManager.executeSelect(
        'SELECT * FROM signal_templates WHERE source_id = ?',
        [sourceId]
      );
      
      return { ...source, templates };
    } catch (error) {
      console.error(`Failed to get signal source ${sourceId}:`, error);
      throw error;
    }
  }
  
  /**
   * Add a new external signal source
   * @param {string} name - User-friendly name for this source
   * @param {string} sourceType - Type of signal source
   * @param {Object} config - Configuration for the signal source
   * @returns {Promise<Object>} Created signal source
   */
  async addSignalSource(name, sourceType, config = {}) {
    try {
      // Validate source type
      const sourceTypeInfo = this.supportedSourceTypes.find(t => t.id === sourceType);
      if (!sourceTypeInfo) {
        throw new Error(`Unsupported signal source type: ${sourceType}`);
      }
      
      // Generate ID
      const sourceId = `src_${uuidv4()}`;
      
      // Create the database record
      await this.dbManager.executeQuery(
        `INSERT INTO external_signal_sources 
        (id, name, source_type, config, is_active) 
        VALUES (?, ?, ?, ?, ?)`,
        [
          sourceId,
          name,
          sourceType,
          JSON.stringify(config),
          0 // Not active by default
        ]
      );
      
      // Log the event
      await this.dbManager.logEvent('info', `New external signal source added: ${name} (${sourceType})`);
      
      return { id: sourceId, name, sourceType, isActive: false, config };
    } catch (error) {
      console.error('Failed to add signal source:', error);
      throw error;
    }
  }
  
  /**
   * Update an external signal source
   * @param {string} sourceId - Source ID to update
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated source
   */
  async updateSignalSource(sourceId, updates) {
    try {
      // Get current source
      const source = await this.getSignalSource(sourceId);
      
      const updateFields = [];
      const updateValues = [];
      
      // Update name if provided
      if (updates.name !== undefined) {
        updateFields.push('name = ?');
        updateValues.push(updates.name);
      }
      
      // Update config if provided
      if (updates.config !== undefined) {
        updateFields.push('config = ?');
        updateValues.push(JSON.stringify(updates.config));
      }
      
      // Update active status if provided
      if (updates.isActive !== undefined) {
        updateFields.push('is_active = ?');
        updateValues.push(updates.isActive ? 1 : 0);
        
        // If changing active status, initialize or stop the source
        if (updates.isActive && !source.is_active) {
          await this._initializeSource(sourceId);
        } else if (!updates.isActive && source.is_active) {
          await this._stopSource(sourceId);
        }
      }
      
      // If there are fields to update, run the update query
      if (updateFields.length > 0) {
        updateValues.push(sourceId); // For the WHERE clause
        await this.dbManager.executeQuery(
          `UPDATE external_signal_sources SET ${updateFields.join(', ')} WHERE id = ?`,
          updateValues
        );
      }
      
      // Log the update
      await this.dbManager.logEvent('info', `External signal source updated: ${source.name}`);
      
      // Return the updated source
      return await this.getSignalSource(sourceId);
    } catch (error) {
      console.error(`Failed to update signal source ${sourceId}:`, error);
      throw error;
    }
  }
  
  /**
   * Delete an external signal source
   * @param {string} sourceId - Source ID
   * @returns {Promise<boolean>} Success status
   */
  async deleteSignalSource(sourceId) {
    try {
      // Get source details for logging
      const source = await this.getSignalSource(sourceId);
      
      // If source is active, stop it first
      if (source.is_active) {
        await this._stopSource(sourceId);
      }
      
      // Delete from database
      await this.dbManager.executeQuery(
        'DELETE FROM external_signal_sources WHERE id = ?',
        [sourceId]
      );
      
      // Log the event
      await this.dbManager.logEvent('info', `External signal source deleted: ${source.name}`);
      
      return true;
    } catch (error) {
      console.error(`Failed to delete signal source ${sourceId}:`, error);
      throw error;
    }
  }
  
  /**
   * Add a signal parsing template for a source
   * @param {string} sourceId - Source ID
   * @param {string} name - Template name
   * @param {Object} template - Template configuration
   * @returns {Promise<Object>} Created template
   */
  async addSignalTemplate(sourceId, name, template) {
    try {
      // Validate template
      if (!template.pattern) {
        throw new Error('Template must include a pattern');
      }
      
      // Generate ID
      const templateId = `tmpl_${uuidv4()}`;
      
      // Create the template record
      await this.dbManager.executeQuery(
        `INSERT INTO signal_templates 
        (id, name, source_id, pattern, symbol_field, direction_field, price_field, stop_loss_field, take_profit_field) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          templateId,
          name,
          sourceId,
          template.pattern,
          template.symbolField,
          template.directionField,
          template.priceField,
          template.stopLossField,
          template.takeProfitField
        ]
      );
      
      // Log the event
      await this.dbManager.logEvent('info', `New signal template added: ${name}`, { sourceId });
      
      return { 
        id: templateId, 
        name, 
        sourceId, 
        pattern: template.pattern,
        symbolField: template.symbolField,
        directionField: template.directionField,
        priceField: template.priceField,
        stopLossField: template.stopLossField,
        takeProfitField: template.takeProfitField
      };
    } catch (error) {
      console.error('Failed to add signal template:', error);
      throw error;
    }
  }
  
  /**
   * Delete a signal parsing template
   * @param {string} templateId - Template ID
   * @returns {Promise<boolean>} Success status
   */
  async deleteSignalTemplate(templateId) {
    try {
      // Get template details for logging
      const templates = await this.dbManager.executeSelect(
        'SELECT name, source_id FROM signal_templates WHERE id = ?',
        [templateId]
      );
      
      if (templates.length === 0) {
        throw new Error(`Template not found: ${templateId}`);
      }
      
      const template = templates[0];
      
      // Delete from database
      await this.dbManager.executeQuery(
        'DELETE FROM signal_templates WHERE id = ?',
        [templateId]
      );
      
      // Log the event
      await this.dbManager.logEvent('info', `Signal template deleted: ${template.name}`, { 
        sourceId: template.source_id 
      });
      
      return true;
    } catch (error) {
      console.error(`Failed to delete signal template ${templateId}:`, error);
      throw error;
    }
  }
  
  /**
   * Initialize all active signal sources
   * @returns {Promise<number>} Number of initialized sources
   */
  async initializeActiveSources() {
    try {
      const activeSources = await this.dbManager.executeSelect(
        'SELECT id FROM external_signal_sources WHERE is_active = 1'
      );
      
      let initializedCount = 0;
      for (const source of activeSources) {
        try {
          await this._initializeSource(source.id);
          initializedCount++;
        } catch (sourceError) {
          console.error(`Failed to initialize source ${source.id}:`, sourceError);
          await this.dbManager.logEvent('error', `Failed to initialize signal source: ${sourceError.message}`, {
            sourceId: source.id
          });
        }
      }
      
      console.log(`Initialized ${initializedCount} of ${activeSources.length} active signal sources`);
      return initializedCount;
    } catch (error) {
      console.error('Failed to initialize active sources:', error);
      throw error;
    }
  }
  
  /**
   * Initialize a single signal source
   * @private
   * @param {string} sourceId - Source ID to initialize
   * @returns {Promise<boolean>} Success status
   */
  async _initializeSource(sourceId) {
    try {
      const source = await this.getSignalSource(sourceId);
      
      // Create the appropriate adapter for this source type
      const adapter = ExternalSignalAdapter.createAdapter(
        source.source_type,
        sourceId, 
        source.config,
        this._handleRawSignal.bind(this)
      );
      
      if (!adapter) {
        throw new Error(`Could not create adapter for source type: ${source.source_type}`);
      }
      
      // Initialize the adapter
      await adapter.initialize();
      
      // Store adapter in map
      this.adapters.set(sourceId, adapter);
      
      // Log success
      await this.dbManager.logEvent('info', `Signal source initialized: ${source.name}`);
      
      return true;
    } catch (error) {
      console.error(`Failed to initialize signal source ${sourceId}:`, error);
      throw error;
    }
  }
  
  /**
   * Stop a signal source
   * @private
   * @param {string} sourceId - Source ID to stop
   * @returns {Promise<boolean>} Success status
   */
  async _stopSource(sourceId) {
    try {
      // Get the adapter
      const adapter = this.adapters.get(sourceId);
      if (adapter) {
        // Stop the adapter
        await adapter.stop();
        
        // Remove from map
        this.adapters.delete(sourceId);
      }
      
      return true;
    } catch (error) {
      console.error(`Failed to stop signal source ${sourceId}:`, error);
      throw error;
    }
  }
  
  /**
   * Handle a raw signal received from an external source
   * @private
   * @param {string} sourceId - Source ID
   * @param {string|Object} rawContent - Raw signal content
   * @returns {Promise<Object>} Processing result
   */
  async _handleRawSignal(sourceId, rawContent) {
    try {
      // Convert object to string for storage
      const content = typeof rawContent === 'object' ? JSON.stringify(rawContent) : String(rawContent);
      
      // Generate ID for raw signal
      const rawSignalId = `raw_${uuidv4()}`;
      
      // Save raw signal to database
      await this.dbManager.executeQuery(
        `INSERT INTO raw_signals 
        (id, source_id, content, received_at, processed) 
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, 0)`,
        [rawSignalId, sourceId, content]
      );
      
      // Update source stats
      await this.dbManager.executeQuery(
        `UPDATE external_signal_sources 
        SET last_signal_at = CURRENT_TIMESTAMP, 
        signal_count = signal_count + 1 
        WHERE id = ?`,
        [sourceId]
      );
      
      // Process the signal
      const result = await this._processRawSignal(rawSignalId, sourceId, content);
      
      // Update raw signal record with processing result
      await this.dbManager.executeQuery(
        `UPDATE raw_signals 
        SET processed = ?, 
        processed_at = CURRENT_TIMESTAMP, 
        processing_result = ? 
        WHERE id = ?`,
        [result.success ? 1 : 0, JSON.stringify(result), rawSignalId]
      );
      
      // Emit event
      this.emit('raw-signal-received', { 
        sourceId, 
        rawSignalId, 
        result 
      });
      
      return result;
    } catch (error) {
      console.error(`Failed to handle raw signal from ${sourceId}:`, error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Process a raw signal using appropriate templates
   * @private
   * @param {string} rawSignalId - Raw signal ID
   * @param {string} sourceId - Source ID
   * @param {string} content - Signal content
   * @returns {Promise<Object>} Processing result
   */
  async _processRawSignal(rawSignalId, sourceId, content) {
    try {
      // Get source details with templates
      const source = await this.getSignalSource(sourceId);
      
      if (!source.templates || source.templates.length === 0) {
        return { success: false, reason: 'No templates defined for this source' };
      }
      
      // Try each template until one matches
      for (const template of source.templates) {
        try {
          const parsedSignal = this._parseSignalWithTemplate(content, template);
          
          if (parsedSignal) {
            // Success! Add the signal to the trading system
            const tradingSignal = {
              symbol: parsedSignal.symbol,
              direction: parsedSignal.direction,
              price: parsedSignal.price,
              stopLoss: parsedSignal.stopLoss,
              takeProfit: parsedSignal.takeProfit,
              strategy: `external:${source.name}`,
              reliability: 70, // Default reliability for external signals
              reasoning: `Signal from external source: ${source.name}`
            };
            
            // Add signal through signal manager
            const addedSignal = await this.signalManager.addSignal(tradingSignal);
            
            return { 
              success: true, 
              templateUsed: template.id, 
              signalId: addedSignal.id,
              parsedFields: parsedSignal
            };
          }
        } catch (templateError) {
          console.log(`Template ${template.id} failed to parse signal:`, templateError.message);
          // Continue trying other templates
        }
      }
      
      // If we get here, no template matched
      return { 
        success: false, 
        reason: 'No matching template found for signal content' 
      };
    } catch (error) {
      console.error(`Failed to process raw signal ${rawSignalId}:`, error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Parse a raw signal with a template
   * @private
   * @param {string} content - Raw signal content
   * @param {Object} template - Template to use for parsing
   * @returns {Object|null} Parsed signal fields or null if no match
   */
  _parseSignalWithTemplate(content, template) {
    try {
      // Convert template pattern to regex
      const patternRegex = new RegExp(template.pattern, 'i');
      const match = patternRegex.exec(content);
      
      if (!match) {
        return null;
      }
      
      // Extract named groups if available (modern regex)
      const namedGroups = match.groups || {};
      
      // For backward compatibility, also check numbered groups
      const extractField = (fieldName) => {
        // If the template specifies a field mapping, use it
        const fieldMapping = template[fieldName];
        
        if (!fieldMapping) {
          return null;
        }
        
        // Check if the field mapping is a direct reference to a named capture group
        if (namedGroups[fieldMapping]) {
          return namedGroups[fieldMapping];
        }
        
        // Try to find the field by index (allowing things like $1, $2)
        const indexMatch = /\$(\d+)/.exec(fieldMapping);
        if (indexMatch) {
          const index = parseInt(indexMatch[1], 10);
          return match[index];
        }
        
        // If fieldMapping doesn't reference a group, it might be a static value
        return fieldMapping;
      };
      
      // Extract fields based on template mappings
      const symbol = extractField('symbolField');
      const direction = extractField('directionField');
      const price = extractField('priceField');
      const stopLoss = extractField('stopLossField');
      const takeProfit = extractField('takeProfitField');
      
      // Validate required fields
      if (!symbol || !direction) {
        return null;
      }
      
      return {
        symbol,
        direction: direction.toUpperCase(),
        price: price ? parseFloat(price) : null,
        stopLoss: stopLoss ? parseFloat(stopLoss) : null,
        takeProfit: takeProfit ? parseFloat(takeProfit) : null
      };
    } catch (error) {
      throw new Error(`Template parsing error: ${error.message}`);
    }
  }
  
  /**
   * Test a signal source configuration
   * @param {string} sourceId - Source ID to test
   * @returns {Promise<Object>} Test result
   */
  async testSignalSource(sourceId) {
    try {
      const source = await this.getSignalSource(sourceId);
      
      // Create temporary adapter for testing
      const adapter = ExternalSignalAdapter.createAdapter(
        source.source_type,
        sourceId,
        source.config,
        () => {} // Empty callback for testing
      );
      
      if (!adapter) {
        return { success: false, message: `Unsupported source type: ${source.source_type}` };
      }
      
      // Test connection
      const testResult = await adapter.test();
      
      return testResult;
    } catch (error) {
      console.error(`Failed to test signal source ${sourceId}:`, error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Get raw signals for a source
   * @param {string} sourceId - Source ID
   * @param {Object} filters - Filter options
   * @returns {Promise<Array<Object>>} Raw signals
   */
  async getRawSignals(sourceId, filters = {}) {
    try {
      let query = 'SELECT * FROM raw_signals WHERE source_id = ?';
      const queryParams = [sourceId];
      
      if (filters.processed !== undefined) {
        query += ' AND processed = ?';
        queryParams.push(filters.processed ? 1 : 0);
      }
      
      if (filters.dateFrom) {
        query += ' AND received_at >= ?';
        queryParams.push(filters.dateFrom);
      }
      
      if (filters.dateTo) {
        query += ' AND received_at <= ?';
        queryParams.push(filters.dateTo);
      }
      
      // Order by timestamp, newest first
      query += ' ORDER BY received_at DESC';
      
      // Add limit if specified
      if (filters.limit) {
        query += ' LIMIT ?';
        queryParams.push(filters.limit);
      }
      
      // Execute query
      const signals = await this.dbManager.executeSelect(query, queryParams);
      
      return signals.map(signal => {
        // Parse processing result if available
        if (signal.processing_result) {
          try {
            signal.processing_result = JSON.parse(signal.processing_result);
          } catch (e) {
            // Keep as string if parsing fails
          }
        }
        return signal;
      });
    } catch (error) {
      console.error(`Failed to get raw signals for source ${sourceId}:`, error);
      throw error;
    }
  }
}

module.exports = ExternalSignalManager;