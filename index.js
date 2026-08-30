import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  delay,
  getContentType,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import config from './config.js';
import { commands } from './command.js';
import { sms } from './lib/handler.js';
import { AntiDelete } from './lib/antidel.js';
import antiEdit from './lib/antiedit.js';
import groupEvents from './lib/groupevents.js';
import { addConnectionFunctions } from './lib/connection.js';
import { getGroupAdmins, lidToPhone } from './lib/functions.js';
import { saveMessage } from './lib/store.js';
import {
  connectMongo,
  saveSession,
  getSession,
  deleteSession,
  addNumber,
  removeNumber,
  getAllNumbers,
  getUserConfig,
  updateUserConfig,
  deleteUserConfig
} from './lib/mongo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ====== MEMORY OPTIMIZATION: Bounded collections ======
const MAX_SESSIONS = 30; // Heroku pe zyada se zyada 30 sessions (pehle 50 tha)
const MAX_REACT_QUEUE = 8; // Pehle 15 tha, ab 8
const MESSAGE_CACHE_SIZE = 50; // Per session message cache limit
const SESSION_IDLE_TIMEOUT = 3600000; // 1 hour idle session auto disconnect
const MEMORY_LIMIT_MB = 800; // 800MB pe auto cleanup

const sessions = new Map();
const sessionStartedAt = new Map();
const sessionLastActive = new Map(); // NEW: Track last activity
const locks = new Map();
const connectMsgSentFor = new Set();
const reconnectAttempts = new Map();
const sessionReadyAt = new Map();
const heartbeatIntervals = new Map();
const messageCache = new Map(); // NEW: Per session message dedup cache
const requestCounts = new Map(); // NEW: API rate limiting

const LINK_REGEX = /(chat\.whatsapp\.com\/\S+)|(whatsapp\.channel\/\S+)/i;
const NEWSLETTER_REACT_EMOJIS = ['❤️', '👍', '🔥', '✨', '💖', '😎', '🎉', '💯', '🚀', '🌟', '💥', '🦋', '💎', '🤩', '🌹', '🎯', '🏆', '🪐', '🌊', '💌', '🎵', '💋', '🌺', '🍀'];
const reactQueues = new Map();

// ====== MEMORY MONITORING ======
let lastMemoryLog = 0;

function getMemoryUsageMB() {
  const usage = process.memoryUsage();
  return Math.round(usage.heapUsed / 1024 / 1024);
}

function checkMemory() {
  const memMB = getMemoryUsageMB();
  const now = Date.now();
  
  if (now - lastMemoryLog > 300000) { // Har 5 min log
    log(`Memory usage: ${memMB}MB / ${MEMORY_LIMIT_MB}MB`, 'info');
    lastMemoryLog = now;
  }
  
  // Auto cleanup agar memory zyada ho
  if (memMB > MEMORY_LIMIT_MB) {
    log(`HIGH MEMORY: ${memMB}MB! Cleaning up...`, 'warning');
    cleanupMemory();
  }
  
  return memMB;
}

function cleanupMemory() {
  // 1. Sabse purani idle sessions disconnect karo
  const now = Date.now();
  const entries = Array.from(sessionLastActive.entries())
    .sort((a, b) => a[1] - b[1]); // Oldest first
  
  let cleaned = 0;
  for (const [clean, lastActive] of entries) {
    if (now - lastActive > 600000) { // 10+ min inactive
      const sock = sessions.get(clean);
      if (sock) {
        log(`Disconnecting idle session ${clean} for memory cleanup`, 'warning');
        safeDisconnect(clean, sock);
        cleaned++;
        if (cleaned >= 3) break; // Max 3 per cleanup
      }
    }
  }
  
  // 2. Old reconnect records clear karo
  for (const [num, record] of reconnectAttempts.entries()) {
    if (now - record.lastAttempt > 86400000) { // 24h old
      reconnectAttempts.delete(num);
    }
  }
  
  // 3. Message cache clear karo
  for (const [key, cache] of messageCache.entries()) {
    if (cache && cache.length > MESSAGE_CACHE_SIZE) {
      messageCache.set(key, cache.slice(-MESSAGE_CACHE_SIZE));
    }
  }
  
  // 4. Global.gc() hint (agar --expose-gc enabled ho)
  if (global.gc) {
    try { global.gc(); } catch {}
  }
}

