// electron/signal-providers/email-provider.js
const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;
const EventEmitter = require('events');

/**
 * EmailProvider enables receiving trading signals through email messages
 * Uses ImapFlow to connect to an email server and monitor for new messages
 */
class EmailProvider extends EventEmitter {
  /**
   * Create a new EmailProvider
   * @param {string} sourceId - ID of the signal source 
   * @param {Object} config - Configuration for the email provider
   * @param {Function} signalHandler - Callback for handling received signals
   */
  constructor(sourceId, config, signalHandler) {
    super();
    this.sourceId = sourceId;
    this.config = config || {};
    this.signalHandler = signalHandler;
    this.client = null;
    this.poller = null;
    this.status = {
      status: 'disconnected',
      lastUpdate: null,
      emailAddress: this.config.auth?.user || 'not configured',
      signalsReceived: 0
    };

    // Set defaults
    this.config.pollInterval = this.config.pollInterval || 60; // seconds
    this.config.mailbox = this.config.mailbox || 'INBOX';
    this.config.searchCriteria = this.config.searchCriteria || { seen: false };
  }

  /**
   * Initialize the email provider
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      if (!this.config.host || !this.config.auth?.user || !this.config.auth?.pass) {
        throw new Error('Email configuration is incomplete');
      }

      // Create IMAP client
      this.client = new ImapFlow({
        host: this.config.host,
        port: this.config.port || 993,
        secure: this.config.secure !== false,
        auth: {
          user: this.config.auth.user,
          pass: this.config.auth.pass
        },
        logger: false
      });

      // Connect to server
      await this.client.connect();
      
      // Update status
      this.status.status = 'connected';
      this.status.lastUpdate = new Date().toISOString();
      this.status.emailAddress = this.config.auth.user;
      
      console.log(`Email provider connected for ${this.sourceId} (${this.config.auth.user})`);
      
      // Start polling for new emails
      this._startPolling();
      
      return true;
    } catch (error) {
      console.error(`Failed to initialize email provider for ${this.sourceId}:`, error);
      this.status.status = 'error';
      this.status.lastUpdate = new Date().toISOString();
      throw error;
    }
  }

  /**
   * Start polling for new emails
   * @private
   */
  _startPolling() {
    if (this.poller) {
      clearInterval(this.poller);
    }
    
    // Initial check for new messages
    this._checkNewEmails();
    
    // Set up recurring checks
    this.poller = setInterval(() => {
      this._checkNewEmails();
    }, this.config.pollInterval * 1000);
  }

  /**
   * Check for new emails
   * @private
   */
  async _checkNewEmails() {
    try {
      if (!this.client || !this.client.authenticated) {
        console.log('Email client not authenticated, reconnecting...');
        await this.client.connect();
      }
      
      // Select mailbox
      const lock = await this.client.getMailboxLock(this.config.mailbox);
      
      try {
        // Search for messages
        const searchOptions = this.config.searchCriteria || {};
        
        // Add a time-based criteria to only get recent messages
        // Only check emails from the last hour unless a specific time window is set
        if (!searchOptions.since) {
          const oneHourAgo = new Date();
          oneHourAgo.setHours(oneHourAgo.getHours() - 1);
          searchOptions.since = oneHourAgo;
        }
        
        // Execute search
        for await (const message of this.client.fetch(searchOptions, { uid: true, envelope: true, source: true })) {
          try {
            // Parse email
            const parsed = await simpleParser(message.source);
            
            // Check sender filter if configured
            if (this.config.allowedSenders && this.config.allowedSenders.length > 0) {
              const sender = parsed.from?.value?.[0]?.address?.toLowerCase();
              if (!sender || !this.config.allowedSenders.includes(sender)) {
                console.log(`Ignoring email from non-allowed sender: ${sender}`);
                continue;
              }
            }
            
            // Check subject filter if configured
            if (this.config.subjectFilter) {
              const filterRegex = new RegExp(this.config.subjectFilter, 'i');
              if (!filterRegex.test(parsed.subject)) {
                console.log(`Ignoring email with non-matching subject: ${parsed.subject}`);
                continue;
              }
            }
            
            // Process email content - prefer text over HTML
            const content = parsed.text || parsed.html || '';
            
            // Pass to signal handler
            await this.signalHandler(this.sourceId, {
              subject: parsed.subject,
              body: content,
              from: parsed.from?.text,
              date: parsed.date
            });
            
            // Mark as seen
            if (this.config.markSeen) {
              await this.client.messageFlagsAdd(
                { uid: message.uid },
                ['\\Seen']
              );
            }
            
            // Update status
            this.status.signalsReceived++;
            this.status.lastUpdate = new Date().toISOString();
          } catch (messageError) {
            console.error(`Error processing email message:`, messageError);
          }
        }
      } finally {
        // Release the lock when done
        lock.release();
      }
    } catch (error) {
      console.error(`Error checking emails for ${this.sourceId}:`, error);
      this.status.status = 'error';
      this.status.lastUpdate = new Date().toISOString();
      this.emit('error', error);
    }
  }

  /**
   * Stop the email provider
   * @returns {Promise<void>}
   */
  async stop() {
    try {
      // Stop polling
      if (this.poller) {
        clearInterval(this.poller);
        this.poller = null;
      }
      
      // Close client connection
      if (this.client) {
        await this.client.logout();
        this.client = null;
        this.status.status = 'disconnected';
        this.status.lastUpdate = new Date().toISOString();
        console.log(`Email provider for ${this.sourceId} stopped`);
      }
    } catch (error) {
      console.error(`Error stopping email provider for ${this.sourceId}:`, error);
      throw error;
    }
  }

  /**
   * Get the current status of the provider
   * @returns {Object} Status information
   */
  getStatus() {
    return { ...this.status };
  }
  
  /**
   * Test the email configuration
   * @returns {Promise<Object>} Test result
   */
  async test() {
    try {
      if (!this.config.host || !this.config.auth?.user || !this.config.auth?.pass) {
        return { 
          success: false, 
          message: 'Email configuration is incomplete' 
        };
      }
      
      // Create temporary client for testing
      const testClient = new ImapFlow({
        host: this.config.host,
        port: this.config.port || 993,
        secure: this.config.secure !== false,
        auth: {
          user: this.config.auth.user,
          pass: this.config.auth.pass
        },
        logger: false
      });
      
      try {
        // Connect and verify credentials
        await testClient.connect();
        
        // Test accessing the mailbox
        const mailboxes = await testClient.list();
        const targetMailbox = mailboxes.find(m => m.name === this.config.mailbox);
        
        if (!targetMailbox) {
          await testClient.logout();
          return {
            success: false,
            message: `Mailbox "${this.config.mailbox}" not found`
          };
        }
        
        // Successful connection and mailbox exists
        await testClient.logout();
        
        return {
          success: true,
          message: 'Email configuration is valid',
          mailbox: this.config.mailbox,
          emailAddress: this.config.auth.user
        };
      } catch (clientError) {
        if (testClient.authenticated) {
          await testClient.logout();
        }
        
        if (clientError.message.includes('Invalid credentials')) {
          return {
            success: false,
            message: 'Invalid email credentials'
          };
        } else {
          return {
            success: false,
            message: `Email connection error: ${clientError.message}`
          };
        }
      }
    } catch (error) {
      console.error(`Failed to test email provider for ${this.sourceId}:`, error);
      return { success: false, message: error.message };
    }
  }
}

module.exports = EmailProvider;