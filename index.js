require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');
const axios = require('axios');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ==========================================
// ⚙️ CONFIGURATION
// ==========================================
// Paste your Token & Key here or use Railway Variables
const TOKEN = process.env.DISCORD_TOKEN; 
const RAPID_API_KEY = process.env.RAPID_API_KEY || "5b4b9109camsh07781293c710eeap18bc01jsn25a0b784c6ec";
const RAPID_HOST = "twitter241.p.rapidapi.com";
const SUPER_ADMIN_ID = "1442310589362999428"; // You
const VERSION = "v6.0 (JS/SQLite)";

// 📂 DATABASE SETUP (Persistent Volume)
// We check if /dataaa exists (Railway Volume), otherwise use local folder
const DATA_DIR = fs.existsSync('/dataaa') ? '/dataaa' : './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'raid.db');
const db = new Database(dbPath);

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    handle TEXT,
    numeric_id TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ==========================================
// 🤖 BOT SETUP
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Runtime Memory (Cleared on Restart, but Users are Safe in DB)
let sessionTweets = new Map(); // TweetID -> UserID

// ==========================================
// 💾 DATABASE HELPERS
// ==========================================
function getUser(discordId) {
    return db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
}

function saveUser(discordId, handle, numericId) {
    const stmt = db.prepare('INSERT OR REPLACE INTO users (discord_id, handle, numeric_id) VALUES (?, ?, ?)');
    stmt.run(discordId, handle, numericId);
}

function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
}

function setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// ==========================================
// 📡 API ENGINE (NUCLEAR SEARCH)
// ==========================================
// This finds a key (like 'rest_id' or 'in_reply_to_status_id') anywhere in the JSON
function findValuesByKey(obj, key, list = []) {
    if (!obj) return list;
    if (Array.isArray(obj)) {
        for (let i of obj) findValuesByKey(i, key, list);
    } else if (typeof obj === 'object') {
        for (let k in obj) {
            if (k === key && obj[k]) list.push(String(obj[k]));
            findValuesByKey(obj[k], key, list);
        }
    }
    return list;
}

// 1. GET USER ID (Using your Axios snippet)
async function getNumericId(username) {
    console.log(`🔍 Lookup ID for ${username}...`);
    const options = {
        method: 'GET',
        url: `https://${RAPID_HOST}/user`,
        params: { username: username },
        headers: {
            'x-rapidapi-key': RAPID_API_KEY,
            'x-rapidapi-host': RAPID_HOST
        }
    };

    try {
        const response = await axios.request(options);
        
        // Priority 1: rest_id
        let ids = findValuesByKey(response.data, 'rest_id');
        if (ids.length > 0) return ids[0];

        // Priority 2: id (Fallback)
        ids = findValuesByKey(response.data, 'id');
        for (let id of ids) {
            if (!isNaN(id) && id.length > 5) return id;
        }
    } catch (e) {
        console.error(`❌ API Error (ID): ${e.message}`);
    }
    return null;
}

// 2. CHECK REPLIES (Using your Axios snippet + Dynamic Count)
async function checkReplies(userNumericId, targetTweetIds) {
    if (!userNumericId) return 0;

    // Dynamic Count: Participants + 20 Buffer
    let fetchCount = targetTweetIds.length + 20;
    if (fetchCount < 20) fetchCount = 20;
    if (fetchCount > 100) fetchCount = 100;

    const options = {
        method: 'GET',
        url: `https://${RAPID_HOST}/user-replies-v2`,
        params: {
            user: userNumericId,
            count: String(fetchCount)
        },
        headers: {
            'x-rapidapi-key': RAPID_API_KEY,
            'x-rapidapi-host': RAPID_HOST
        }
    };

    try {
        const response = await axios.request(options);

        // NUCLEAR SEARCH: Find ALL reply IDs in the response
        const foundIds = new Set();
        
        // Collect 'in_reply_to_status_id_str'
        const strIds = findValuesByKey(response.data, 'in_reply_to_status_id_str');
        strIds.forEach(id => foundIds.add(String(id)));
        
        // Collect 'in_reply_to_status_id' (Backup)
        const numIds = findValuesByKey(response.data, 'in_reply_to_status_id');
        numIds.forEach(id => foundIds.add(String(id)));

        // Compare matches
        let matches = 0;
        for (let target of targetTweetIds) {
            if (foundIds.has(target)) matches++;
        }
        return matches;

    } catch (e) {
        console.error(`❌ API Error (Replies): ${e.message}`);
        return 0;
    }
}