// ====== RATE LIMITING ======
function checkRateLimit(ip, max = 20, window = 60000) {
  const now = Date.now();
  const record = requestCounts.get(ip) || { count: 0, start: now };
  
  if (now - record.start > window) {
    record.count = 1;
    record.start = now;
    requestCounts.set(ip, record);
    return true;
  }
  
  record.count++;
  requestCounts.set(ip, record);
  return record.count <= max;
}

// ====== HELPERS ======
function log(msg, level = 'info') {
  const icons = { info: '📝', success: '✅', error: '❌', warning: '⚠️', debug: '🐛' };
  console.log(`${icons[level] || '📝'} [GHOST-MD] ${new Date().toISOString()}: ${msg}`);
}

async function fetchRawText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) }); // 10s timeout
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    log(`Failed to fetch ${url}: ${e.message}`, 'error');
    return null;
  }
}

// ====== PLUGIN LOADING (Memory efficient) ======
async function loadExternalPlugins() {
  log('Loading external plugins...');
  const tempDir = path.join(__dirname, '.temp_plugins');
  
  // Pehle se existing plugins delete karo (memory bachao)
  try {
    await fs.remove(tempDir);
  } catch {}
  await fs.ensureDir(tempDir);

  try {
    const res = await fetch('https://api.github.com/repos/ai-03131613251/sabkabapai/contents/plugins', { 
      signal: AbortSignal.timeout(15000) 
    });
    if (!res.ok) throw new Error('GitHub API failed');
    const files = (await res.json()).filter(f => f.name.endsWith('.js')).map(f => f.name);

    if (!files.length) {
      log('No plugins found.', 'warning');
      return;
    }

    commands.length = 0;
    for (const file of files) {
      const raw = await fetchRawText(`https://raw.githubusercontent.com/ai-03131613251/sabkabapai/main/plugins/${file}`);
      if (!raw) continue;
      const localPath = path.join(tempDir, file);
      await fs.writeFile(localPath, raw);
      await import(`${localPath}?update=${Date.now()}`);
      log(`Loaded: ${file}`, 'success');
    }
    log(`Total commands: ${commands.length}`, 'success');
  } catch (e) {
    log(`Plugin load error: ${e.message}`, 'error');
  }
}

// ====== REACTION QUEUE (Bounded) ======
function enqueueReact(sessionId, fn) {
  if (!reactQueues.has(sessionId)) reactQueues.set(sessionId, { queue: [], processing: false });
  const q = reactQueues.get(sessionId);
  if (q.queue.length >= MAX_REACT_QUEUE) {
    q.queue.shift(); // Oldest remove karo
  }
  q.queue.push(fn);
  if (!q.processing) processReactQueue(sessionId);
}

async function processReactQueue(sessionId) {
  const q = reactQueues.get(sessionId);
  if (!q || q.processing) return;
  q.processing = true;
  while (q.queue.length) {
    const fn = q.queue.shift();
    try { await fn(); } catch {}
    await delay(500); // Thoda slow karo (rate limit se bachein)
  }
  q.processing = false;
  // Memory bachao: queue khatam hone pe delete karo
  if (q.queue.length === 0) {
    reactQueues.delete(sessionId);
  }
}

// ====== SESSION MANAGEMENT ======
function isConnected(number) {
  return sessions.has(number.replace(/[^0-9]/g, ''));
}

function connectionStatus(number) {
  const clean = number.replace(/[^0-9]/g, '');
  const started = sessionStartedAt.get(clean);
  const ready = sessionReadyAt.get(clean);
  const lastActive = sessionLastActive.get(clean);
  return {
    isConnected: sessions.has(clean),
    connectionTime: started ? new Date(started).toLocaleString() : null,
    uptime: started ? Math.floor((Date.now() - started) / 1000) : 0,
    readyTime: ready ? new Date(ready).toLocaleString() : null,
    lastActive: lastActive ? Math.floor((Date.now() - lastActive) / 1000) + 's ago' : null
  };
}

