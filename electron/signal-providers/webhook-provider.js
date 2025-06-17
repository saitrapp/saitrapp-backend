// electron/signal-providers/webhook-provider.js
const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');
const EventEmitter = require('events');

/**
 * WebhookProvider enables receiving trading signals through HTTP webhooks
 * Provides a local HTTP server that receives and processes webhook payloads
 */
class WebhookProvider extends EventEmitter {
  /**
   * Create a new WebhookProvider
   * @param {string} sourceId - ID of the signal source 
   * @param {Object} config - Configuration for the webhook provider
   * @param {Function} signalHandler - Callback for handling received signals
   */
  constructor(sourceId, config, signalHandler) {
    super();
    this.sourceId = sourceId;
    this.config = config || {};
    this.signalHandler = signalHandler;
    this.server = null;
    this.status = {
      status: 'disconnected',
      lastUpdate: null,
      endpoint: null,
      signalsReceived: 0
    };

    // Set defaults
    this.config.port = this.config.port || 0; // 0 = random available port
    this.config.path = this.config.path || `/hook/${sourceId}`;
    this.config.secret = this.config.secret || crypto.randomBytes(16).toString('hex');
  }

  /**
   * Initialize the webhook provider
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      await this._startServer();
      this.status.status = 'listening';
      this.status.lastUpdate = new Date().toISOString();
      return true;
    } catch (error) {
      console.error(`Failed to initialize webhook provider for ${this.sourceId}:`, error);
      throw error;
    }
  }

  /**
   * Start the HTTP server for webhooks
   * @private
   * @returns {Promise<void>}
   */
  _startServer() {
    return new Promise((resolve, reject) => {
      try {
        this.server = http.createServer(this._handleRequest.bind(this));
        
        this.server.on('error', (err) => {
          console.error(`Webhook server error for ${this.sourceId}:`, err);
          this.status.status = 'error';
          this.status.lastUpdate = new Date().toISOString();
          this.emit('error', err);
        });

        // Start server on the configured port or random available port
        this.server.listen(this.config.port, () => {
          const address = this.server.address();
          this.config.port = address.port; // Update with actual port if it was random
          
          this.status.endpoint = `http://localhost:${this.config.port}${this.config.path}`;
          console.log(`Webhook server for ${this.sourceId} listening at ${this.status.endpoint}`);
          
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle HTTP requests to the webhook endpoint
   * @private
   * @param {http.IncomingMessage} req - HTTP request
   * @param {http.ServerResponse} res - HTTP response
   */
  _handleRequest(req, res) {
    const parsedUrl = url.parse(req.url);
    
    // Check if the request is for our webhook path
    if (parsedUrl.pathname !== this.config.path) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    // Handle OPTIONS preflight requests
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Signature');
      res.statusCode = 204;
      res.end();
      return;
    }
    
    // Only allow POST requests
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        // Verify signature if configured
        if (this.config.verifySignature && this.config.secret) {
          const signature = req.headers['x-webhook-signature'];
          
          if (!signature) {
            res.statusCode = 401;
            res.end('Unauthorized: Missing signature');
            return;
          }
          
          const hmac = crypto.createHmac('sha256', this.config.secret);
          hmac.update(body);
          const calculatedSignature = hmac.digest('hex');
          
          if (signature !== calculatedSignature) {
            res.statusCode = 401;
            res.end('Unauthorized: Invalid signature');
            return;
          }
        }

        // Parse the body based on content type
        let parsedBody;
        const contentType = req.headers['content-type'] || '';
        
        if (contentType.includes('application/json')) {
          parsedBody = JSON.parse(body);
        } else {
          // Treat as plain text for non-JSON content types
          parsedBody = body;
        }

        // Process the webhook payload
        await this.signalHandler(this.sourceId, parsedBody);
        
        // Update status
        this.status.signalsReceived++;
        this.status.lastUpdate = new Date().toISOString();
        
        // Send success response
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        console.error('Error processing webhook:', error);
        
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ 
          success: false, 
          error: error.message
        }));
      }
    });
  }

  /**
   * Stop the webhook provider
   * @returns {Promise<void>}
   */
  async stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      
      this.server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        
        this.status.status = 'disconnected';
        this.status.lastUpdate = new Date().toISOString();
        this.server = null;
        console.log(`Webhook server for ${this.sourceId} stopped`);
        resolve();
      });
    });
  }

  /**
   * Get the current status of the webhook provider
   * @returns {Object} Status information
   */
  getStatus() {
    return { ...this.status };
  }
  
  /**
   * Test the webhook configuration
   * @returns {Promise<Object>} Test result
   */
  async test() {
    try {
      // Creating a temporary server is the best way to test if we can bind to the port
      const tempServer = http.createServer();
      
      const testResult = await new Promise((resolve, reject) => {
        tempServer.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            resolve({ 
              success: false, 
              message: `Port ${this.config.port || 'auto'} is already in use`
            });
          } else {
            resolve({ 
              success: false, 
              message: `Server error: ${err.message}`
            });
          }
        });
        
        tempServer.listen(this.config.port, () => {
          const address = tempServer.address();
          tempServer.close(() => {
            resolve({ 
              success: true, 
              message: 'Webhook configuration is valid',
              endpoint: `http://localhost:${address.port}${this.config.path}`,
              note: 'External systems must be able to access this endpoint'
            });
          });
        });
      });
      
      return testResult;
    } catch (error) {
      console.error(`Failed to test webhook provider for ${this.sourceId}:`, error);
      return { success: false, message: error.message };
    }
  }
}

module.exports = WebhookProvider;