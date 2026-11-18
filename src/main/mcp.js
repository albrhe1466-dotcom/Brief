'use strict';
/**
 * Locally — Real Local MCP (Model Context Protocol) Client & Bridge.
 * Zero simulated presets: ONLY servers that actually connect over JSON-RPC 2.0
 * (stdio or localhost HTTP/SSE) appear as connected with their real server name & logo.
 */
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_SIGNATURES = [
  { key: 'roblox', match: /roblox/i, label: 'Roblox Studio', processes: ['RobloxStudioBeta', 'RobloxStudio'] },
  { key: 'blender', match: /blender/i, label: 'Blender', processes: ['blender'] },
  { key: 'unity', match: /unity/i, label: 'Unity Editor', processes: ['Unity', 'Unity Hub'] },
  { key: 'vscode', match: /\b(vs\s*code|vscode|visual studio code|code)\b/i, label: 'Visual Studio Code', processes: ['Code', 'Code - Insiders'] },
  { key: 'figma', match: /figma/i, label: 'Figma', processes: ['Figma'] },
  { key: 'github', match: /github/i, label: 'GitHub', processes: [] }
];

function inferAppIconAndLabel(name, command, url, serverInfo) {
  const si = serverInfo && typeof serverInfo === 'object' ? serverInfo : {};
  const combined = [si.name, si.title, name, command, url].filter(Boolean).join(' ');
  for (const sig of APP_SIGNATURES) {
    if (sig.match.test(combined)) {
      return {
        icon: sig.key,
        name: String(name || si.title || si.name || sig.label).trim()
      };
    }
  }
  return {
    icon: 'mcp',
    name: String(name || si.title || si.name || 'Local MCP Server').trim()
  };
}

function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: { input: { type: 'string' } } };
  const out = {};
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') || 'string';
  if (type && ['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(String(type).toLowerCase())) {
    out.type = String(type).toLowerCase();
  }
  if (typeof schema.description === 'string' && schema.description.trim()) {
    out.description = schema.description.slice(0, 500);
  }
  if (Array.isArray(schema.enum) && schema.enum.length) {
    out.enum = schema.enum.map((v) => String(v));
  }
  if (schema.items && typeof schema.items === 'object') {
    out.items = sanitizeSchemaForGemini(schema.items);
  }
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = sanitizeSchemaForGemini(v);
    }
    if (!out.type) out.type = 'object';
    if (Object.keys(out.properties).length === 0) {
      out.properties = { note: { type: 'string', description: 'Optional note' } };
    }
  } else if (out.type === 'object') {
    out.properties = { input: { type: 'string', description: 'Optional JSON input' } };
  }
  if (Array.isArray(schema.required) && out.properties) {
    const validReq = schema.required.filter((r) => typeof r === 'string' && out.properties[r]);
    if (validReq.length) out.required = validReq;
  }
  if (!out.type) out.type = out.properties ? 'object' : 'string';
  return out;
}

class McpServerConnection {
  constructor(cfg) {
    this.cfg = Object.assign({
      id: '',
      name: '',
      icon: 'mcp',
      iconUrl: '',
      transport: 'http',
      url: '',
      command: '',
      args: [],
      enabled: false,
      userAdded: true
    }, cfg);
    this.status = 'disconnected';
    this.error = '';
    this.tools = [];
    this.serverInfo = null;
    this.proc = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.sessionId = '';
    this.connectedAt = null;
  }

  async connect() {
    this.disconnect();
    this.status = 'connecting';
    this.error = '';
    try {
      let initRes;
      if (this.cfg.transport === 'stdio') {
        initRes = await this.connectStdio();
      } else {
        initRes = await this.connectHttp();
      }
      this.serverInfo = (initRes && initRes.serverInfo) ? initRes.serverInfo : null;
      const listed = await this.rpc('tools/list', {}, 15000);
      this.tools = Array.isArray(listed && listed.tools) ? listed.tools : [];
      const inferred = inferAppIconAndLabel(
        this.cfg.name,
        this.cfg.command + ' ' + (this.cfg.args || []).join(' '),
        this.cfg.url,
        this.serverInfo
      );
      this.cfg.icon = inferred.icon;
      if (!this.cfg.name || this.cfg.name === this.cfg.id) {
        this.cfg.name = inferred.name;
      }
      if (this.serverInfo && typeof this.serverInfo.icon === 'string' && /^(https?:|data:image\/)/i.test(this.serverInfo.icon)) {
        this.cfg.iconUrl = this.serverInfo.icon;
      }
      this.status = 'connected';
      this.error = '';
      this.connectedAt = new Date().toISOString();
      return this.summary();
    } catch (e) {
      this.disconnect();
      this.status = 'error';
      this.error = e.message || String(e);
      throw e;
    }
  }