// ==========================================
// 📅 SESSION MANAGERS
// ==========================================
async function openSession() {
    sessionTweets.clear();
    const channelId = getSetting('channel_id');
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    // Unlock Channel
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });

    const embed = new EmbedBuilder()
        .setTitle("🟢 RAID SESSION OPEN")
        .setDescription("Post your links! Reply to everyone!\nType `!register @username` if you are new.")
        .setColor(0x00FF00);

    await channel.send({ embeds: [embed] });
}

async function closeAndReport() {
    const channelId = getSetting('channel_id');
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    // Lock Channel
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });

    const targets = Array.from(sessionTweets.keys());
    if (targets.length === 0) {
        return channel.send("🔴 Session ended. No links posted.");
    }

    let checkCount = targets.length + 20;
    if(checkCount > 100) checkCount = 100;

    await channel.send(`⏳ **Checking last ${checkCount} replies for ${sessionTweets.size} participants...**`);

    const results = [];
    const participants = new Set(sessionTweets.values());

    for (let userId of participants) {
        let user = getUser(userId);
        let score = 0;
        let handle = user ? user.handle : "Unknown";

        // Logic: Retry ID lookup if missing or if handle exists but no ID
        if (!user || !user.numeric_id) {
            if (user && user.handle) {
                const nid = await getNumericId(user.handle);
                if (nid) {
                    saveUser(userId, user.handle, nid);
                    user = getUser(userId); // Refresh
                }
            }
        }

        // If we have an ID, check score
        if (user && user.numeric_id) {
            score = await checkReplies(user.numeric_id, targets);
            // Cap score at max targets (sanity check)
            if (score > targets.length) score = targets.length;
        }

        results.push({ id: userId, handle, score });
    }

    // Sort High to Low
    results.sort((a, b) => b.score - a.score);

    // Generate Report
    const dateStr = new Date().toISOString().split('T')[0];
    
    // Header
    let report = `═══════════════════════════════════════\n📊 ELITE YAPPERS REPORT — ${dateStr}\n═══════════════════════════════════════\n\n📈 STATISTIK\n▸ Total tweet dicek: ${targets.length}\n▸ Total pengirim: ${results.length}\n▸ Self-reply: tidak diwajibkan\n\n🔍 STATUS REPLIES\n✅ Sudah full reply:`;

    let req = targets.length - 1; // You don't reply to yourself
    if (req < 1) req = 1;

    for (let p of results) {
        let pct = Math.floor((p.score / req) * 100);
        if (pct > 100) pct = 100;
        
        // Add emoji for full score
        const prefix = pct >= 100 ? "  ▸" : "  ⚠️";
        report += `\n${prefix} <@${p.id}> — ${p.score}/${req} (${pct}%)`;
    }
    report += `\n═══════════════════════════════════════`;

    const embed = new EmbedBuilder()
        .setTitle("🔴 SESSION CLOSED")
        .setDescription(`Checked ${results.length} users.`)
        .setColor(0xFF0000);

    await channel.send({ embeds: [embed] });
    
    // Chunking for Discord limit (2000 chars)
    if (report.length > 1900) {
        const chunks = report.match(/[\s\S]{1,1900}/g) || [];
        for (const chunk of chunks) {
            await channel.send(chunk);
        }
    } else {
        await channel.send(report);
    }
}

