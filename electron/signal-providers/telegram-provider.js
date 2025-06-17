// electron/signal-providers/telegram-provider.js
const { Telegraf } = require('telegraf');
const EventEmitter = require('events');

/**
 * TelegramProvider enables receiving trading signals through Telegram messages
 * Uses the Telegraf library to create a bot that listens for messages
 */
class TelegramProvider extends EventEmitter {
  /**
   * Create a new TelegramProvider
   * @param {string} sourceId - ID of the signal source 
   * @param {Object} config - Configuration for the Telegram provider
   * @param {Function} signalHandler - Callback for handling received signals
   */
  constructor(sourceId, config, signalHandler) {
    super();
    this.sourceId = sourceId;
    this.config = config || {};
    this.signalHandler = signalHandler;
    this.bot = null;
    this.status = {
      status: 'disconnected',
      lastUpdate: null,
      botUsername: null,
      signalsReceived: 0
    };

    if (!this.config.token) {
      throw new Error('Telegram bot token is required');
    }
  }

  /**
   * Initialize the Telegram bot
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      this.bot = new Telegraf(this.config.token);
      
      // Get bot info
      const botInfo = await this.bot.telegram.getMe();
      this.status.botUsername = botInfo.username;
      
      // Configure message handlers
      this._setupMessageHandlers();
      
      // Launch the bot in polling mode
      await this.bot.launch();
      
      this.status.status = 'connected';
      this.status.lastUpdate = new Date().toISOString();
      
      console.log(`Telegram bot @${this.status.botUsername} started for source ${this.sourceId}`);
      return true;
    } catch (error) {
      console.error(`Failed to initialize Telegram provider for ${this.sourceId}:`, error);
      this.status.status = 'error';
      this.status.lastUpdate = new Date().toISOString();
      throw error;
    }
  }

  /**
   * Set up message handlers for the bot
   * @private
   */
  _setupMessageHandlers() {
    // Listen for text messages
    this.bot.on('text', async (ctx) => {
      try {
        const message = ctx.message;
        
        // Only process messages from allowed users/channels if configured
        if (this.config.allowedSources && this.config.allowedSources.length > 0) {
          // Check if message is from allowed source
          const senderId = this._getSenderId(message);
          if (!this._isAllowedSource(senderId)) {
            console.log(`Ignored message from non-allowed source: ${senderId}`);
            return;
          }
        }
        
        // Process the message
        await this.signalHandler(this.sourceId, message.text);
        
        // Update status
        this.status.signalsReceived++;
        this.status.lastUpdate = new Date().toISOString();
        
        // Optionally acknowledge receipt
        if (this.config.acknowledgeReceipt) {
          await ctx.reply('Signal received and processed.');
        }
      } catch (error) {
        console.error('Error processing Telegram message:', error);
      }
    });
    
    // Handle channel posts if configured to listen to channels
    this.bot.on('channel_post', async (ctx) => {
      try {
        const post = ctx.channelPost;
        if (!post.text) return; // Only process text posts
        
        // Verify channel is allowed
        if (this.config.allowedChannels && this.config.allowedChannels.length > 0) {
          const channelId = post.chat.id;
          if (!this.config.allowedChannels.includes(String(channelId))) {
            console.log(`Ignored post from non-allowed channel: ${channelId}`);
            return;
          }
        }
        
        // Process the channel post
        await this.signalHandler(this.sourceId, post.text);
        
        // Update status
        this.status.signalsReceived++;
        this.status.lastUpdate = new Date().toISOString();
      } catch (error) {
        console.error('Error processing channel post:', error);
      }
    });
    
    // Handle errors
    this.bot.catch((err) => {
      console.error(`Telegram bot error for ${this.sourceId}:`, err);
      this.status.status = 'error';
      this.status.lastUpdate = new Date().toISOString();
      this.emit('error', err);
    });
  }
  
  /**
   * Get sender ID from a message
   * @private
   * @param {Object} message - Telegram message object
   * @returns {string} Sender ID
   */
  _getSenderId(message) {
    if (message.from) {
      return String(message.from.id);
    } else if (message.chat) {
      return String(message.chat.id);
    }
    return null;
  }
  
  /**
   * Check if a sender is allowed to send signals
   * @private
   * @param {string} senderId - Sender ID to check
   * @returns {boolean} Is allowed
   */
  _isAllowedSource(senderId) {
    if (!senderId) return false;
    if (!this.config.allowedSources || this.config.allowedSources.length === 0) {
      return true;
    }
    return this.config.allowedSources.includes(senderId);
  }

  /**
   * Stop the Telegram bot
   * @returns {Promise<void>}
   */
  async stop() {
    try {
      if (this.bot) {
        await this.bot.stop();
        this.bot = null;
        this.status.status = 'disconnected';
        this.status.lastUpdate = new Date().toISOString();
        console.log(`Telegram bot for ${this.sourceId} stopped`);
      }
    } catch (error) {
      console.error(`Error stopping Telegram bot for ${this.sourceId}:`, error);
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
   * Test the Telegram bot configuration
   * @returns {Promise<Object>} Test result
   */
  async test() {
    try {
      if (!this.config.token) {
        return { 
          success: false, 
          message: 'Telegram bot token is required' 
        };
      }
      
      // Create a temporary bot to verify the token is valid
      const tempBot = new Telegraf(this.config.token);
      
      try {
        // Get bot info to verify token is valid
        const botInfo = await tempBot.telegram.getMe();
        
        return {
          success: true,
          message: 'Telegram bot configuration is valid',
          botUsername: botInfo.username,
          botId: botInfo.id
        };
      } catch (botError) {
        if (botError.description && botError.description.includes('Unauthorized')) {
          return { 
            success: false, 
            message: 'Invalid Telegram bot token' 
          };
        } else {
          return { 
            success: false, 
            message: `Telegram API error: ${botError.message}` 
          };
        }
      } finally {
        // Close the temporary bot
        await tempBot.stop();
      }
    } catch (error) {
      console.error(`Failed to test Telegram provider for ${this.sourceId}:`, error);
      return { success: false, message: error.message };
    }
  }
}

module.exports = TelegramProvider;