function isSocketHealthy(sock) {
  return sock && sock.ws && sock.ws.readyState === 1 && sock.user && sock.user.id;
}

// ====== EXPONENTIAL BACKOFF (2 din tak) ======
function getReconnectDelay(number) {
  const now = Date.now();
  const record = reconnectAttempts.get(number);
  
  if (!record || now - record.lastAttempt > 86400000) {
    reconnectAttempts.set(number, { count: 1, lastAttempt: now, windowStart: now });
    return 5000;
  }
  
  record.count++;
  record.lastAttempt = now;
  
  const delays = [5000, 10000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 14400000, 28800000, 43200000, 86400000, 172800000];
  const delay = delays[Math.min(record.count - 1, delays.length - 1)];
  
  log(`Backoff ${number}: #${record.count}, wait ${Math.floor(delay/1000)}s`, 'warning');
  return delay;
}

function resetReconnectAttempts(number) {
  reconnectAttempts.delete(number);
}

// ====== SAFE DISCONNECT (Memory cleanup) ======
async function safeDisconnect(clean, sock) {
  try {
    stopHeartbeat(clean);
    if (sock?.ws) sock.ws.close();
    if (sock?.ev) sock.ev.removeAllListeners();
  } catch (e) {}
  
  sessions.delete(clean);
  sessionStartedAt.delete(clean);
  sessionReadyAt.delete(clean);
  sessionLastActive.delete(clean);
  messageCache.delete(clean);
  locks.delete(clean);
  
  // React queue bhi clean karo
  reactQueues.delete(clean);
  
  log(`Cleaned up session ${clean}`, 'info');
}

// ====== HEARTBEAT (Optimized) ======
function startHeartbeat(clean, sock) {
  if (heartbeatIntervals.has(clean)) {
    clearInterval(heartbeatIntervals.get(clean));
  }
  
  const interval = setInterval(async () => {
    try {
      if (!isSocketHealthy(sock)) {
        throw new Error('Socket unhealthy');
      }
      sessionLastActive.set(clean, Date.now());
      
      // Har 30s mein presence update (keep alive)
      if (sock.sendPresenceUpdate) {
        await sock.sendPresenceUpdate('available');
      }
    } catch (e) {
      log(`Heartbeat fail ${clean}`, 'warning');
      clearInterval(interval);
      heartbeatIntervals.delete(clean);
    }
  }, 30000); // 30 seconds (zyada frequent nahi)
  
  heartbeatIntervals.set(clean, interval);
}

function stopHeartbeat(clean) {
  if (heartbeatIntervals.has(clean)) {
    clearInterval(heartbeatIntervals.get(clean));
    heartbeatIntervals.delete(clean);
  }
}

// ====== IDLE SESSION CHECKER ======
function checkIdleSessions() {
  const now = Date.now();
  for (const [clean, lastActive] of sessionLastActive.entries()) {
    if (now - lastActive > SESSION_IDLE_TIMEOUT) {
      log(`Idle timeout: ${clean}`, 'warning');
      const sock = sessions.get(clean);
      if (sock) safeDisconnect(clean, sock);
    }
  }
}

