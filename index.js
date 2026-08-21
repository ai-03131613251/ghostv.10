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

const sessions = new Map();
const sessionStartedAt = new Map();
const locks = new Map();
const connectMsgSentFor = new Set();
const reconnectAttempts = new Map();
const sessionReadyAt = new Map();

const LINK_REGEX = /(chat\.whatsapp\.com\/\S+)|(whatsapp\.com\/channel\/\S+)/i;
let NEWSLETTER_REACT_JIDS = [];
const NEWSLETTER_REACT_EMOJIS = ['❤️', '👍', '😮', '😎', '😘', '🔥', '✨', '💖', '🤍', '🥀', '💫', '🌸', '⚡', '🤝', '🎉', '🥺', '😍', '😈', '🤖', '👀', '💯', '🎶', '🖤', '💥', '🌟', '😴', '🫶', '🍂', '☠️', '🌈', '🦋', '💎', '🎧', '📸', '🚀', '😏', '🤩', '🌹', '🎭', '🕊️', '🐼', '🐣', '🌙', '☁️', '🍁', '🎀', '🧸', '🍓', '🍒', '🌼', '🎯', '🏆', '🪐', '🌊', '🐉', '😜', '💌', '📍', '🎵', '🕶️', '🪄', '💋', '🌺', '🍀'];
const reactQueues = new Map();

// -------- Helpers --------
function log(msg, level = 'info') {
  const icons = { info: '📝', success: '✅', error: '❌', warning: '⚠️', debug: '🐛' };
  console.log(`${icons[level] || '📝'} [GHOST-MD] ${new Date().toISOString()}: ${msg}`);
}

async function fetchRawText(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    log(`Failed to fetch ${url}: ${e.message}`, 'error');
    return null;
  }
}

// -------- Plugin Loading --------
async function loadExternalPlugins() {
  log('Loading external plugins from GitHub...');
  const tempDir = path.join(__dirname, '.temp_plugins');
  await fs.ensureDir(tempDir);

  try {
    const res = await fetch('https://api.github.com/repos/ai-03131613251/sabkabapai/contents/plugins');
    if (!res.ok) throw new Error('GitHub API failed');
    const files = (await res.json()).filter(f => f.name.endsWith('.js')).map(f => f.name);

    if (!files.length) {
      log('No plugins found via API.', 'warning');
      return;
    }

    commands.length = 0;
    for (const file of files) {
      const raw = await fetchRawText(`https://raw.githubusercontent.com/ai-03131613251/sabkabapai/main/plugins/${file}`);
      if (!raw) continue;
      const localPath = path.join(tempDir, file);
      await fs.writeFile(localPath, raw);
      await import(`${localPath}?update=${Date.now()}`);
      log(`Loaded plugin: ${file}`, 'success');
    }
    log(`Total commands: ${commands.length}`, 'success');
  } catch (e) {
    log(`Plugin load error: ${e.message}`, 'error');
  }
}

// -------- Newsletter & Reaction --------
let newsletterManager = null;
async function loadNewslettersManager() { /* same as original — simplified */ }

async function loadFollowRepo() { /* simplified */ }

async function loadReactionRepo() { /* simplified */ }

function enqueueReact(sessionId, fn) {
  if (!reactQueues.has(sessionId)) reactQueues.set(sessionId, { queue: [], processing: false });
  const q = reactQueues.get(sessionId);
  if (q.queue.length >= 15) return;
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
    await delay(350);
  }
  q.processing = false;
}

// -------- Session Management --------
function isConnected(number) {
  return sessions.has(number.replace(/[^0-9]/g, ''));
}

function connectionStatus(number) {
  const clean = number.replace(/[^0-9]/g, '');
  const started = sessionStartedAt.get(clean);
  return {
    isConnected: sessions.has(clean),
    connectionTime: started ? new Date(started).toLocaleString() : null,
    uptime: started ? Math.floor((Date.now() - started) / 1000) : 0
  };
}

function isReconnectingTooFast(number) {
  const now = Date.now();
  const record = reconnectAttempts.get(number);
  if (!record || now - record.windowStart > 60000) {
    reconnectAttempts.set(number, { count: 1, windowStart: now });
    return false;
  }
  record.count++;
  if (record.count > 5) {
    log(`Number ${number} reconnected ${record.count} times in 1min — backing off`, 'warning');
    return true;
  }
  return false;
}

