// electron/encryption-service.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');

/**
 * EncryptionService provides methods for securely encrypting and decrypting data
 * Supports file encryption, string encryption, and secure key derivation
 */
class EncryptionService {
  /**
   * Create a new EncryptionService instance
   * @param {string} masterKey - Master encryption key (or will generate one if not provided)
   */
  constructor(masterKey = null) {
    this.masterKey = masterKey || crypto.randomBytes(32).toString('hex');
    this.algorithm = 'aes-256-gcm'; // Using GCM mode for authentication
    this.keyIterations = 100000;    // PBKDF2 iterations
  }

  /**
   * Derive a secure key from a password
   * @param {string} password - User password
   * @param {Buffer|string} salt - Salt for key derivation (generates random if not provided)
   * @returns {Object} Object containing derived key and salt used
   */
  deriveKey(password, salt = null) {
    const useSalt = salt || crypto.randomBytes(16);
    const derivedKey = crypto.pbkdf2Sync(
      password, 
      useSalt, 
      this.keyIterations, 
      32, 
      'sha256'
    );
    
    return {
      key: derivedKey,
      salt: useSalt
    };
  }

  /**
   * Encrypt a string or buffer
   * @param {string|Buffer} data - Data to encrypt
   * @param {Buffer|string} [key=this.masterKey] - Encryption key to use
   * @returns {string} Encrypted data in format: iv:authTag:encryptedData
   */
  encrypt(data, key = this.masterKey) {
    try {
      // Ensure consistent key format
      const useKey = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
      
      // Generate initialization vector
      const iv = crypto.randomBytes(16);
      
      // Create cipher
      const cipher = crypto.createCipheriv(this.algorithm, useKey, iv);
      
      // Encrypt data
      const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      let encrypted = Buffer.concat([
        cipher.update(dataBuffer),
        cipher.final()
      ]);
      
      // Get authentication tag
      const authTag = cipher.getAuthTag();
      
      // Return everything combined into one string: iv:authTag:encryptedData
      return Buffer.concat([
        iv,
        authTag,
        encrypted
      ]).toString('base64');
    } catch (error) {
      console.error('Encryption failed:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypt a previously encrypted string
   * @param {string} encryptedData - Data to decrypt in format: iv:authTag:encryptedData
   * @param {Buffer|string} [key=this.masterKey] - Decryption key to use
   * @returns {Buffer} Decrypted data as a buffer
   */
  decrypt(encryptedData, key = this.masterKey) {
    try {
      // Ensure consistent key format
      const useKey = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
      
      // Decode from base64
      const buffer = Buffer.from(encryptedData, 'base64');
      
      // Extract components
      const iv = buffer.slice(0, 16);
      const authTag = buffer.slice(16, 32);
      const encrypted = buffer.slice(32);
      
      // Create decipher
      const decipher = crypto.createDecipheriv(this.algorithm, useKey, iv);
      decipher.setAuthTag(authTag);
      
      // Decrypt
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]);
      
      return decrypted;
    } catch (error) {
      console.error('Decryption failed:', error);
      throw new Error('Failed to decrypt data - invalid key or corrupted data');
    }
  }

  /**
   * Encrypt a file
   * @param {string} sourcePath - Path to the file to encrypt
   * @param {string} destPath - Path to save the encrypted file
   * @param {Buffer|string} [key=this.masterKey] - Encryption key to use
   * @returns {Promise<boolean>} True if successful
   */
  async encryptFile(sourcePath, destPath, key = this.masterKey) {
    try {
      // Ensure consistent key format
      const useKey = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
      
      // Generate initialization vector
      const iv = crypto.randomBytes(16);
      
      // Create cipher
      const cipher = crypto.createCipheriv(this.algorithm, useKey, iv);
      
      // Create read and write streams
      const readStream = fs.createReadStream(sourcePath);
      const writeStream = fs.createWriteStream(destPath);
      
      // Write IV and reserved space for auth tag at beginning of file
      writeStream.write(iv);
      const authTagPlaceholder = Buffer.alloc(16);
      writeStream.write(authTagPlaceholder);
      
      // Process the file
      return new Promise((resolve, reject) => {
        readStream.pipe(cipher).pipe(writeStream)
          .on('finish', async () => {
            try {
              // Get and write the auth tag at the reserved position
              const authTag = cipher.getAuthTag();
              
              // Update the file with the auth tag
              const fd = await promisify(fs.open)(destPath, 'r+');
              await promisify(fs.write)(fd, authTag, 0, authTag.length, 16);
              await promisify(fs.close)(fd);
              
              resolve(true);
            } catch (err) {
              reject(err);
            }
          })
          .on('error', reject);
      });
    } catch (error) {
      console.error('File encryption failed:', error);
      throw error;
    }
  }

  /**
   * Decrypt a previously encrypted file
   * @param {string} sourcePath - Path to the encrypted file
   * @param {string} destPath - Path to save the decrypted file
   * @param {Buffer|string} [key=this.masterKey] - Decryption key to use
   * @returns {Promise<boolean>} True if successful
   */
  async decryptFile(sourcePath, destPath, key = this.masterKey) {
    try {
      // Ensure consistent key format
      const useKey = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
      
      // Read the first 32 bytes to get the IV and auth tag
      const headerBuffer = Buffer.alloc(32);
      const fd = await promisify(fs.open)(sourcePath, 'r');
      await promisify(fs.read)(fd, headerBuffer, 0, 32, 0);
      await promisify(fs.close)(fd);
      
      // Extract IV and auth tag
      const iv = headerBuffer.slice(0, 16);
      const authTag = headerBuffer.slice(16, 32);
      
      // Create decipher
      const decipher = crypto.createDecipheriv(this.algorithm, useKey, iv);
      decipher.setAuthTag(authTag);
      
      // Create read and write streams
      const readStream = fs.createReadStream(sourcePath, { start: 32 });
      const writeStream = fs.createWriteStream(destPath);
      
      // Process the file
      return new Promise((resolve, reject) => {
        readStream.pipe(decipher).pipe(writeStream)
          .on('finish', () => resolve(true))
          .on('error', reject);
      });
    } catch (error) {
      console.error('File decryption failed:', error);
      throw error;
    }
  }

  /**
   * Create a hash of data (e.g., for password verification)
   * @param {string} data - Data to hash
   * @param {string} [salt] - Optional salt
   * @returns {Object} Object containing hash and salt used
   */
  createHash(data, salt = null) {
    const useSalt = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(data, useSalt, 10000, 64, 'sha512').toString('hex');
    return {
      hash,
      salt: useSalt
    };
  }

  /**
   * Verify a hash against provided data
   * @param {string} data - Data to verify
   * @param {string} hash - Hash to verify against
   * @param {string} salt - Salt used when creating the hash
   * @returns {boolean} True if the hash matches
   */
  verifyHash(data, hash, salt) {
    const checkHash = crypto.pbkdf2Sync(data, salt, 10000, 64, 'sha512').toString('hex');
    return checkHash === hash;
  }

  /**
   * Generate a secure random token
   * @param {number} [length=32] - Length of token in bytes
   * @returns {string} Random token as hex string
   */
  generateToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Generate a secure random password
   * @param {number} [length=16] - Length of password
   * @param {boolean} [includeSpecialChars=true] - Whether to include special characters
   * @returns {string} Generated password
   */
  generatePassword(length = 16, includeSpecialChars = true) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const specialChars = '!@#$%^&*()_+-=[]{}|;:,.<>?';
    const fullCharset = includeSpecialChars ? charset + specialChars : charset;
    
    let password = '';
    const randomValues = crypto.randomBytes(length);
    
    for (let i = 0; i < length; i++) {
      const randomIndex = randomValues[i] % fullCharset.length;
      password += fullCharset.charAt(randomIndex);
    }
    
    return password;
  }
}

module.exports = EncryptionService;