// ====== MAIN SESSION FUNCTION ======
async function startSession(number, res = null) {
  const clean = number.replace(/[^0-9]/g, '');
  
  // Memory check before connecting
  const memMB = checkMemory();
  if (memMB > MEMORY_LIMIT_MB - 100 && sessions.size >= MAX_SESSIONS - 5) {
    log(`Memory full! Cannot connect ${clean}`, 'error');
    if (res && !res.headersSent) {
      return res.status(503).json({ error: 'Server memory full, try later' });
    }
    return;
  }
  
  // Max session limit
  if (sessions.size >= MAX_SESSIONS && !sessions.has(clean)) {
    log(`Max sessions (${MAX_SESSIONS}) reached`, 'warning');
    if (res && !res.headersSent) {
      return res.status(429).json({ error: `Max ${MAX_SESSIONS} sessions allowed` });
    }
    return;
  }

  const sessionPath = path.join(__dirname, 'session', `session_${clean}`);

  // Already connected check
  if (sessions.has(clean)) {
    const existing = sessions.get(clean);
    if (isSocketHealthy(existing)) {
      sessionLastActive.set(clean, Date.now());
      if (res && !res.headersSent) {
        return res.json({ status: 'already_connected', ...connectionStatus(clean) });
      }
      return existing;
    } else {
      await safeDisconnect(clean, existing);
    }
  }

  // Lock check (2 min)
  if (locks.has(clean) && Date.now() - locks.get(clean) < 120000) {
    if (res && !res.headersSent) return res.json({ status: 'connection_in_progress' });
    return;
  }
  locks.set(clean, Date.now());

  try {
    // Clean old session files (memory leak fix)
    const savedSession = await getSession(clean);
    if (!savedSession && fs.existsSync(sessionPath)) {
      await fs.remove(sessionPath);
    } else if (savedSession) {
      await fs.ensureDir(sessionPath);
      await fs.writeFile(path.join(sessionPath, 'creds.json'), JSON.stringify(savedSession, null, 2));
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, console)
      },
      printQRInTerminal: false,
      logger: { 
        info: () => {}, 
        debug: () => {}, 
        warn: (m) => log(m, 'warning'), 
        error: (m) => log(m, 'error'),
        trace: () => {},
        child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, trace: () => {} })
      }, // Silent logger (memory bachao)
      version,
      browser: Browsers.macOS('Safari'),
      markOnlineOnConnect: true,
      syncFullHistory: false,
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 3, // Reduced from 5
      msgRetryCounterMap: new Map(),
      defaultQueryTimeoutMs: 60000,
      emitOwnEvents: false, // Memory save
      shouldSyncHistoryMessage: () => false, // Don't sync history (memory save)
      fireInitQueries: true
    });

    await addConnectionFunctions(sock);
    sessionStartedAt.set(clean, Date.now());
    sessionLastActive.set(clean, Date.now());
    messageCache.set(clean, []); // Initialize cache

    // User config
    let userConfig = await getUserConfig(clean);
    sock.userConfig = userConfig;
    sock.setUserConfig = async (updates) => {
      sock.userConfig = { ...sock.userConfig, ...updates };
      await updateUserConfig(clean, updates);
      return sock.userConfig;
    };

    // Pairing
    if (!sock.authState.creds.registered) {
      await delay(1500);
      const code = await sock.requestPairingCode(clean);
      log(`Pairing code for ${clean}: ${code}`, 'success');
      if (res && !res.headersSent) return res.json({ status: 'new_pairing', code });
    } else {
      if (res && !res.headersSent) return res.json({ status: 'reconnecting' });
    }

    // Creds save
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      try {
        const creds = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
        await saveSession(clean, JSON.parse(creds));
      } catch {}
    });

    // Anti-delete
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (update.update?.message === null) {
          await AntiDelete(sock, [update], clean).catch(() => {});
        }
      }
    });

    // Connection handler
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      
      if (connection === 'open') {
        sessions.set(clean, sock);
        resetReconnectAttempts(clean);
        log(`Connected: ${clean}`, 'success');
        await addNumber(clean);
        sessionReadyAt.set(clean, Date.now());
        sessionLastActive.set(clean, Date.now());
        startHeartbeat(clean, sock);
        
        if (!connectMsgSentFor.has(clean)) {
          connectMsgSentFor.add(clean);
        }
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        log(`Closed ${clean}. Code: ${statusCode}`, 'warning');
        
        await safeDisconnect(clean, sock);
        
        if (statusCode === DisconnectReason.loggedOut) {
          await deleteSession(clean);
          await removeNumber(clean);
          await deleteUserConfig(clean);
          connectMsgSentFor.delete(clean);
          reconnectAttempts.delete(clean);
          return;
        }
        
        if (!sock.authState?.creds?.registered) {
          locks.delete(clean);
          connectMsgSentFor.delete(clean);
          reconnectAttempts.delete(clean);
          return;
        }
        
        // Exponential backoff reconnect
        const backoff = getReconnectDelay(clean);
        log(`Reconnecting ${clean} in ${Math.floor(backoff/1000)}s`, 'info');
        await delay(backoff);
        locks.delete(clean);
        startSession(clean).catch(e => log(`Reconnect fail: ${e.message}`, 'error'));
      }
    });

    // Anti-call
    sock.ev.on('call', async (calls) => {
      const cfg = sock.userConfig;
      if (cfg.ANTI_CALL !== 'true') return;
      for (const call of calls) {
        if (call.status === 'offer') {
          await sock.rejectCall(call.id, call.from).catch(() => {});
          await sock.sendMessage(call.from, { text: cfg.REJECT_MSG || 'Call rejected' }).catch(() => {});
        }
      }
    });

    // Group events
    sock.ev.on('group-participants.update', async (event) => {
      const ready = sessionReadyAt.get(clean);
      if (ready && Date.now() - ready < 20000) return;
      if (event.participants?.length > 3) return;
      await groupEvents(sock, event).catch(() => {});
    });

    // Messages (Memory optimized)
    sock.ev.on('messages.upsert', async ({ messages }) => {
      let msg = messages[0];
      if (!msg?.message) return;

      // Update activity
      sessionLastActive.set(clean, Date.now());

      // Deduplication cache
      const cache = messageCache.get(clean) || [];
      const msgId = msg.key.id;
      if (cache.includes(msgId)) return; // Already processed
      cache.push(msgId);
      if (cache.length > MESSAGE_CACHE_SIZE) cache.shift(); // Keep last 50
      messageCache.set(clean, cache);

      // Ephemeral handle
      msg.message = getContentType(msg.message) === 'ephemeralMessage'
        ? msg.message.ephemeralMessage.message
        : msg.message;

      const userConfig = sock.userConfig || await getUserConfig(clean);
      const prefix = userConfig.PREFIX || config.PREFIX;
      const mode = userConfig.MODE || config.MODE;

      // Anti-edit
      if (msg.message?.protocolMessage?.editedMessage) {
        await antiEdit(sock, msg, clean).catch(() => {});
        return;
      }

      // Ignore newsletters & status
      if (msg.key.remoteJid?.endsWith('@newsletter')) return;
      if (msg.key.remoteJid === 'status@broadcast') {
        if (userConfig.AUTO_VIEW_STATUS === 'true') {
          await sock.readMessages([msg.key]).catch(() => {});
        }
        return;
      }

      const m = sms(sock, msg);
      const type = getContentType(msg.message);
      const jid = msg.key.remoteJid;
      const text = type === 'conversation' ? msg.message.conversation
        : type === 'extendedTextMessage' ? msg.message.extendedTextMessage.text
        : '';

      await saveMessage(msg, clean, userConfig).catch(() => {});

      const isCmd = text.startsWith(prefix);
      const cmd = isCmd ? text.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '';
      const args = text.trim().split(/ +/).slice(1);
      const fullArgs = args.join(' ');

      const isGroup = jid.endsWith('@g.us');
      const sender = msg.key.fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : msg.key.participant || msg.key.remoteJid;
      const senderNumber = sender.split('@')[0];
      const botNumber = sock.user.id.split(':')[0];
      const pushname = msg.pushName || 'User';
      const isMe = botNumber === senderNumber;
      const isOwner = config.SUDO.includes(sender) || config.OWNER_NUMBER.includes(senderNumber)
        || userConfig.SUDO?.includes(sender) || userConfig.OWNER_NUMBER === senderNumber
        || userConfig.OWNER_NUMBER?.includes(senderNumber) || isMe;

      // Anti-link
      if (isGroup && !isMe && !isOwner) {
        const antiLink = userConfig.ANTI_LINK;
        if (antiLink && antiLink !== 'false' && antiLink !== 'off' && LINK_REGEX.test(text)) {
          try {
            const group = await sock.groupMetadata(jid);
            const admins = getGroupAdmins(group.participants);
            const isBotAdmin = admins.some(a => a.split('@')[0] === botNumber);
            const isSenderAdmin = admins.some(a => a.split('@')[0] === senderNumber);

            if (isBotAdmin && !isSenderAdmin) {
              await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
              await sock.sendMessage(jid, { text: `🚫 @${senderNumber} link removed.`, mentions: [sender] }).catch(() => {});
              await sock.groupParticipantsUpdate(jid, [sender], 'remove').catch(() => {});
            }
          } catch {}
        }
      }

      // Mode restrictions
      if (mode === 'private' && !isOwner) return;
      if (mode === 'inbox' && isGroup && !isOwner) return;

      // Command handling
      if (isCmd) {
        const plugin = commands.find(p => p.pattern === cmd || p.alias?.includes(cmd));
        if (plugin) {
          if (plugin.react) {
            await sock.sendMessage(jid, { react: { text: plugin.react, key: msg.key } }).catch(() => {});
          }
          try {
            await plugin.function(sock, msg, m, {
              from: jid,
              quoted: msg,
              body: text,
              isCmd,
              command: cmd,
              args,
              q: fullArgs,
              text: fullArgs,
              isGroup,
              sender,
              senderNumber,
              botNumber,
              pushname,
              isMe,
              isOwner,
              reply: (txt) => sock.sendMessage(jid, { text: txt }, { quoted: msg }),
              config,
              userConfig,
              updateUserConfig: sock.setUserConfig,
              sanitizedNumber: clean,
              prefix,
              mode
            });
          } catch (e) {
            log(`Plugin error [${cmd}]: ${e.message}`, 'error');
          }
        }
      }

      // Auto-react (throttled)
      if (['imageMessage', 'videoMessage', 'audioMessage', 'conversation', 'extendedTextMessage'].includes(type)
        && userConfig.AUTO_REACT === 'true' && !jid?.includes('@newsletter') && !msg.message?.protocolMessage) {
        const emojis = isOwner ? (userConfig.OWNER_EMOJIS || config.OWNER_EMOJIS)
          : (userConfig.REACT_EMOJIS || config.REACT_EMOJIS);
        if (emojis?.length) {
          const emoji = emojis[Math.floor(Math.random() * emojis.length)];
          enqueueReact(clean, async () => {
            await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {});
          });
        }
      }
    });

    return sock;

  } catch (e) {
    await safeDisconnect(clean, null);
    if (res && !res.headersSent) {
      res.status(503).json({ status: 'error', error: 'Failed to start session' });
    }
    throw e;
  } finally {
    // Lock cleanup handled by connection.update
  }
}