  async connectStdio() {
    const cmd = String(this.cfg.command || '').trim();
    if (!cmd) throw new Error('Command is required for stdio MCP server.');
    const args = Array.isArray(this.cfg.args) ? this.cfg.args : String(this.cfg.args || '').split(/\s+/).filter(Boolean);
    this.proc = spawn(cmd, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.buf = '';
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk.toString('utf8');
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result || {});
        }
      }
    });
    let stderrTail = '';
    this.proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-400); });
    this.proc.on('exit', (code) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('MCP server exited (code ' + code + ')' + (stderrTail ? ': ' + stderrTail.trim() : '')));
      }
      this.pending.clear();
      if (this.status === 'connected') {
        this.status = 'disconnected';
        this.tools = [];
      }
    });
    this.proc.on('error', (err) => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    });

    const initRes = await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'LOCALLY', version: '1.0.5' }
    }, 15000);
    this.notify('notifications/initialized', {});
    return initRes;
  }

  async connectHttp() {
    const url = String(this.cfg.url || '').trim();
    if (!url) throw new Error('Local server URL is required (e.g. http://127.0.0.1:3002/mcp).');
    const initRes = await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'LOCALLY', version: '1.0.5' }
    }, 10000);
    await this.notifyHttp('notifications/initialized', {}).catch(() => {});
    return initRes;
  }

  notify(method, params) {
    if (this.cfg.transport === 'stdio' && this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }
  }

  async notifyHttp(method, params) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    await fetch(this.cfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(5000)
    });
  }

  async rpc(method, params, timeoutMs = 20000) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params: params || {} };
    if (this.cfg.transport === 'stdio') {
      if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
        throw new Error('MCP stdio process is not running.');
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('MCP call "' + method + '" timed out.'));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        this.proc.stdin.write(JSON.stringify(payload) + '\n');
      });
    }

    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let res;
    try {
      res = await fetch(this.cfg.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      throw new Error('Could not reach MCP server at ' + this.cfg.url + ': ' + (e.message || e));
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const rawText = await res.text();
    if (!res.ok) throw new Error('MCP HTTP ' + res.status + ': ' + rawText.slice(0, 220));
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    let msg = null;
    if (ct.includes('text/event-stream') || rawText.startsWith('data:')) {
      for (const line of rawText.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try {
          const obj = JSON.parse(line.slice(5).trim());
          if (obj && (obj.id === id || obj.result !== undefined || obj.error)) msg = obj;
        } catch (_) { /* ignore */ }
      }
    } else {
      msg = JSON.parse(rawText);
    }
    if (!msg) throw new Error('Invalid JSON-RPC reply from MCP server.');
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result || {};
  }

  async callTool(name, args) {
    if (this.status !== 'connected') {
      await this.connect();
    }
    return await this.rpc('tools/call', { name, arguments: args || {} }, 45000);
  }

  disconnect() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('MCP disconnected.'));
    }
    this.pending.clear();
    if (this.proc) {
      try { this.proc.stdin.end(); this.proc.kill(); } catch (_) { /* ignore */ }
      this.proc = null;
    }
    this.sessionId = '';
    this.status = 'disconnected';
    this.tools = [];
  }

  summary(appRunning = false) {
    return {
      id: this.cfg.id,
      name: (this.serverInfo && (this.serverInfo.title || this.serverInfo.name)) || this.cfg.name,
      icon: this.cfg.icon || 'mcp',
      iconUrl: this.cfg.iconUrl || '',
      serverInfo: this.serverInfo,
      transport: this.cfg.transport,
      url: this.cfg.url || '',
      command: this.cfg.command || '',
      args: Array.isArray(this.cfg.args) ? this.cfg.args : [],
      enabled: !!this.cfg.enabled,
      status: this.status,
      error: this.error,
      appRunning: !!appRunning,
      connectedAt: this.connectedAt,
      toolsCount: this.tools.length,
      tools: this.tools.map((t) => ({ name: t.name, description: t.description || '' }))
    };
  }
}