// ==========================================
// 🛠️ COMMANDS
// ==========================================
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // 1. Link Collector (Passive)
    const channelId = getSetting('channel_id');
    if (channelId && message.channel.id === channelId) {
        const match = message.content.match(/status\/(\d+)/);
        if (match) {
            sessionTweets.set(match[1], message.author.id);
            await message.react('👀');
        }
    }

    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // REGISTER
    if (command === 'register') {
        if (!args[0]) return message.reply("Usage: `!register @username`");
        const handle = args[0].replace('@', '').trim();
        const msg = await message.reply(`🔄 Linking @${handle}...`);

        const nid = await getNumericId(handle);
        saveUser(message.author.id, handle, nid || null);

        if (nid) await msg.edit(`✅ Registered @${handle} (ID: ${nid})`);
        else await msg.edit(`⚠️ Registered @${handle} (ID lookup failed - will retry during raid)`);
    }

    // VERSION
    if (command === 'version') {
        return message.reply(`🤖 Bot Version: **${VERSION}**`);
    }

    // DIAGNOSE
    if (command === 'diagnose') {
        if (!args[0]) return message.reply("Usage: `!diagnose @username`");
        const handle = args[0].replace('@', '');
        await message.reply(`🕵️ Running Diagnosis for @${handle}...`);

        const nid = await getNumericId(handle);
        if (!nid) return message.channel.send("❌ ID Lookup Failed.");

        message.channel.send(`✅ Found ID: \`${nid}\`. Checking replies...`);
        
        try {
            const options = {
                method: 'GET',
                url: `https://${RAPID_HOST}/user-replies-v2`,
                params: { user: nid, count: '20' },
                headers: { 'x-rapidapi-key': RAPID_API_KEY, 'x-rapidapi-host': RAPID_HOST }
            };
            const response = await axios.request(options);
            
            const ids = new Set();
            findValuesByKey(response.data, 'in_reply_to_status_id_str', Array.from(ids)).forEach(id => ids.add(String(id)));
            
            if (ids.size === 0) message.channel.send("⚠️ API returned valid JSON but NO replies found.");
            else message.channel.send(`✅ API Healthy. Found ${ids.size} replies in last 20 tweets.\nSample IDs: ${Array.from(ids).slice(0, 3).join(', ')}`);
        } catch (e) {
            message.channel.send(`❌ API Error: ${e.message}`);
        }
    }

    // ADMIN COMMANDS
    let isAdmin = message.author.id === SUPER_ADMIN_ID;
    if (!isAdmin) {
        const roleId = getSetting('admin_role_id');
        if (roleId && message.member.roles.cache.has(roleId)) isAdmin = true;
        if (message.member.permissions.has('Administrator')) isAdmin = true;
    }

    if (!isAdmin) return;

    if (command === 'setchannel') {
        const channel = message.mentions.channels.first();
        if (!channel) return message.reply("Tag a channel.");
        setSetting('channel_id', channel.id);
        message.reply(`✅ Channel set to ${channel}`);
    }

    if (command === 'setrole') {
        const role = message.mentions.roles.first();
        if (!role) return message.reply("Tag a role.");
        setSetting('admin_role_id', role.id);
        message.reply(`✅ Admin role set to ${role.name}`);
    }

    if (command === 'start' || command === 'forceraid') {
        message.reply("🚀 Force starting session...");
        openSession();
    }

    if (command === 'end' || command === 'forceclose') {
        message.reply("🛑 Ending session...");
        closeAndReport();
    }
});

// ==========================================
// ⏰ SCHEDULER (Cron)
// ==========================================
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag} - ${VERSION}`);
    
    // Times: 8:00, 14:00, 21:00 UTC
    const times = ["0 8 * * *", "0 14 * * *", "0 21 * * *"];
    
    times.forEach(t => {
        cron.schedule(t, () => {
            console.log("⏰ Auto-Starting Session");
            openSession();
            
            // Schedule Close 60 mins later
            setTimeout(() => {
                console.log("⏰ Auto-Closing Session");
                closeAndReport();
            }, 60 * 60 * 1000);
        });
    });
});

client.login(TOKEN);