// ====== AUTO RECONNECT (Optimized) ======
async function autoReconnectAll() {
  try {
    const numbers = await getAllNumbers();
    log(`Reconnect check: ${numbers.length} DB, ${sessions.size} active`, 'info');
    
    for (const num of numbers) {
      const clean = num.replace(/[^0-9]/g, '');
      
      if (sessions.has(clean)) {
        const sock = sessions.get(clean);
        if (isSocketHealthy(sock)) {
          sessionLastActive.set(clean, Date.now());
          continue;
        } else {
          await safeDisconnect(clean, sock);
        }
      }
      
      if (locks.has(clean) && Date.now() - locks.get(clean) < 120000) continue;
      
      const record = reconnectAttempts.get(clean);
      if (record && record.lastAttempt) {
        const delay = getReconnectDelay(clean);
        const timeSince = Date.now() - record.lastAttempt;
        if (timeSince < delay && record.count < 16) continue; // Respect backoff
      }
      
      // Memory check
      if (getMemoryUsageMB() > MEMORY_LIMIT_MB - 50) {
        log('Memory high, skipping more reconnects', 'warning');
        break;
      }
      
      await startSession(num).catch(e => log(`Auto-reconnect fail ${num}: ${e.message}`, 'error'));
      await delay(8000); // 8 sec gap (zyada safe)
    }
  } catch (e) {
    log(`autoReconnectAll error: ${e.message}`, 'error');
  }
}