class McpManager extends EventEmitter {
  constructor(getSettings, saveSettings) {
    super();
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.connections = new Map();
    this.runningProcs = new Set();
    this.bridgeServer = null;
    this.bridgePort = 0;
    this.loadFromSettings();
  }

  loadFromSettings() {
    const saved = Array.isArray(this.getSettings().mcpServers) ? this.getSettings().mcpServers : [];
    const legacyPresetIds = new Set(['roblox-studio', 'blender', 'unity', 'vscode']);
    const kept = [];
    let pruned = false;
    for (const s of saved) {
      if (!s || !s.id) continue;
      // Drop un-paired disconnected placeholders left from earlier versions so Settings starts cleanly empty.
      if (legacyPresetIds.has(s.id) && !s.enabled && !s.userAdded) {
        pruned = true;
        continue;
      }
      kept.push(s);
      if (!this.connections.has(s.id)) {
        this.connections.set(s.id, new McpServerConnection(s));
      } else {
        this.connections.get(s.id).cfg = s;
      }
    }
    if (pruned) {
      this.saveSettings({ mcpServers: kept });
    }
  }

  persistConfigs() {
    const list = [];
    for (const conn of this.connections.values()) {
      list.push(Object.assign({}, conn.cfg));
    }
    this.saveSettings({ mcpServers: list });
  }

  getBridgeInfo() {
    return {
      running: !!this.bridgeServer,
      port: this.bridgePort,
      url: this.bridgePort ? ('http://127.0.0.1:' + this.bridgePort) : ''
    };
  }

