require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    Partials, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    ComponentType,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
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
const RAPID_API_KEY = process.env.RAPID_API_KEY; 
const RAPID_HOST = "twitter241.p.rapidapi.com";

// 👑 ADMIN LIST (Strict Access)
const SUPER_ADMINS = [
    "1442310589362999428", // Admin 1
    "1442618881285034099", // Admin 2
    "627327810079424533"   // Admin 3
];

// 🔔 ROLE TO TAG (1 min before)
const RAID_ROLE_ID = "1455184518104485950";

const VERSION = "v15.0 (Ultimate Blue)";

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
  CREATE TABLE IF NOT EXISTS session_activity (
    tweet_id TEXT PRIMARY KEY,
    discord_id TEXT
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

let activeCronJobs = []; 

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

function addSessionLink(tweetId, discordId) {
    db.prepare('INSERT OR REPLACE INTO session_activity (tweet_id, discord_id) VALUES (?, ?)').run(tweetId, discordId);
}

function getSessionLinks() {
    return db.prepare('SELECT * FROM session_activity').all(); 
}

function clearSession() {
    db.prepare('DELETE FROM session_activity').run();
}

function isUserInSession(discordId) {
    const row = db.prepare('SELECT 1 FROM session_activity WHERE discord_id = ?').get(discordId);
    return !!row;
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
    if (!RAPID_API_KEY) return console.error("❌ CRITICAL: RAPID_API_KEY missing!");
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
    } catch (e) { console.error(`❌ API ID Error: ${e.message}`); }
    return null;
}

async function checkReplies(userNumericId, targetTweetIds) {
    if (!userNumericId || !RAPID_API_KEY) return 0;
    let fetchCount = 100; 

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
        console.error(`❌ API Reply Error: ${e.message}`);
        return 0;
    }
}

// ==========================================
// 📅 SESSION MANAGERS
// ==========================================
async function sendWarning() {
    const channelId = getSetting('channel_id');
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    await channel.send(`🚨 <@&${RAID_ROLE_ID}> **WAKE UP!**\nSession starts in **1 minute**! Get your links ready! ⚡`);
}

