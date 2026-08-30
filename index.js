import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import pino from 'pino';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  delay,
  getContentType,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys';
import config from './config.js';
import { commands } from './command.js';
import { sms } from './lib/handler.js';
import { AntiDelete } from './lib/antidel.js';
import antiEdit from './lib/antiedit.js';
import groupEvents from './lib/groupevents.js';
import { addConnectionFunctions } from './lib/connection.js';
import { getGroupAdmins } from './lib/functions.js';
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

const MAX_SESSIONS = 30;
const MAX_REACT_QUEUE = 8;
const MESSAGE_CACHE_SIZE = 50;
const SESSION_IDLE_TIMEOUT = 3600000;
const MEMORY_LIMIT_MB = 800;

const sessions = new Map();
const sessionStartedAt = new Map();
const sessionLastActive = new Map();
const locks = new Map();
const connectMsgSentFor = new Set();
const reconnectAttempts = new Map();
const sessionReadyAt = new Map();
const heartbeatIntervals = new Map();
const messageCache = new Map();
const requestCounts = new Map();

const LINK_REGEX = /(chat\.whatsapp\.com\/\S+)|(whatsapp\.channel\/\S+)/i;
const NEWSLETTER_REACT_EMOJIS = ['❤️', '👍', '🔥', '✨', '💖', '😎', '🎉', '💯', '🚀', '🌟', '💥', '🦋', '💎', '🤩', '🌹', '🎯', '🏆', '🪐', '🌊', '💌', '🎵', '💋', '🌺', '🍀'];
const reactQueues = new Map();

const logger = pino({ level: 'silent' });

let lastMemoryLog = 0;
let isMainRunning = false;
let serverStarted = false;

function getMemoryUsageMB() {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

function checkMemory() {
  const memMB = getMemoryUsageMB();
  const now = Date.now();
  if (now - lastMemoryLog > 300000) {
    log(`Memory: ${memMB}MB / ${MEMORY_LIMIT_MB}MB`, 'info');
    lastMemoryLog = now;
  }
  if (memMB > MEMORY_LIMIT_MB) {
    log(`HIGH MEMORY: ${memMB}MB! Cleaning...`, 'warning');
    cleanupMemory();
  }
  return memMB;
}

function cleanupMemory() {
  const now = Date.now();
  const entries = Array.from(sessionLastActive.entries()).sort((a, b) => a[1] - b[1]);
  let cleaned = 0;
  for (const [clean, lastActive] of entries) {
    if (now - lastActive > 600000) {
      const sock = sessions.get(clean);
      if (sock) {
        log(`Idle disconnect ${clean}`, 'warning');
        safeDisconnect(clean, sock);
        cleaned++;
        if (cleaned >= 3) break;
      }
    }
  }
  for (const [num, record] of reconnectAttempts.entries()) {
    if (now - record.lastAttempt > 86400000) reconnectAttempts.delete(num);
  }
  for (const [key, cache] of messageCache.entries()) {
    if (cache?.length > MESSAGE_CACHE_SIZE) messageCache.set(key, cache.slice(-MESSAGE_CACHE_SIZE));
  }
  if (global.gc) try { global.gc(); } catch {}
}

function checkRateLimit(ip, max = 30, window = 60000) {
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

function log(msg, level = 'info') {
  const icons = { info: '📝', success: '✅', error: '❌', warning: '⚠️' };
  console.log(`${icons[level] || '📝'} [GHOST-MD] ${new Date().toISOString()}: ${msg}`);
}

async function fetchRawText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    log(`Fetch fail ${url}: ${e.message}`, 'error');
    return null;
  }
}

