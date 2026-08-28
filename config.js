// config.js - ESM Version (Baileys 7 ready)
import dotenv from 'dotenv';
dotenv.config();

const config = {
    // MongoDB Configuration
    MONGODB_URL: process.env.MONGODB_URL || 'mongodb+srv://malikgf:malikgf@cluster0.e806lad.mongodb.net/?appName=Cluster0',
    DB_NAME: process.env.DB_NAME || 'minibot',
    
    COLLECTIONS: {
        SESSIONS: 'whatsapp_sessions',
        NUMBERS: 'active_numbers',
        CONFIGS: 'bot_configs'
    },
    
    // Bot Configuration
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'false',
    MENTION_REPLY: 'false',
    AUTO_RECORDING: 'false',
    AUTO_REACT: 'false',
    AUTO_TYPING: 'false',
    ALWAYS_ONLINE: 'false',
    VERSION: '1.5.0',
    DESCRIPTION: '*© ᴘᴏᴡᴇʀᴇᴅ ʙʏ 𝐌ᴀғɪᴀ 𝐀ᴅᴇᴇʟ*',
    ANTI_DELETE_PATH: 'inbox',
    ANTI_DELETE: 'false',
    ANTI_EDIT_PATH: 'inbox',
    ANTI_EDIT: 'false',
    STICKER_NAME: '𝐆ʜᴏsᴛ-𝐌ᴅ',
    ANTI_LINK: 'true',
    WELCOME: 'false',
    GOODBYE: 'false',
    WELCOME_MESSAGE: '*_@user joined the group, welcome! 🎉_*',
    GOODBYE_MESSAGE: '*_@user has left the group, we will miss them! 👋_*',
    ADMIN_ACTION: 'false',
    MODE: 'public',
    PREFIX: '.',
    ANTI_CALL: 'false',
    REJECT_MSG: '*Call Rejected Automatically 📵*',
    READ_MESSAGE: 'false',
    AUTO_STATUS_SEEN: 'true',
    OWNER_REACT: 'false',
    OWNER_EMOJIS: ['❤️', '🔥', '👑', '⭐', '💎'],
    REACT_EMOJIS: ['😂', '❤️', '🔥', '👏', '😮', '😢', '🙃', '👍', '🎉', '🤔', '🙏', '😍', '😊', '🥰', '💕', '🤩', '✨', '😎', '🥳', '🙌'],
    LIKE_EMOJIS: ['❤️', '👍', '😮', '😎', '💀'],
    
    // Bot Identity
    BOT_NAME: '𝐆ʜᴏsᴛ-𝐌ᴅ',
    OWNER_NAME: '𝐌ᴀғɪᴀ 𝐀ᴅᴇᴇʟ',
    OWNER_NUMBER: '923174838990',
    DEV: '923131613251',
    IK_IMAGE_PATH: './lib/ERFAN.jpg',
    BOT_IMAGE: 'https://files.catbox.moe/pb5yiz.jpg',
    
    // Newsletter
    NEWSLETTER_JID: '120363404811118873@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    
    // System
    MAX_RETRIES: 3,
    OTP_EXPIRY: 300000,
    ADMIN_LIST_PATH: './admin.json',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbC15ycFHWpubqmNWe0N',
    BANNED: [],
    SUDO: ["48503753592860@lid", "923306137477@s.whatsapp.net"],
    
    // Default Settings Template
    DEFAULT_SETTINGS: {
        AUTO_VIEW_STATUS: 'true',
        AUTO_LIKE_STATUS: 'false',
        MENTION_REPLY: 'false',
        AUTO_STATUS_SEEN: 'true',
        READ_MESSAGE: 'false',
        AUTO_RECORDING: 'false',
        AUTO_REACT: 'false',
        AUTO_TYPING: 'false',
        ALWAYS_ONLINE: 'false',
        OWNER_REACT: 'false',
        ANTI_DELETE: 'false',
        ANTI_DELETE_PATH: 'inbox',
        ANTI_EDIT: 'false',
        ANTI_EDIT_PATH: 'inbox',
        ANTI_CALL: 'false',
        ANTI_LINK: 'true',
        WELCOME: 'false',
        GOODBYE: 'false',
        ADMIN_ACTION: 'false',
        WELCOME_MESSAGE: '*_@user joined the group, welcome! 🎉_*',
        GOODBYE_MESSAGE: '*_@user has left the group, we will miss them! 👋_*',
        REJECT_MSG: '*Call Rejected Automatically 📵*',
        VERSION: '1.5.0',
        OWNER_NAME: '𝐌ᴀғɪᴀ 𝐀ᴅᴇᴇʟ',
        OWNER_NUMBER: '923174838990',
        DEV: '923131613251',
        DESCRIPTION: '*© ᴘᴏᴡᴇʀᴇᴅ ʙʏ 𝐌ᴀғɪᴀ 𝐀ᴅᴇᴇʟ*',
        STICKER_NAME: '𝐆ʜᴏsᴛ-𝐌ᴅ',
        MODE: 'public',
        PREFIX: '.',
        BOT_NAME: '𝐆ʜᴏsᴛ-𝐌ᴅ',
        BOT_IMAGE: 'https://files.catbox.moe/pb5yiz.jpg',
        REACT_EMOJIS: ['😂', '❤️', '🔥', '👏', '😮', '😢', '🙃', '👍', '🎉', '🤔', '🙏', '😍', '😊', '🥰', '💕', '🤩', '✨', '😎', '🥳', '🙌'],
        OWNER_EMOJIS: ['❤️', '🔥', '👑', '⭐', '💎'],
        LIKE_EMOJIS: ['❤️', '👍', '😮', '😎', '💀'],
        BANNED: [],
        SUDO: ["48503753592860@lid", "923306137477@s.whatsapp.net"]
    }
};

export default config;