async function startSession(number, res = null) {
  const clean = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(__dirname, 'session', `session_${clean}`);

  if (sessions.has(clean)) {
    if (res && !res.headersSent) return res.json({ status: 'already_connected', ...connectionStatus(clean) });
    return;
  }

  if (locks.has(clean) && Date.now() - locks.get(clean) < 30000) {
    if (res && !res.headersSent) return res.json({ status: 'connection_in_progress' });
    return;
  }
  locks.set(clean, Date.now());

  try {
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
      logger: console,
      version,
      browser: Browsers.macOS('Safari'),
      markOnlineOnConnect: true,
      syncFullHistory: false
    });

    await addConnectionFunctions(sock);
    sessionStartedAt.set(clean, Date.now());

    // Load user config
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

    // Creds update
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      const creds = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
      await saveSession(clean, JSON.parse(creds));
    });

    // Anti-delete
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (update.update?.message === null) {
          await AntiDelete(sock, [update], clean).catch(() => {});
        }
      }
    });

    // Connection
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        sessions.set(clean, sock);
        log(`Connected: ${clean}`, 'success');
        await addNumber(clean);
        sessionReadyAt.set(clean, Date.now());
        if (!connectMsgSentFor.has(clean)) {
          connectMsgSentFor.add(clean);
          // Send welcome message, follow newsletters, etc.
        }
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        sessions.delete(clean);
        sessionStartedAt.delete(clean);
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
        sock.ev.removeAllListeners();
        const backoff = isReconnectingTooFast(clean) ? 30000 : 5000;
        await delay(backoff);
        locks.delete(clean);
        startSession(clean).catch(e => log(`Reconnect failed: ${e.message}`, 'error'));
      }
    });

    // Anti-call
    sock.ev.on('call', async (calls) => {
      const config = sock.userConfig;
      if (config.ANTI_CALL !== 'true') return;
      for (const call of calls) {
        if (call.status === 'offer') {
          await sock.rejectCall(call.id, call.from);
          await sock.sendMessage(call.from, { text: config.REJECT_MSG || config.REJECT_MSG });
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

    // Messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
      let msg = messages[0];
      if (!msg?.message) return;

      // Handle ephemeral
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
          await sock.readMessages([msg.key]);
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
              await sock.sendMessage(jid, { delete: msg.key });
              await sock.sendMessage(jid, { text: `🚫 @${senderNumber} sent a link and was removed.`, mentions: [sender] });
              await sock.groupParticipantsUpdate(jid, [sender], 'remove');
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

      // Auto-react
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
    sessions.delete(clean);
    sessionStartedAt.delete(clean);
    if (res && !res.headersSent) {
      res.status(503).json({ status: 'error', error: 'Failed to start session' });
    }
    throw e;
  } finally {
    locks.delete(clean);
  }
}

// -------- Auto Reconnect --------
async function autoReconnectAll() {
  try {
    const numbers = await getAllNumbers();
    for (const num of numbers) {
      if (sessions.has(num)) continue;
      locks.delete(num);
      await startSession(num).catch(e => log(`Auto-reconnect failed for ${num}: ${e.message}`, 'error'));
      await delay(2000);
    }
  } catch (e) {
    log(`autoReconnectAll error: ${e.message}`, 'error');
  }
}

// -------- Express Server --------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const html = path.join(__dirname, 'public', 'pair.html');
  if (fs.existsSync(html)) return res.sendFile(html);
  res.send('GHOST-MD is running 🔥');
});

app.get('/code', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).json({ error: 'Number required' });
  if (sessions.size >= 50) return res.status(429).json({ error: 'Server full', message: 'Max 50 active sessions' });
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
      connections: Array.from(sessions.keys()).map(n => ({ number: n, ...connectionStatus(n) }))
    });
  }
  res.json({ number, ...connectionStatus(number) });
});

app.get('/disconnect', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).json({ error: 'Number required' });
  const clean = number.replace(/[^0-9]/g, '');
  const sock = sessions.get(clean);
  if (!sock) return res.status(404).json({ error: 'Not found' });
  try {
    sock.ws.close();
    sock.ev.removeAllListeners();
    sessions.delete(clean);
    sessionStartedAt.delete(clean);
    await removeNumber(clean);
    await deleteSession(clean);
    connectMsgSentFor.delete(clean);
    reconnectAttempts.delete(clean);
    res.json({ status: 'success', message: 'Disconnected' });
  } catch {
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

app.get('/active', (req, res) => {
  res.json({ count: sessions.size, numbers: Array.from(sessions.keys()) });
});

app.get('/ping', (req, res) => {
  res.json({ status: 'active', message: `${config.BOT_NAME} is running 🔥`, activeSessions: sessions.size });
});

app.get('/connect-all', async (req, res) => {
  try {
    const numbers = await getAllNumbers();
    const results = [];
    for (const num of numbers) {
      if (sessions.has(num)) {
        results.push({ number: num, status: 'already_connected' });
        continue;
      }
      await startSession(num).catch(() => {});
      results.push({ number: num, status: 'connection_initiated' });
      await delay(1000);
    }
    res.json({ status: 'success', total: numbers.length, connections: results });
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
});

// -------- React Endpoint --------
app.get('/react', async (req, res) => {
  const { link, emojis } = req.query;
  if (!link) return res.status(400).json({ status: 'error', message: 'link parameter required' });
  if (!sessions.size) return res.status(404).json({ status: 'error', message: 'No active sessions' });

  let reactEmojis = emojis ? emojis.split(',').filter(Boolean) : NEWSLETTER_REACT_EMOJIS;
  if (!reactEmojis.length) reactEmojis = NEWSLETTER_REACT_EMOJIS;

  let inviteCode = null, serverId = null, targetJid = null;

  // Parse URL
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

      let retries = 3, success = false;
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
          await delay(2000 * (3 - retries));
        }
      }
    } catch (err) {
      results.push({ number, status: 'failed', error: err.message });
    }
    if (i < entries.length - 1) await delay(3000);
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

// -------- Start --------
let serverStarted = false;

async function main() {
  try {
    if (!serverStarted) {
      const port = process.env.PORT || 8000;
      app.listen(port, () => log(`Server listening on port ${port}`, 'success'));
      serverStarted = true;
    }

    await connectMongo();
    await loadExternalPlugins();
    // await loadNewslettersManager();
    // await loadFollowRepo();
    // await loadReactionRepo();
    await autoReconnectAll();

    setInterval(() => autoReconnectAll().catch(() => {}), 600000);
  } catch (e) {
    log(`Main crashed: ${e.message}`, 'error');
    await delay(5000);
    main();
  }
}

main();

// -------- Process Handlers --------
process.on('SIGINT', () => {
  for (const [, sock] of sessions) sock.ev.removeAllListeners();
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const [, sock] of sessions) sock.ev.removeAllListeners();
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  log(`Uncaught exception: ${e.message}`, 'error');
  setTimeout(main, 3000);
});

process.on('unhandledRejection', (e) => {
  log(`Unhandled rejection: ${e?.message}`, 'error');
  setTimeout(main, 3000);
});

export default app;