async function loadExternalPlugins() {
  log('Loading plugins...');
  const tempDir = path.join(__dirname, '.temp_plugins');
  try { await fs.remove(tempDir); } catch {}
  await fs.ensureDir(tempDir);
  try {
    const res = await fetch('https://api.github.com/repos/ai-03131613251/sabkabapai/contents/plugins', {
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error('GitHub API failed');
    const files = (await res.json()).filter(f => f.name.endsWith('.js')).map(f => f.name);
    if (!files.length) {
      log('No plugins found', 'warning');
      return;
    }
    commands.length = 0;
    for (const file of files) {
      const raw = await fetchRawText(`https://raw.githubusercontent.com/ai-03131613251/sabkabapai/main/plugins/${file}`);
      if (!raw) continue;
      const localPath = path.join(tempDir, file);
      await fs.writeFile(localPath, raw);
      await import(`\( {localPath}?update= \){Date.now()}`);
      log(`Loaded: ${file}`, 'success');
    }
    log(`Total commands: ${commands.length}`, 'success');
  } catch (e) {
    log(`Plugin load error: ${e.message}`, 'error');
  }
}

function enqueueReact(sessionId, fn) {
  if (!reactQueues.has(sessionId)) reactQueues.set(sessionId, { queue: [], processing: false });
  const q = reactQueues.get(sessionId);
  if (q.queue.length >= MAX_REACT_QUEUE) q.queue.shift();
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
    await delay(500);
  }
  q.processing = false;
  if (q.queue.length === 0) reactQueues.delete(sessionId);
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
  return !!(sock && sock.ws && sock.ws.readyState === 1 && sock.user && sock.user.id);
}

function getReconnectDelay(number) {
  const now = Date.now();
  let record = reconnectAttempts.get(number);
  if (!record || now - record.lastAttempt > 86400000) {
    reconnectAttempts.set(number, { count: 1, lastAttempt: now });
    return 10000;
  }
  record.count++;
  record.lastAttempt = now;
  const delays = [10000, 20000, 40000, 60000, 120000, 300000, 600000, 900000, 1800000];
  const d = delays[Math.min(record.count - 1, delays.length - 1)];
  log(`Backoff \( {number}: # \){record.count} → ${Math.floor(d / 1000)}s`, 'warning');
  return d;
}

function resetReconnectAttempts(number) {
  reconnectAttempts.delete(number);
}

async function safeDisconnect(clean, sock) {
  try {
    stopHeartbeat(clean);
    if (sock?.ev) sock.ev.removeAllListeners();
    if (sock?.ws) {
      try { sock.ws.close(); } catch {}
    }
  } catch {}
  sessions.delete(clean);
  sessionStartedAt.delete(clean);
  sessionReadyAt.delete(clean);
  sessionLastActive.delete(clean);
  messageCache.delete(clean);
  locks.delete(clean);
  reactQueues.delete(clean);
  log(`Cleaned session ${clean}`, 'info');
}

function startHeartbeat(clean, sock) {
  stopHeartbeat(clean);
  const interval = setInterval(async () => {
    try {
      if (!isSocketHealthy(sock)) throw new Error('unhealthy');
      sessionLastActive.set(clean, Date.now());
      if (sock.sendPresenceUpdate) await sock.sendPresenceUpdate('available').catch(() => {});
    } catch {
      log(`Heartbeat fail ${clean}`, 'warning');
      stopHeartbeat(clean);
    }
  }, 30000);
  heartbeatIntervals.set(clean, interval);
}

function stopHeartbeat(clean) {
  if (heartbeatIntervals.has(clean)) {
    clearInterval(heartbeatIntervals.get(clean));
    heartbeatIntervals.delete(clean);
  }
}

function checkIdleSessions() {
  const now = Date.now();
  for (const [clean, lastActive] of sessionLastActive.entries()) {
    if (now - lastActive > SESSION_IDLE_TIMEOUT) {
      log(`Idle timeout ${clean}`, 'warning');
      const sock = sessions.get(clean);
      if (sock) safeDisconnect(clean, sock);
    }
  }
}

async function startSession(number, res = null) {
  const clean = number.replace(/[^0-9]/g, '');

  if (getMemoryUsageMB() > MEMORY_LIMIT_MB - 100 && sessions.size >= MAX_SESSIONS - 5) {
    log(`Memory full, skip ${clean}`, 'error');
    if (res && !res.headersSent) return res.status(503).json({ error: 'Server memory full' });
    return;
  }

  if (sessions.size >= MAX_SESSIONS && !sessions.has(clean)) {
    log(`Max sessions reached`, 'warning');
    if (res && !res.headersSent) return res.status(429).json({ error: `Max ${MAX_SESSIONS} sessions` });
    return;
  }

  const sessionPath = path.join(__dirname, 'session', `session_${clean}`);

  if (sessions.has(clean)) {
    const existing = sessions.get(clean);
    if (isSocketHealthy(existing)) {
      sessionLastActive.set(clean, Date.now());
      if (res && !res.headersSent) return res.json({ status: 'already_connected', ...connectionStatus(clean) });
      return existing;
    }
    await safeDisconnect(clean, existing);
  }

  if (locks.has(clean) && Date.now() - locks.get(clean) < 120000) {
    if (res && !res.headersSent) return res.json({ status: 'connection_in_progress' });
    return;
  }
  locks.set(clean, Date.now());

  try {
    const savedSession = await getSession(clean).catch(() => null);

    if (!savedSession && fs.existsSync(sessionPath)) {
      await fs.remove(sessionPath).catch(() => {});
    } else if (savedSession) {
      await fs.ensureDir(sessionPath);
      await fs.writeFile(path.join(sessionPath, 'creds.json'), JSON.stringify(savedSession, null, 2));
    } else {
      await fs.ensureDir(sessionPath);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 120000,
      defaultQueryTimeoutMs: 60000,
      emitOwnEvents: false,
      shouldSyncHistoryMessage: () => false,
      fireInitQueries: true,
      getMessage: async () => undefined
    });

    // Socket pehle se map me — pairing ke time na maray
    sessions.set(clean, sock);
    sessionStartedAt.set(clean, Date.now());
    sessionLastActive.set(clean, Date.now());
    messageCache.set(clean, []);

    await addConnectionFunctions(sock).catch(() => {});

    let userConfig = await getUserConfig(clean).catch(() => ({}));
    sock.userConfig = userConfig || {};
    sock.setUserConfig = async (updates) => {
      sock.userConfig = { ...sock.userConfig, ...updates };
      await updateUserConfig(clean, updates).catch(() => {});
      return sock.userConfig;
    };

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        const credsPath = path.join(sessionPath, 'creds.json');
        if (fs.existsSync(credsPath)) {
          const creds = await fs.readFile(credsPath, 'utf8');
          await saveSession(clean, JSON.parse(creds));
        }
      } catch (e) {
        log(`creds.save error: ${e.message}`, 'warning');
      }
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (update.update?.message === null) {
          await AntiDelete(sock, [update], clean).catch(() => {});
        }
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'connecting') {
        log(`Connecting... ${clean}`, 'info');
        return;
      }

      if (connection === 'open') {
        sessions.set(clean, sock);
        resetReconnectAttempts(clean);
        locks.delete(clean);
        log(`✅ CONNECTED: ${clean}`, 'success');
        await addNumber(clean).catch(() => {});
        sessionReadyAt.set(clean, Date.now());
        sessionLastActive.set(clean, Date.now());
        startHeartbeat(clean, sock);

        if (!connectMsgSentFor.has(clean)) {
          connectMsgSentFor.add(clean);
          try {
            const botName = sock.userConfig?.BOT_NAME || config.BOT_NAME || 'GHOST-MD';
            const owner = sock.userConfig?.OWNER_NUMBER || config.OWNER_NUMBER;
            const prefix = sock.userConfig?.PREFIX || config.PREFIX;
            const mode = sock.userConfig?.MODE || config.MODE;

            const welcomeText =
`✅ *${botName} Connected Successfully!*

📱 Number: ${clean}
👑 Owner: ${owner}
⚡ Prefix: ${prefix}
Mode: ${mode}

Bot is ready.
Type *${prefix}menu* for commands.`;

            await sock.sendMessage(`${owner}@s.whatsapp.net`, { text: welcomeText }).catch(() => {});
            await sock.sendMessage(`${clean}@s.whatsapp.net`, { text: welcomeText }).catch(() => {});
            log(`First response sent → ${clean}`, 'success');
          } catch (e) {
            log(`Welcome error: ${e.message}`, 'warning');
          }
        }
        return;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || '';
        log(`Closed ${clean} | Code: ${statusCode} | ${errMsg}`, 'warning');

        await safeDisconnect(clean, sock);

        // Logged out / unauthorized
        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          await deleteSession(clean).catch(() => {});
          await removeNumber(clean).catch(() => {});
          await deleteUserConfig(clean).catch(() => {});
          connectMsgSentFor.delete(clean);
          reconnectAttempts.delete(clean);
          locks.delete(clean);
          log(`Logged out permanently: ${clean}`, 'warning');
          return;
        }

        // Pairing incomplete — reconnect mat karo
        if (!state.creds?.registered) {
          locks.delete(clean);
          connectMsgSentFor.delete(clean);
          log(`Pairing not completed for ${clean}. Request new code from /code`, 'warning');
          return;
        }

        // Registered thi → backoff se reconnect
        const backoff = getReconnectDelay(clean);
        log(`Will reconnect ${clean} in ${Math.floor(backoff / 1000)}s`, 'info');
        setTimeout(() => {
          locks.delete(clean);
          startSession(clean).catch(e => log(`Reconnect fail: ${e.message}`, 'error'));
        }, backoff);
      }
    });

    sock.ev.on('call', async (calls) => {
      const cfg = sock.userConfig || {};
      if (cfg.ANTI_CALL !== 'true') return;
      for (const call of calls) {
        if (call.status === 'offer') {
          await sock.rejectCall(call.id, call.from).catch(() => {});
          await sock.sendMessage(call.from, { text: cfg.REJECT_MSG || 'Call rejected' }).catch(() => {});
        }
      }
    });

    sock.ev.on('group-participants.update', async (event) => {
      const ready = sessionReadyAt.get(clean);
      if (ready && Date.now() - ready < 20000) return;
      if (event.participants?.length > 3) return;
      await groupEvents(sock, event).catch(() => {});
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        let msg = messages[0];
        if (!msg?.message) return;

        sessionLastActive.set(clean, Date.now());

        const cache = messageCache.get(clean) || [];
        if (cache.includes(msg.key.id)) return;
        cache.push(msg.key.id);
        if (cache.length > MESSAGE_CACHE_SIZE) cache.shift();
        messageCache.set(clean, cache);

        if (getContentType(msg.message) === 'ephemeralMessage') {
          msg.message = msg.message.ephemeralMessage.message;
        }

        const userConfig = sock.userConfig || {};
        const prefix = userConfig.PREFIX || config.PREFIX;
        const mode = userConfig.MODE || config.MODE;

        if (msg.message?.protocolMessage?.editedMessage) {
          await antiEdit(sock, msg, clean).catch(() => {});
          return;
        }

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
          : type === 'extendedTextMessage' ? msg.message.extendedTextMessage?.text
          : '';

        await saveMessage(msg, clean, userConfig).catch(() => {});

        const isCmd = text?.startsWith(prefix);
        const cmd = isCmd ? text.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '';
        const args = text?.trim().split(/ +/).slice(1) || [];
        const fullArgs = args.join(' ');

        const isGroup = jid?.endsWith('@g.us');
        const sender = msg.key.fromMe
          ? (sock.user?.id?.split(':')[0] + '@s.whatsapp.net')
          : (msg.key.participant || msg.key.participantAlt || msg.key.remoteJid || msg.key.remoteJidAlt);
        const senderNumber = (sender || '').split('@')[0];
        const botNumber = sock.user?.id?.split(':')[0];
        const pushname = msg.pushName || 'User';
        const isMe = botNumber === senderNumber;
        const isOwner = config.SUDO?.includes(sender) ||
          config.OWNER_NUMBER?.includes(senderNumber) ||
          userConfig.SUDO?.includes(sender) ||
          userConfig.OWNER_NUMBER === senderNumber ||
          userConfig.OWNER_NUMBER?.includes?.(senderNumber) ||
          isMe;

        if (isGroup && !isMe && !isOwner && text) {
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

        if (mode === 'private' && !isOwner) return;
        if (mode === 'inbox' && isGroup && !isOwner) return;

        if (isCmd && cmd) {
          const plugin = commands.find(p => p.pattern === cmd || p.alias?.includes(cmd));
          if (plugin) {
            if (plugin.react) {
              await sock.sendMessage(jid, { react: { text: plugin.react, key: msg.key } }).catch(() => {});
            }
            try {
              await plugin.function(sock, msg, m, {
                from: jid, quoted: msg, body: text, isCmd, command: cmd, args, q: fullArgs,
                text: fullArgs, isGroup, sender, senderNumber, botNumber, pushname, isMe, isOwner,
                reply: (txt) => sock.sendMessage(jid, { text: txt }, { quoted: msg }),
                config, userConfig, updateUserConfig: sock.setUserConfig,
                sanitizedNumber: clean, prefix, mode
              });
            } catch (e) {
              log(`Plugin [${cmd}]: ${e.message}`, 'error');
            }
          }
        }

        if (['imageMessage', 'videoMessage', 'audioMessage', 'conversation', 'extendedTextMessage'].includes(type)
          && userConfig.AUTO_REACT === 'true' && !jid?.includes('@newsletter') && !msg.message?.protocolMessage) {
          const emojis = isOwner
            ? (userConfig.OWNER_EMOJIS || config.OWNER_EMOJIS)
            : (userConfig.REACT_EMOJIS || config.REACT_EMOJIS);
          if (emojis?.length) {
            const emoji = emojis[Math.floor(Math.random() * emojis.length)];
            enqueueReact(clean, () => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {}));
          }
        }
      } catch (e) {
        log(`messages.upsert error: ${e.message}`, 'error');
      }
    });

    // ========== PAIRING CODE (Heroku-safe) ==========
    if (!sock.authState.creds.registered) {
      await delay(4000); // socket ready hone do
      try {
        const code = await sock.requestPairingCode(clean);
        log(`📲 Pairing code for ${clean}: ${code}`, 'success');
        if (res && !res.headersSent) {
          return res.json({
            status: 'new_pairing',
            code,
            number: clean,
            message: 'WhatsApp → Linked Devices → Link with phone number → code enter karo. Server band mat karo. 30 sec wait karo.'
          });
        }
      } catch (e) {
        log(`Pairing code error: ${e.message}`, 'error');
        locks.delete(clean);
        sessions.delete(clean);
        if (res && !res.headersSent) {
          return res.status(500).json({ error: 'Failed to get pairing code', details: e.message });
        }
      }
    } else {
      if (res && !res.headersSent) {
        return res.json({ status: 'reconnecting', number: clean });
      }
    }

    return sock;

  } catch (e) {
    log(`startSession error ${clean}: ${e.message}`, 'error');
    await safeDisconnect(clean, null);
    locks.delete(clean);
    if (res && !res.headersSent) {
      res.status(503).json({ status: 'error', error: 'Failed to start session' });
    }
  }
}