// ====== EXPRESS SERVER (Rate Limited) ======
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit middleware
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip, 30, 60000)) { // 30 requests per min
    return res.status(429).json({ error: 'Too many requests, slow down!' });
  }
  next();
});

app.get('/', (req, res) => {
  const html = path.join(__dirname, 'public', 'pair.html');
  if (fs.existsSync(html)) return res.sendFile(html);
  res.send('GHOST-MD is running 🔥');
});

app.get('/code', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).json({ error: 'Number required' });
  if (sessions.size >= MAX_SESSIONS) return res.status(429).json({ error: `Max ${MAX_SESSIONS} sessions` });
  
  try {
    await startSession(number, res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error', details: e.message });
  }
});

app.get('/status', (req, res) => {
  const { number } = req.query;
  if (!number) {
    return res.json({
      totalActive: sessions.size,
      memoryMB: getMemoryUsageMB(),
      connections: Array.from(sessions.keys()).map(n => ({ 
        number: n, 
        ...connectionStatus(n),
        healthy: isSocketHealthy(sessions.get(n))
      }))
    });
  }
  const clean = number.replace(/[^0-9]/g, '');
  res.json({ 
    number, 
    ...connectionStatus(number),
    healthy: sessions.has(clean) ? isSocketHealthy(sessions.get(clean)) : false
  });
});

