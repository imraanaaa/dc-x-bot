require('dotenv').config();
// 1. IMPORT BUTTON TOOLS
const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    Partials, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    ComponentType 
} = require('discord.js');
const axios = require('axios');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ==========================================
// ⚙️ CONFIGURATION
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN; 
const RAPID_API_KEY = process.env.RAPID_API_KEY || "5b4b9109camsh07781293c710eeap18bc01jsn25a0b784c6ec";
const RAPID_HOST = "twitter241.p.rapidapi.com";
const SUPER_ADMIN_ID = "1442310589362999428"; 
const VERSION = "v8.0 (Permanent Registration)";

// 📂 DATABASE SETUP
const DATA_DIR = fs.existsSync('/dataaa') ? '/dataaa' : './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'raid.db');
const db = new Database(dbPath);

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

let sessionTweets = new Map();

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
// 📡 API ENGINE
// ==========================================
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

async function getNumericId(username) {
    console.log(`🔍 Lookup ID for ${username}...`);
    const options = {
        method: 'GET',
        url: `https://${RAPID_HOST}/user`,
        params: { username: username },
        headers: { 'x-rapidapi-key': RAPID_API_KEY, 'x-rapidapi-host': RAPID_HOST }
    };

    try {
        const response = await axios.request(options);
        let ids = findValuesByKey(response.data, 'rest_id');
        if (ids.length > 0) return ids[0];
        ids = findValuesByKey(response.data, 'id');
        for (let id of ids) { if (!isNaN(id) && id.length > 5) return id; }
    } catch (e) {
        console.error(`❌ API Error (ID): ${e.message}`);
    }
    return null;
}

async function checkReplies(userNumericId, targetTweetIds) {
    if (!userNumericId) return 0;
    let fetchCount = targetTweetIds.length + 20;
    if (fetchCount < 20) fetchCount = 20;
    if (fetchCount > 100) fetchCount = 100;

    const options = {
        method: 'GET',
        url: `https://${RAPID_HOST}/user-replies-v2`,
        params: { user: userNumericId, count: String(fetchCount) },
        headers: { 'x-rapidapi-key': RAPID_API_KEY, 'x-rapidapi-host': RAPID_HOST }
    };

    try {
        const response = await axios.request(options);
        const foundIds = new Set();
        findValuesByKey(response.data, 'in_reply_to_status_id_str', Array.from(foundIds)).forEach(id => foundIds.add(String(id)));
        findValuesByKey(response.data, 'in_reply_to_status_id', Array.from(foundIds)).forEach(id => foundIds.add(String(id)));

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

    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });

    const embed = new EmbedBuilder()
        .setTitle("🟢 RAID SESSION OPEN")
        .setDescription("Post your link (Only 1 per person)!\nReply to everyone else!\n**Unregistered users cannot post.**")
        .setColor(0x00FF00);

    await channel.send({ embeds: [embed] });
}

async function closeAndReport() {
    const channelId = getSetting('channel_id');
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });

    const targets = Array.from(sessionTweets.keys());
    if (targets.length === 0) return channel.send("🔴 Session ended. No links posted.");

    let checkCount = targets.length + 20;
    if(checkCount > 100) checkCount = 100;

    await channel.send(`⏳ **Checking last ${checkCount} replies for ${sessionTweets.size} participants...**`);

    const results = [];
    const participants = new Set(sessionTweets.values());

    for (let userId of participants) {
        let user = getUser(userId);
        let score = 0;
        let handle = user ? user.handle : "Unknown";

        if (user && user.numeric_id) {
            score = await checkReplies(user.numeric_id, targets);
            if (score > targets.length) score = targets.length;
        }
        results.push({ id: userId, handle, score });
    }

    results.sort((a, b) => b.score - a.score);

    const dateStr = new Date().toISOString().split('T')[0];
    let report = `═══════════════════════════════════════\n📊 ELITE RAID REPORT — ${dateStr}\n═══════════════════════════════════════\n\n📈 STATISTICS\n▸ Total Tweets: ${targets.length}\n▸ Participants: ${results.length}\n▸ Self-reply: Not Required\n\n🔍 STATUS\n✅ 100% Completed:`;

    let req = targets.length - 1;
    if (req < 1) req = 1;

    for (let p of results) {
        let pct = Math.floor((p.score / req) * 100);
        if (pct > 100) pct = 100;
        const prefix = pct >= 100 ? "  ▸" : "  ⚠️";
        report += `\n${prefix} <@${p.id}> — ${p.score}/${req} (${pct}%)`;
    }
    report += `\n═══════════════════════════════════════`;

    const embed = new EmbedBuilder()
        .setTitle("🔴 SESSION CLOSED")
        .setDescription(`Checked ${results.length} users.`)
        .setColor(0xFF0000);

    await channel.send({ embeds: [embed] });
    
    if (report.length > 1900) {
        const chunks = report.match(/[\s\S]{1,1900}/g) || [];
        for (const chunk of chunks) await channel.send(chunk);
    } else {
        await channel.send(report);
    }
}