async function autoReconnectAll() {
  try {
    const numbers = await getAllNumbers().catch(() => []);
    log(`Reconnect check: ${numbers.length} in DB, ${sessions.size} active`, 'info');

    for (const num of numbers) {
      const clean = num.replace(/[^0-9]/g, '');

      if (sessions.has(clean) && isSocketHealthy(sessions.get(clean))) {
        sessionLastActive.set(clean, Date.now());
        continue;
      }

      if (locks.has(clean) && Date.now() - locks.get(clean) < 120000) continue;

      const record = reconnectAttempts.get(clean);
      if (record) {
        const needed = getReconnectDelay(clean);
        if (Date.now() - record.lastAttempt < needed) continue;
      }

      if (getMemoryUsageMB() > MEMORY_LIMIT_MB - 50) {
        log('Memory high, skip more reconnects', 'warning');
        break;
      }

      await startSession(num).catch(e => log(`Auto-reconnect ${num}: ${e.message}`, 'error'));
      await delay(12000);
    }
  } catch (e) {
    log(`autoReconnectAll: ${e.message}`, 'error');
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 40, 60000)) {
    return res.status(429).json({ error: 'Too many requests' });
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
    if (!res.headersSent) res.status(500).json({ error: e.message });
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
  await removeNumber(clean).catch(() => {});
  await deleteSession(clean).catch(() => {});
  connectMsgSentFor.delete(clean);
  reconnectAttempts.delete(clean);
  res.json({ status: 'success', message: 'Disconnected' });
});

