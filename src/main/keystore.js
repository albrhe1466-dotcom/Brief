'use strict';
/**
 * Locally - API key storage.
 * Uses Electron safeStorage, which encrypts with the operating system's credential protection:
 *   Windows -> DPAPI (bound to your Windows user account)
 *   macOS   -> Keychain ("Locally Safe Storage" entry)
 *   Linux   -> libsecret / kwallet when available
 * The encrypted blob is written to <userData>/key.enc. The plain key only lives in memory.
 */
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

class KeyStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'key.enc');
    this.cache = null;
    this.providerCaches = {};
    this.initialized = false;
  }

  providerFile(provider) {
    const clean = String(provider || '').toLowerCase().trim();
    return path.join(this.dir, `key_${clean}.enc`);
  }

  backend() {
    if (process.platform === 'win32') return 'Windows DPAPI (via Electron safeStorage)';
    if (process.platform === 'darwin') return 'macOS Keychain (via Electron safeStorage)';
    let b = 'unknown';
    try { b = safeStorage.getSelectedStorageBackend(); } catch (_) { /* older electron */ }
    return 'Linux secret store: ' + b + ' (via Electron safeStorage)';
  }

  async available() {
    try {
      if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') {
        return await safeStorage.isAsyncEncryptionAvailable();
      }
      return safeStorage.isEncryptionAvailable();
    } catch (_) {
      return false;
    }
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    await this.getAsync();
    for (const p of ['gemini', 'openai', 'anthropic', 'openrouter']) {
      await this.getAsync(p);
    }
  }

  has(provider) {
    if (provider) {
      const p = String(provider).toLowerCase();
      if (this.providerCaches[p]) return true;
      if (fs.existsSync(this.providerFile(p))) return true;
      const k = this.get();
      if (k && this.detectProvider(k) === p) return true;
      return false;
    }
    return !!this.cache || fs.existsSync(this.file);
  }

  detectProvider(key) {
    const k = String(key || '').trim();
    if (!k) return 'gemini';
    if (/^sk-or-/i.test(k)) return 'openrouter';
    if (/^sk-ant-/i.test(k)) return 'anthropic';
    if (/^sk-/i.test(k)) return 'openai';
    return 'gemini';
  }

  get(provider) {
    if (provider) {
      const p = String(provider).toLowerCase();
      if (this.providerCaches[p]) return this.providerCaches[p];
      const pFile = this.providerFile(p);
      if (fs.existsSync(pFile)) {
        try {
          const buf = fs.readFileSync(pFile);
          if (typeof safeStorage.decryptString === 'function') {
            this.providerCaches[p] = safeStorage.decryptString(buf);
            return this.providerCaches[p];
          }
        } catch (_) {}
      }
      const active = this.get();
      if (active && this.detectProvider(active) === p) return active;
      return null;
    }
    if (this.cache) return this.cache;
    if (!fs.existsSync(this.file)) return null;
    try {
      const buf = fs.readFileSync(this.file);
      if (typeof safeStorage.decryptString === 'function') {
        this.cache = safeStorage.decryptString(buf);
        return this.cache;
      }
    } catch (e) {
      console.error('[keystore] could not decrypt key:', e.message);
    }
    return null;
  }

  async getAsync(provider) {
    if (provider) {
      const p = String(provider).toLowerCase();
      if (this.providerCaches[p]) return this.providerCaches[p];
      const pFile = this.providerFile(p);
      if (fs.existsSync(pFile)) {
        try {
          if (await this.available()) {
            const buf = fs.readFileSync(pFile);
            if (typeof safeStorage.decryptStringAsync === 'function') {
              const dec = await safeStorage.decryptStringAsync(buf);
              this.providerCaches[p] = typeof dec === 'string' ? dec : ((dec && dec.result) || null);
            } else {
              this.providerCaches[p] = safeStorage.decryptString(buf);
            }
            return this.providerCaches[p];
          }
        } catch (_) {}
      }
      const active = await this.getAsync();
      if (active && this.detectProvider(active) === p) return active;
      return null;
    }
    if (this.cache) return this.cache;
    if (!fs.existsSync(this.file)) return null;
    try {
      if (!(await this.available())) return null;
      const buf = fs.readFileSync(this.file);
      if (typeof safeStorage.decryptStringAsync === 'function') {
        const dec = await safeStorage.decryptStringAsync(buf);
        this.cache = typeof dec === 'string' ? dec : ((dec && dec.result) || null);
      } else {
        this.cache = safeStorage.decryptString(buf);
      }
      return this.cache;
    } catch (e) {
      console.error('[keystore] could not decrypt key:', e.message);
      return null;
    }
  }

  async set(key, provider) {
    const k = String(key || '').trim();
    if (!k) throw new Error('The API key is empty.');
    if (!(await this.available())) {
      throw new Error('OS encryption is not available, so the key cannot be stored securely. On Linux install gnome-keyring or kwallet.');
    }
    const enc = typeof safeStorage.encryptStringAsync === 'function'
      ? await safeStorage.encryptStringAsync(k)
      : safeStorage.encryptString(k);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, enc);
    this.cache = k;

    const prov = provider || this.detectProvider(k);
    if (prov) {
      const pFile = this.providerFile(prov);
      fs.writeFileSync(pFile, enc);
      this.providerCaches[prov] = k;
    }
  }

  remove(provider) {
    if (provider) {
      const p = String(provider).toLowerCase();
      delete this.providerCaches[p];
      const pFile = this.providerFile(p);
      try { if (fs.existsSync(pFile)) fs.unlinkSync(pFile); } catch (_) {}
      if (this.cache && this.detectProvider(this.cache) === p) {
        this.cache = null;
        try { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); } catch (_) {}
      }
      return;
    }
    this.cache = null;
    this.providerCaches = {};
    try {
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
      for (const p of ['gemini', 'openai', 'anthropic', 'openrouter']) {
        const pf = this.providerFile(p);
        if (fs.existsSync(pf)) fs.unlinkSync(pf);
      }
    } catch (e) {
      throw new Error('Could not delete the key file: ' + e.message);
    }
  }

  masked(provider) {
    const k = provider ? this.get(provider) : this.cache;
    if (!k) {
      const f = provider ? this.providerFile(provider) : this.file;
      return fs.existsSync(f) ? '••••••' : '';
    }
    if (k.length <= 10) return '•'.repeat(Math.min(6, k.length));
    return k.slice(0, 4) + '••••••' + k.slice(-4);
  }

  slots() {
    const list = ['gemini', 'openai', 'anthropic', 'openrouter'];
    const res = {};
    for (const p of list) {
      res[p] = {
        provider: p,
        has: this.has(p),
        masked: this.masked(p)
      };
    }
    return res;
  }
}

module.exports = { KeyStore };