// ==========================================
// 🛠️ COMMANDS & LOGIC
// ==========================================
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // 1. LINK COLLECTOR
    const channelId = getSetting('channel_id');
    if (channelId && message.channel.id === channelId) {
        const match = message.content.match(/status\/(\d+)/);
        if (match) {
            const user = getUser(message.author.id);
            if (!user) {
                try {
                    await message.delete();
                    const warning = await message.channel.send(`<@${message.author.id}> ⚠️ **Unregistered!** Type \`!register @username\` in another channel.`);
                    setTimeout(() => warning.delete().catch(() => {}), 5000);
                } catch (e) {}
                return;
            }

            const currentParticipants = Array.from(sessionTweets.values());
            if (currentParticipants.includes(message.author.id)) {
                try {
                    await message.delete();
                    const warning = await message.channel.send(`<@${message.author.id}> ⚠️ **One link per session!**`);
                    setTimeout(() => warning.delete().catch(() => {}), 5000);
                } catch (e) {}
                return;
            }

            sessionTweets.set(match[1], message.author.id);
            await message.react('✅');
        }
    }

    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ==================================================
    // 🔐 REGISTER (WITH CONFIRMATION)
    // ==================================================
    if (command === 'register') {
        // 1. Check PERMANENT Lock
        const existing = getUser(message.author.id);
        if (existing) {
            return message.reply(`❌ **You are already registered** as \`@${existing.handle}\`.\nThis **cannot** be changed.`);
        }

        if (!args[0]) return message.reply("Usage: `!register @username`");
        const handle = args[0].replace('@', '').trim();
        
        // 2. Lookup first
        const initMsg = await message.reply(`🔍 verifying @${handle}...`);
        const nid = await getNumericId(handle);

        if (!nid) {
            return initMsg.edit(`❌ Could not find user **@${handle}** on Twitter/X.\nPlease check spelling and try again.`);
        }

        // 3. Ask for Confirmation (Buttons)
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_reg')
                    .setLabel('Confirm')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('cancel_reg')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Danger),
            );

        const confirmMsg = await initMsg.edit({
            content: `⚠️ **CONFIRM REGISTRATION**\n\nDiscord: <@${message.author.id}>\nX Handle: **@${handle}** (ID: ${nid})\n\n**Once you click Confirm, you CANNOT change this.**`,
            components: [row]
        });

        // 4. Handle Button Click
        const collector = confirmMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 30000 });

        collector.on('collect', async i => {
            if (i.user.id !== message.author.id) {
                return i.reply({ content: 'This is not for you.', ephemeral: true });
            }

            if (i.customId === 'confirm_reg') {
                saveUser(message.author.id, handle, nid);
                await i.update({ content: `✅ **Successfully Registered!**\nYou are permanently linked to **@${handle}**.`, components: [] });
            } else {
                await i.update({ content: `🚫 Registration Cancelled.`, components: [] });
            }
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                confirmMsg.edit({ content: '⏳ Registration timed out.', components: [] }).catch(() => {});
            }
        });
    }

    // ==================================================
    // 🛠️ OTHER COMMANDS
    // ==================================================
    if (command === 'version') return message.reply(`🤖 Bot Version: **${VERSION}**`);

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
            else message.channel.send(`✅ API Healthy. Found ${ids.size} replies.`);
        } catch (e) { message.channel.send(`❌ API Error: ${e.message}`); }
    }

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

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag} - ${VERSION}`);
    const times = ["0 8 * * *", "0 14 * * *", "0 21 * * *"];
    times.forEach(t => {
        cron.schedule(t, () => {
            console.log("⏰ Auto-Starting Session");
            openSession();
            setTimeout(() => {
                console.log("⏰ Auto-Closing Session");
                closeAndReport();
            }, 60 * 60 * 1000);
        });
    });
});

client.login(TOKEN);