app.get('/disconnect', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).json({ error: 'Number required' });
  const clean = number.replace(/[^0-9]/g, '');
  const sock = sessions.get(clean);
  if (!sock) return res.status(404).json({ error: 'Not found' });
  
  await safeDisconnect(clean, sock);
  await removeNumber(clean);
  await deleteSession(clean);
  connectMsgSentFor.delete(clean);
  reconnectAttempts.delete(clean);
  
  res.json({ status: 'success', message: 'Disconnected' });
});

app.get('/active', (req, res) => {
  res.json({ 
    count: sessions.size, 
    memoryMB: getMemoryUsageMB(),
    numbers: Array.from(sessions.keys()),
    healthy: Array.from(sessions.entries()).map(([n, s]) => ({ number: n, healthy: isSocketHealthy(s) }))
  });
});

app.get('/ping', (req, res) => {
  res.json({ 
    status: 'active', 
    message: `${config.BOT_NAME} is running 🔥`, 
    activeSessions: sessions.size,
    memoryMB: getMemoryUsageMB(),
    uptime: process.uptime()
  });
});

app.get('/connect-all', async (req, res) => {
  try {
    const numbers = await getAllNumbers();
    const results = [];
    for (const num of numbers) {
      const clean = num.replace(/[^0-9]/g, '');
      if (sessions.has(clean) && isSocketHealthy(sessions.get(clean))) {
        results.push({ number: num, status: 'already_connected' });
        continue;
      }
      await startSession(num).catch(() => {});
      results.push({ number: num, status: 'connection_initiated' });
      await delay(5000); // 5 sec gap
    }
    res.json({ status: 'success', total: numbers.length, connections: results });
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
});

// ====== REACT ENDPOINT ======
app.get('/react', async (req, res) => {
  const { link, emojis } = req.query;
  if (!link) return res.status(400).json({ status: 'error', message: 'link parameter required' });
  if (!sessions.size) return res.status(404).json({ status: 'error', message: 'No active sessions' });

  let reactEmojis = emojis ? emojis.split(',').filter(Boolean) : NEWSLETTER_REACT_EMOJIS;
  if (!reactEmojis.length) reactEmojis = NEWSLETTER_REACT_EMOJIS;

  let inviteCode = null, serverId = null, targetJid = null;

  try {
    const url = new URL(link);
    const parts = url.pathname.split('/').filter(Boolean);
    const channelIdx = parts.indexOf('channel');
    if (channelIdx !== -1 && parts[channelIdx + 1]) {
      inviteCode = parts[channelIdx + 1];
      if (parts[channelIdx + 2] && /^\d+$/.test(parts[channelIdx + 2])) {
        serverId = parts[channelIdx + 2];
      }
    }
    if (!serverId) serverId = url.searchParams.get('sid') || url.searchParams.get('serverId');
    if (link.includes('@newsletter')) {
      targetJid = link.split('/').pop().split('?')[0];
      inviteCode = null;
    }
  } catch {
    const match = link.match(/channel\/([^\/]+)\/(\d+)/);
    if (match) { inviteCode = match[1]; serverId = match[2]; }
    if (link.includes('@newsletter')) targetJid = link.split('/').pop().split('?')[0];
  }

  if (!serverId) {
    return res.status(400).json({ status: 'error', message: 'Could not extract serverId from link' });
  }

  const entries = Array.from(sessions.entries());
  const results = [];

  for (let i = 0; i < entries.length; i++) {
    const [number, sock] = entries[i];
    const emoji = reactEmojis[Math.floor(Math.random() * reactEmojis.length)];
    try {
      let jid = targetJid;
      if (!jid && inviteCode) {
        if (typeof sock.newsletterMetadata === 'function') {
          try {
            const meta = await sock.newsletterMetadata('invite', inviteCode);
            if (meta?.id) jid = meta.id;
          } catch {}
        }
        if (!jid) jid = `${inviteCode}@newsletter`;
      }
      if (!jid) throw new Error('Could not determine target JID');
      if (typeof sock.newsletterReactMessage !== 'function') {
        throw new Error('newsletterReactMessage not available');
      }

      let retries = 2, success = false; // Reduced retries
      while (retries > 0) {
        try {
          await sock.newsletterReactMessage(jid, serverId.toString(), emoji);
          results.push({ number, status: 'success', emoji });
          success = true;
          break;
        } catch (err) {
          if (err.message?.includes('rate-overlimit') || err.message?.includes('429')) {
            results.push({ number, status: 'rate_limited', emoji });
            break;
          }
          retries--;
          if (retries === 0) throw err;
          await delay(3000);
        }
      }
    } catch (err) {
      results.push({ number, status: 'failed', error: err.message });
    }
    if (i < entries.length - 1) await delay(4000); // 4 sec gap
  }

  res.json({
    status: 'completed',
    totalSessions: entries.length,
    successCount: results.filter(r => r.status === 'success').length,
    results,
    inviteCode,
    serverId,
    targetJid
  });
});

// ====== START ======
let serverStarted = false;

async function main() {
  try {
    if (!serverStarted) {
      const port = process.env.PORT || 8000;
      app.listen(port, () => log(`Server on port ${port}`, 'success'));
      serverStarted = true;
    }

    await connectMongo();
    await loadExternalPlugins();
    await autoReconnectAll();

    // Intervals
    setInterval(() => checkMemory(), 60000);           // Har 1 min memory check
    setInterval(() => checkIdleSessions(), 600000);    // Har 10 min idle check
    setInterval(() => autoReconnectAll().catch(() => {}), 1800000); // 30 min
    
    // Rate limit cleanup
    setInterval(() => {
      const now = Date.now();
      for (const [ip, record] of requestCounts.entries()) {
        if (now - record.start > 120000) requestCounts.delete(ip);
      }
    }, 120000);
    
  } catch (e) {
    log(`Main crashed: ${e.message}`, 'error');
    await delay(10000);
    main();
  }
}

main();

// ====== PROCESS HANDLERS ======
process.on('SIGINT', async () => {
  for (const [clean, sock] of sessions) {
    await safeDisconnect(clean, sock);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  for (const [clean, sock] of sessions) {
    await safeDisconnect(clean, sock);
  }
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  log(`Uncaught exception: ${e.message}`, 'error');
  setTimeout(main, 10000);
});

process.on('unhandledRejection', (e) => {
  log(`Unhandled rejection: ${e?.message}`, 'error');
  setTimeout(main, 10000);
});

export default app;