async function openSession(triggerMsg = null) {
    clearSession();
    const channelId = getSetting('channel_id');
    if (!channelId) {
        if (triggerMsg) triggerMsg.reply("❌ **No Channel Set.**");
        return;
    }
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    try {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
    } catch (e) {
        if (triggerMsg) triggerMsg.reply("❌ **Permission Error:** Cannot unlock channel.");
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle("💎 RAID SESSION STARTED")
        .setDescription("⚡ **ENGAGEMENT PROTOCOL ACTIVE**\n\n1️⃣ Post your link (1 per person).\n2️⃣ Reply to everyone else.\n3️⃣ Only registered accounts allowed.")
        .setColor(0x00FFFF) // Cyan Blue
        .setImage("https://media1.tenor.com/m/X_3C6mCjUukAAAAC/twitter-x.gif"); // Optional X gif

    await channel.send({ content: `<@&${RAID_ROLE_ID}>`, embeds: [embed] });
}

// Helper to calculate next session timestamp
function getNextSessionTimestamp() {
    const now = new Date();
    const currentHour = now.getUTCHours();
    const h1 = parseInt(getSetting('session1_hour') || "8");
    const h2 = parseInt(getSetting('session2_hour') || "14");
    const h3 = parseInt(getSetting('session3_hour') || "21");
    
    let hours = [h1, h2, h3].sort((a,b) => a-b);
    let nextHour = hours.find(h => h > currentHour);
    
    // If no session later today, pick first session tomorrow
    let targetDate = new Date(now);
    if (nextHour === undefined) {
        nextHour = hours[0];
        targetDate.setDate(targetDate.getDate() + 1);
    }
    
    targetDate.setUTCHours(nextHour, 0, 0, 0);
    return Math.floor(targetDate.getTime() / 1000);
}

async function closeAndReport(triggerMsg = null) {
    const channelId = getSetting('channel_id');
    if (!channelId) return triggerMsg?.reply("❌ No Channel.");
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return triggerMsg?.reply("❌ Channel Not Found.");

    // 1. LOCK CHANNEL
    try {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
    } catch (e) {
        if (triggerMsg) triggerMsg.reply("❌ Lock Error.");
    }

    const sessionData = getSessionLinks();
    const nextTime = getNextSessionTimestamp();

    // 2. SEND "GREAT WORK" + NEXT SESSION INFO
    const closingEmbed = new EmbedBuilder()
        .setTitle("🔒 SESSION LOCKED")
        .setDescription(`**Great work, everyone!** 🚀\n\n📅 **Next Session:** <t:${nextTime}:R> (<t:${nextTime}:t>)`)
        .setColor(0x00008B); // Dark Blue

    await channel.send({ embeds: [closingEmbed] });

    if (sessionData.length === 0) return channel.send("⚠️ **No links were posted this session.**");

    // 3. SHOW PARTICIPANT COUNT
    await channel.send(`📊 **Analyzing ${sessionData.length} participants...**\n*Report generating in 1 minute...* ⏳`);

    // 4. WAIT 1 MINUTE
    setTimeout(async () => {
        const targets = sessionData.map(r => r.tweet_id);
        const results = [];
        const uniqueUsers = new Set(sessionData.map(r => r.discord_id));

        for (let userId of uniqueUsers) {
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

        // 5. GENERATE FANCY REPORT
        const dateStr = new Date().toISOString().split('T')[0];
        let req = targets.length - 1; 
        if (req < 1) req = 1;

        let completedList = "";
        let incompleteList = "";
        let completeCount = 0;

        for (let p of results) {
            let pct = Math.floor((p.score / req) * 100);
            if (pct > 100) pct = 100;

            if (pct >= 100) {
                completeCount++;
                completedList += `\n🔹 <@${p.id}> — **${p.score}/${req}**`;
            } else {
                const filled = Math.round((pct / 100) * 5);
                const empty = 5 - filled;
                const bar = "🟦".repeat(filled) + "⬛".repeat(empty);
                incompleteList += `\n🔸 <@${p.id}> — **${p.score}/${req}** ${bar} (${pct}%)`;
            }
        }

        let report = `
━━━━━━━━━━━━━━━━━━━━━━━━━━
💎 **ELITE RAID REPORT** — ${dateStr}
━━━━━━━━━━━━━━━━━━━━━━━━━━

🏆 **COMPLETED** (${completeCount})
${completedList || "  *(None)*"}

⚠️ **INCOMPLETE**
${incompleteList || "  *(All Cleared!)*"}

━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
        const reportEmbed = new EmbedBuilder()
            .setTitle("📊 FINAL PERFORMANCE REPORT")
            .setDescription(report)
            .setColor(0x1E90FF) // Dodger Blue
            .setFooter({ text: `Total Links: ${targets.length} | Checked in strict mode` })
            .setTimestamp();

        await channel.send({ embeds: [reportEmbed] });
    }, 60000); // 60 Seconds Delay
}

// ==========================================
// ⏰ SCHEDULER
// ==========================================
function rescheduleCrons() {
    activeCronJobs.forEach(job => job.stop());
    activeCronJobs = [];

    const h1 = getSetting('session1_hour') || "8";
    const h2 = getSetting('session2_hour') || "14";
    const h3 = getSetting('session3_hour') || "21";

    [h1, h2, h3].forEach(h => {
        let hour = parseInt(h);
        
        // 1. Session Start (Hour H)
        const startJob = cron.schedule(`0 ${hour} * * *`, () => {
            console.log(`⏰ Starting Session (Hour: ${hour})`);
            openSession();
            // Auto close after 1 hour
            setTimeout(() => {
                console.log(`⏰ Closing Session (Hour: ${hour})`);
                closeAndReport();
            }, 60 * 60 * 1000);
        });

        // 2. Warning (Hour H-1 at Minute 59)
        let warnHour = hour - 1;
        if (warnHour < 0) warnHour = 23;
        
        const warnJob = cron.schedule(`59 ${warnHour} * * *`, () => {
            console.log(`⏰ Sending Warning (For Hour: ${hour})`);
            sendWarning();
        });

        activeCronJobs.push(startJob, warnJob);
    });
}

// ==========================================
// 🛠️ COMMANDS
// ==========================================
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // 1. STRICT LINK COLLECTOR
    const channelId = getSetting('channel_id');
    if (channelId && message.channel.id === channelId) {
        // Regex to capture Username (Group 1) and ID (Group 2)
        // Supports: x.com/user/status/123 OR twitter.com/user/status/123
        const match = message.content.match(/(?:x|twitter)\.com\/([a-zA-Z0-9_]+)\/status\/(\d+)/);
        const matchMobile = message.content.match(/(?:x|twitter)\.com\/i\/status\/(\d+)/); // For links without usernames

        let tweetId = null;
        let detectedUser = null;

        if (match) {
            detectedUser = match[1];
            tweetId = match[2];
        } else if (matchMobile) {
            tweetId = match[1];
            // Cannot validate username for /i/ links, so we pass it
        }

        if (tweetId) {
            const user = getUser(message.author.id);
            
            // A. Not Registered
            if (!user) {
                try {
                    await message.delete();
                    const w = await message.channel.send(`<@${message.author.id}> ⛔ **Unregistered.** Ask an Admin to add you.`);
                    setTimeout(() => w.delete().catch(() => {}), 5000);
                } catch (e) {}
                return;
            }

            // B. Wrong Account (Identity Theft Check)
            if (detectedUser && user.handle.toLowerCase() !== detectedUser.toLowerCase()) {
                try {
                    await message.delete();
                    const w = await message.channel.send(`<@${message.author.id}> ⛔ **Wrong Account!**\nYou are registered as **@${user.handle}**, but posted a link from **@${detectedUser}**.`);
                    setTimeout(() => w.delete().catch(() => {}), 8000);
                } catch (e) {}
                return;
            }

            // C. Duplicate (1 Link Per Session)
            if (isUserInSession(message.author.id)) {
                try {
                    await message.delete();
                    const w = await message.channel.send(`<@${message.author.id}> ⚠️ **One link per session!**`);
                    setTimeout(() => w.delete().catch(() => {}), 5000);
                } catch (e) {}
                return;
            }

            // D. Success
            addSessionLink(tweetId, message.author.id);
            await message.react('💎');
        }
    }

    if (!message.content.startsWith('!')) return;
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ==================================================
    // 👮 PERMISSIONS
    // ==================================================
    let isAdmin = SUPER_ADMINS.includes(message.author.id);
    if (!isAdmin) {
        // Fallback to role if not super admin
        const roleId = getSetting('admin_role_id');
        if (roleId && message.member.roles.cache.has(roleId)) isAdmin = true;
        if (message.member.permissions.has('Administrator')) isAdmin = true;
    }

    if (!isAdmin) return; // STRICT: ONLY ADMINS CAN USE COMMANDS

    // ==================================================
    // 👑 ADMIN COMMANDS
    // ==================================================
    if (command === 'settime') {
        const hourOptions = [];
        for (let i = 0; i < 24; i++) {
            const label = i < 10 ? `0${i}:00 UTC` : `${i}:00 UTC`;
            hourOptions.push(new StringSelectMenuOptionBuilder().setLabel(label).setValue(String(i)));
        }
        const select1 = new StringSelectMenuBuilder().setCustomId('select_s1').setPlaceholder('Session 1 Start').addOptions(hourOptions);
        const select2 = new StringSelectMenuBuilder().setCustomId('select_s2').setPlaceholder('Session 2 Start').addOptions(hourOptions);
        const select3 = new StringSelectMenuBuilder().setCustomId('select_s3').setPlaceholder('Session 3 Start').addOptions(hourOptions);

        const embed = new EmbedBuilder().setTitle("⏰ Schedule Configuration").setDescription("Select UTC Start Times.").setColor(0x00FFFF);
        const reply = await message.reply({ embeds: [embed], components: [
            new ActionRowBuilder().addComponents(select1),
            new ActionRowBuilder().addComponents(select2),
            new ActionRowBuilder().addComponents(select3)
        ]});

        const collector = reply.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60000 });
        collector.on('collect', async i => {
            if (i.user.id !== message.author.id) return i.reply({ content: 'Not yours.', ephemeral: true });
            const val = i.values[0];
            if (i.customId === 'select_s1') setSetting('session1_hour', val);
            if (i.customId === 'select_s2') setSetting('session2_hour', val);
            if (i.customId === 'select_s3') setSetting('session3_hour', val);
            rescheduleCrons();
            await i.reply({ content: `✅ Set to **${val}:00 UTC**.`, ephemeral: true });
        });
    }

    if (command === 'register') {
        const targetUser = message.mentions.users.first();
        const handle = args[1]?.replace('@', '').trim();
        if (!targetUser || !handle) return message.reply("❌ Usage: `!register @Discord @Twitter`");

        const statusMsg = await message.reply(`🔍 Verifying X user **@${handle}**...`);
        const nid = await getNumericId(handle);
        if (nid) {
            saveUser(targetUser.id, handle, nid);
            await statusMsg.edit(`✅ **Success:** <@${targetUser.id}> linked to **@${handle}**`);
        } else {
            await statusMsg.edit(`❌ **Failed:** Could not find **@${handle}** on X.`);
        }
    }

    if (command === 'version') return message.reply(`🤖 Bot Version: **${VERSION}**`);

    if (command === 'setchannel') {
        const channel = message.mentions.channels.first();
        if (!channel) return message.reply("Tag a channel.");
        setSetting('channel_id', channel.id);
        message.reply(`✅ Raid Channel: ${channel}`);
    }

    if (command === 'start') {
        message.reply("🚀 **Force Starting Session...**");
        openSession(message);
    }
    if (command === 'end') {
        message.reply("🛑 **Force Ending Session...**");
        closeAndReport(message);
    }
    
    // Test the warning manually
    if (command === 'testwarn') {
        message.reply("🔔 Sending Test Warning...");
        sendWarning();
    }
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag} - ${VERSION}`);
    rescheduleCrons();
});

client.login(TOKEN);