  async startBridge(preferredPort = 3847) {
    if (this.bridgeServer) return this.getBridgeInfo();
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const u = (req.url || '/').split('?')[0];
      if (req.method === 'GET' && u === '/health') {
        const connected = this.list().filter((x) => x.status === 'connected');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, app: 'LOCALLY', port: this.bridgePort, connectedCount: connected.length }));
        return;
      }
      if (req.method === 'GET' && u === '/mcp/servers') {
        res.writeHead(200);
        res.end(JSON.stringify({ servers: this.list() }));
        return;
      }
      if (req.method === 'POST' && (u === '/mcp/connect' || u === '/mcp/disconnect')) {
        let body = '';
        req.on('data', (d) => {
          body += d;
          if (body.length > 512 * 1024) req.destroy();
        });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            if (u === '/mcp/disconnect') {
              const list = this.removeServer(String(data.id || ''));
              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, servers: list }));
              return;
            }
            const inferred = inferAppIconAndLabel(data.name, data.command, data.url, data.serverInfo);
            const id = String(data.id || inferred.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-|-$/g, '') || ('mcp-' + Date.now());
            const cfg = {
              id,
              name: inferred.name,
              icon: inferred.icon,
              iconUrl: data.iconUrl || '',
              transport: data.transport || (data.url ? 'http' : 'stdio'),
              url: data.url || '',
              command: data.command || '',
              args: Array.isArray(data.args) ? data.args : [],
              enabled: true,
              userAdded: true
            };
            const list = await this.connectServer(id, cfg);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, id, servers: list }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
          }
        });
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    await new Promise((resolve) => {
      server.once('error', () => {
        server.listen(0, '127.0.0.1', resolve);
      });
      server.listen(preferredPort, '127.0.0.1', resolve);
    });
    const addr = server.address();
    this.bridgeServer = server;
    this.bridgePort = (addr && typeof addr === 'object') ? addr.port : 0;
    return this.getBridgeInfo();
  }

  async detectRunningApps() {
    const found = new Set();
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          'Get-Process | Select-Object -ExpandProperty ProcessName -Unique'],
        { windowsHide: true, timeout: 6000 }, (err, stdout) => {
          if (!err && stdout) {
            for (const line of String(stdout).split(/\r?\n/)) {
              const s = line.trim().toLowerCase();
              if (s) found.add(s);
            }
          }
          resolve();
        });
      });
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      await new Promise((resolve) => {
        execFile('ps', ['-eo', 'comm='], { timeout: 5000 }, (err, stdout) => {
          if (!err && stdout) {
            for (const line of String(stdout).split(/\r?\n/)) {
              const s = line.trim().toLowerCase();
              if (s) found.add(s);
            }
          }
          resolve();
        });
      });
    }
    this.runningProcs = found;
    this.emit('updated', this.list());
    return this.list();
  }

  isServerAppRunning(conn) {
    const icon = (conn && conn.cfg && conn.cfg.icon) || '';
    const sig = APP_SIGNATURES.find((s) => s.key === icon);
    if (!sig || !sig.processes.length) return false;
    return sig.processes.some((pname) => {
      const target = pname.toLowerCase();
      for (const running of this.runningProcs) {
        if (running === target || running.includes(target)) return true;
      }
      return false;
    });
  }

  list() {
    this.loadFromSettings();
    const out = [];
    for (const conn of this.connections.values()) {
      out.push(conn.summary(this.isServerAppRunning(conn)));
    }
    return out;
  }

  saveServer(cfg) {
    const inferred = inferAppIconAndLabel(cfg.name, cfg.command, cfg.url, null);
    const cleanId = String(cfg.id || ('mcp-' + Date.now())).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const nextCfg = {
      id: cleanId,
      name: inferred.name,
      icon: cfg.icon || inferred.icon,
      iconUrl: String(cfg.iconUrl || '').trim(),
      transport: cfg.transport === 'stdio' ? 'stdio' : 'http',
      url: String(cfg.url || '').trim(),
      command: String(cfg.command || '').trim(),
      args: Array.isArray(cfg.args) ? cfg.args : String(cfg.args || '').split(/\s+/).filter(Boolean),
      enabled: cfg.enabled !== false,
      userAdded: true
    };
    const existing = this.connections.get(cleanId);
    if (existing) {
      existing.cfg = nextCfg;
    } else {
      this.connections.set(cleanId, new McpServerConnection(nextCfg));
    }
    this.persistConfigs();
    this.emit('updated', this.list());
    return this.list();
  }

  async connectServer(id, overrideCfg) {
    let targetId = id;
    if (overrideCfg) {
      const cleanId = String(id || overrideCfg.id || ('mcp-' + Date.now())).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      targetId = cleanId;
      this.saveServer(Object.assign({}, overrideCfg, { id: cleanId }));
    }
    const conn = this.connections.get(targetId);
    if (!conn) throw new Error('Unknown MCP server: ' + targetId);
    conn.cfg.enabled = true;
    try {
      await conn.connect();
      this.persistConfigs();
      return this.list();
    } catch (e) {
      // Do NOT keep failed one-off connection attempts cluttering the connected list unless previously connected.
      if (!conn.connectedAt) {
        this.connections.delete(targetId);
        this.persistConfigs();
      } else {
        conn.cfg.enabled = false;
        this.persistConfigs();
      }
      throw e;
    } finally {
      this.emit('updated', this.list());
    }
  }

  /**
   * Reads real local MCP config files & active localhost endpoints; ONLY adds servers
   * whose live JSON-RPC initialize + tools/list handshake genuinely succeeds right now.
   */
  async scanAndConnectLive() {
    await this.detectRunningApps();
    const candidates = [];
    const seenKeys = new Set();
    const pushCand = (item) => {
      const k = (item.url || (item.command + ' ' + (item.args || []).join(' '))).trim();
      if (!k || seenKeys.has(k)) return;
      seenKeys.add(k);
      candidates.push(item);
    };

    const cfgPaths = process.platform === 'win32'
      ? [
        path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
        path.join(os.homedir(), '.gemini', 'settings.json'),
        path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json'),
        path.join(os.homedir(), '.cursor', 'mcp.json'),
        path.join(process.env.APPDATA || '', 'Code', 'User', 'mcp.json')
      ]
      : [
        path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
        path.join(os.homedir(), '.gemini', 'settings.json'),
        path.join(os.homedir(), '.cursor', 'mcp.json'),
        path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
        path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json')
      ];

    for (const p of cfgPaths) {
      try {
        if (!p || !fs.existsSync(p)) continue;
        const json = JSON.parse(fs.readFileSync(p, 'utf8'));
        const map = json.mcpServers || json.servers || {};
        for (const [key, val] of Object.entries(map)) {
          if (!val || val.disabled) continue;
          if (val.url) {
            pushCand({ id: key, name: key, transport: 'http', url: val.url });
          } else if (val.command) {
            pushCand({ id: key, name: key, transport: 'stdio', command: val.command, args: Array.isArray(val.args) ? val.args : [] });
          }
        }
      } catch (_) { /* ignore malformed user config */ }
    }

    const newlyConnected = [];
    for (const cand of candidates) {
      const existing = Array.from(this.connections.values()).find((c) => c.status === 'connected' && (
        (cand.url && c.cfg.url === cand.url) ||
        (cand.command && c.cfg.command === cand.command && JSON.stringify(c.cfg.args) === JSON.stringify(cand.args || []))
      ));
      if (existing) continue;
      const probe = new McpServerConnection(Object.assign({}, cand, { enabled: true, userAdded: true }));
      try {
        await probe.connect();
        this.connections.set(probe.cfg.id, probe);
        newlyConnected.push(probe.summary(this.isServerAppRunning(probe)));
      } catch (_) {
        probe.disconnect();
      }
    }
    if (newlyConnected.length) {
      this.persistConfigs();
    }
    this.emit('updated', this.list());
    return { servers: this.list(), newlyConnected };
  }

  disconnectServer(id) {
    const conn = this.connections.get(id);
    if (conn) {
      conn.disconnect();
      this.connections.delete(id);
      this.persistConfigs();
      this.emit('updated', this.list());
    }
    return this.list();
  }

  removeServer(id) {
    return this.disconnectServer(id);
  }

  async connectEnabledOnStartup() {
    for (const conn of Array.from(this.connections.values())) {
      if (conn.cfg.enabled && (conn.cfg.url || conn.cfg.command)) {
        conn.connect().then(() => this.emit('updated', this.list())).catch(() => {
          conn.cfg.enabled = false;
          this.connections.delete(conn.cfg.id);
          this.persistConfigs();
          this.emit('updated', this.list());
        });
      }
    }
  }

  getGeminiToolDeclarations() {
    const decls = [];
    this._toolMap = new Map();
    for (const conn of this.connections.values()) {
      if (conn.status !== 'connected') continue;
      const safeServer = String(conn.cfg.id).replace(/[^a-zA-Z0-9_]/g, '_');
      for (const tool of conn.tools) {
        const safeTool = String(tool.name || '').replace(/[^a-zA-Z0-9_]/g, '_');
        const fullName = ('mcp__' + safeServer + '__' + safeTool).slice(0, 64);
        this._toolMap.set(fullName, { serverId: conn.cfg.id, serverName: conn.summary().name, serverIcon: conn.cfg.icon, toolName: tool.name, description: tool.description || '' });
        decls.push({
          name: fullName,
          description: '[MCP: ' + conn.summary().name + '] ' + (tool.description || tool.name),
          parameters: sanitizeSchemaForGemini(tool.inputSchema)
        });
      }
    }
    return decls;
  }

  resolveToolMeta(fullName) {
    if (!this._toolMap) this.getGeminiToolDeclarations();
    return this._toolMap ? this._toolMap.get(fullName) || null : null;
  }

  async callGeminiTool(fullName, args) {
    const meta = this.resolveToolMeta(fullName);
    if (!meta) throw new Error('MCP tool not connected: ' + fullName);
    const conn = this.connections.get(meta.serverId);
    if (!conn || conn.status !== 'connected') throw new Error('MCP server "' + meta.serverId + '" is not connected.');
    return await conn.callTool(meta.toolName, args || {});
  }

  dispose() {
    for (const conn of this.connections.values()) {
      conn.disconnect();
    }
    if (this.bridgeServer) {
      try { this.bridgeServer.close(); } catch (_) { /* ignore */ }
      this.bridgeServer = null;
      this.bridgePort = 0;
    }
  }
}

module.exports = { McpManager, inferAppIconAndLabel, APP_SIGNATURES };