app.get('/active', (req, res) => {
  res.json({
    count: sessions.size,
    memoryMB: getMemoryUsageMB(),
    numbers: Array.from(sessions.keys())
  });
});

app.get('/ping', (req, res) => {
  res.json({
    status: 'active',
    message: `${config.BOT_NAME} is running 🔥`,
    activeSessions: sessions.size,
    memoryMB: getMemoryUsageMB(),
    uptime: Math.floor(process.uptime())
  });
});

app.get('/connect-all', async (req, res) => {
  try {
    const numbers = await getAllNumbers().catch(() => []);
    const results = [];
    for (const num of numbers) {
      const clean = num.replace(/[^0-9]/g, '');
      if (sessions.has(clean) && isSocketHealthy(sessions.get(clean))) {
        results.push({ number: num, status: 'already_connected' });
        continue;
      }
      await startSession(num).catch(() => {});
      results.push({ number: num, status: 'connection_initiated' });
      await delay(10000);
    }
    res.json({ status: 'success', total: numbers.length, connections: results });
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
});

async function main() {
  if (isMainRunning) {
    log('main() already running, skip', 'warning');
    return;
  }
  isMainRunning = true;

  try {
    if (!serverStarted) {
      const port = process.env.PORT || 8000;
      app.listen(port, () => log(`Server on port ${port}`, 'success'));
      serverStarted = true;
    }

    await connectMongo();
    await loadExternalPlugins();
    await autoReconnectAll();

    setInterval(() => checkMemory(), 60000);
    setInterval(() => checkIdleSessions(), 600000);
    setInterval(() => autoReconnectAll().catch(() => {}), 30 * 60 * 1000);

    setInterval(() => {
      const now = Date.now();
      for (const [ip, record] of requestCounts.entries()) {
        if (now - record.start > 120000) requestCounts.delete(ip);
      }
    }, 120000);

  } catch (e) {
    log(`Main error: ${e.message}`, 'error');
    isMainRunning = false;
    setTimeout(() => {
      isMainRunning = false;
      main();
    }, 30000);
  }
}

main();

process.on('SIGINT', async () => {
  log('SIGINT — shutting down...', 'warning');
  for (const [clean, sock] of sessions) await safeDisconnect(clean, sock);
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('SIGTERM — shutting down...', 'warning');
  for (const [clean, sock] of sessions) await safeDisconnect(clean, sock);
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  log(`Uncaught: ${e.message}`, 'error');
});

process.on('unhandledRejection', (e) => {
  log(`Unhandled rejection: ${e?.message || e}`, 'error');
});

export default app;
