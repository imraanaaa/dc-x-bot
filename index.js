require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    ActionRowBuilder, 
    ComponentType,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle 
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

// 👑 ADMIN LIST
const SUPER_ADMINS = [
    "1442310589362999428", // Admin 1
    "1442618881285034099", // Admin 2
    "627327810079424533"   // Admin 3
];

// 🔔 ROLE TO TAG
const RAID_ROLE_ID = "1455184518104485950";

const VERSION = "v18.3 (Test Injection Command)";

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
let isManualTestMode = false;

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

    const targetSet = new Set(targetTweetIds);
    if (targetSet.size === 0) return 0;

    let matches = 0;
    let nextToken = null;
    const maxPages = 16;
    const countPerPage = 45;

    for (let i = 0; i < maxPages; i++) {
        if (i > 0) await new Promise(resolve => setTimeout(resolve, 100));

        const options = {
            method: 'GET',
            url: `https://${RAPID_HOST}/user-replies-v2`,
            params: { 
                user: userNumericId, 
                count: String(countPerPage),
                ...(nextToken && { cursor: nextToken }) 
            },
            headers: { 'x-rapidapi-key': RAPID_API_KEY, 'x-rapidapi-host': RAPID_HOST }
        };

        try {
            const response = await axios.request(options);
            const foundIds = new Set();

            findValuesByKey(response.data, 'in_reply_to_status_id_str', Array.from(foundIds)).forEach(id => foundIds.add(String(id)));
            findValuesByKey(response.data, 'in_reply_to_status_id', Array.from(foundIds)).forEach(id => foundIds.add(String(id)));

            const deepSearch = (obj) => {
                if (Array.isArray(obj)) {
                    obj.forEach(item => deepSearch(item));
                } else if (typeof obj === 'object' && obj !== null) {
                    if (obj.type === 'replied_to' && obj.id) {
                        foundIds.add(String(obj.id));
                    }
                    Object.values(obj).forEach(val => deepSearch(val));
                }
            };
            deepSearch(response.data);

            for (const id of foundIds) {
                if (targetSet.has(id)) matches++;
            }

            const cursors = findValuesByKey(response.data, 'cursor');
            if (cursors.length > 0) {
                nextToken = cursors[cursors.length - 1];
            } else {
                break;
            }

        } catch (e) {
            console.error(`❌ API Reply Error for user ${userNumericId}: ${e.message}`);
            if (e.response && e.response.status === 429) {
                console.warn(`⚠️ Rate Limit Hit. Stopping check for this user.`);
            }
            break;
        }
    }

    return matches;
}

// ==========================================
// 📅 SESSION MANAGERS
// ==========================================
async function sendWarning() {
    const channelId = getSetting('channel_id');
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    await channel.send(`🚨 <@&${RAID_ROLE_ID}> **WAKE UP!**\nSession starts in **1 minute**! Get ready.`);
}

async function openSession(triggerMsg = null) {
    clearSession(); 
    const channelId = getSetting('channel_id');
    if (!channelId) return triggerMsg?.reply("❌ No Channel Set.");
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return triggerMsg?.reply("❌ Channel Not Found.");

    try {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: true });
    } catch (e) {
        if (triggerMsg) triggerMsg.reply("❌ Permission Error: Cannot unlock.");
        return;
    }

    const msg = `
🟢 **CHANNEL OPENED**${isManualTestMode ? " **(TEST MODE)**" : ""}

Session is now open! Please post your Elite tweets.
One link per person.
 ${isManualTestMode ? "\n💡 **Admins:** Use `!test <link> <@user>` to simulate other users!" : ""}

<@&${RAID_ROLE_ID}>
    `;

    await channel.send(msg);
}

async function closeSessionOnly(triggerMsg = null) {
    const channelId = getSetting('channel_id');
    if (!channelId) return triggerMsg?.reply("❌ No Channel.");
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return triggerMsg?.reply("❌ Channel Not Found.");

    try {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
    } catch (e) {
        if (triggerMsg) triggerMsg.reply("❌ Permission Error: Cannot lock.");
    }

    isManualTestMode = false; 

    const sessionData = getSessionLinks();
    const reportTime = Math.floor((Date.now() / 1000) + (2 * 60 * 60));

    const msg = `
🔴 **CHANNEL CLOSED**

Session has ended.
📊 **${sessionData.length} participants** posted tweets today.

⚠️ **REMINDER:** Please complete all RAID replies before the bot snapshot at <t:${reportTime}:t>!

<@&${RAID_ROLE_ID}>
    `;

    await channel.send(msg);
}

async function generateFinalReport(triggerMsg = null) {
    const channelId = getSetting('channel_id');
    if (!channelId) return triggerMsg?.reply("❌ No Channel.");
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return triggerMsg?.reply("❌ Channel Not Found.");

    const sessionData = getSessionLinks();
    if (sessionData.length === 0) return channel.send("⚠️ **No links posted.**");

    await channel.send(`⏳ **Analyzing ${sessionData.length} participants...**`);

    const allTargets = sessionData.map(r => r.tweet_id);
    const results = [];
    const uniqueUsers = new Set(sessionData.map(r => r.discord_id));

    for (let userId of uniqueUsers) {
        let user = getUser(userId);
        let score = 0;
        let handle = user ? user.handle : "Unknown";
        
        const userOwnLink = sessionData.find(r => r.discord_id === userId)?.tweet_id;
        const targetsForThisUser = allTargets.filter(id => id !== userOwnLink);
        
        let requirement = targetsForThisUser.length; 
        if (requirement === 0) requirement = 1;

        if (user && user.numeric_id) {
            score = await checkReplies(user.numeric_id, targetsForThisUser);
            if (score > requirement) score = requirement;
        }
        
        results.push({ id: userId, handle, score, req: requirement });
    }

    results.sort((a, b) => b.score - a.score);

    const dateStr = new Date().toISOString().split('T')[0];

    let completedList = "";
    let incompleteList = "";

    for (let p of results) {
        let pct = Math.floor((p.score / p.req) * 100);
        if (pct > 100) pct = 100;

        if (pct >= 100) {
            completedList += `\n  ▸ <@${p.id}> (@${p.handle}) — ${p.score}/${p.req} (100%)`;
        } else {
            incompleteList += `\n  ▸ <@${p.id}> (@${p.handle}) — ${p.score}/${p.req} (${pct}%)`;
        }
    }

    let report = `
═════════════════════════════════════
📊 OG YAPPERS REPORT — ${dateStr}
═════════════════════════════════════

📈 STATISTICS
▸ Total tweets checked: ${allTargets.length}
▸ Total senders: ${results.length}
▸ Self-reply: Not required

🔍 REPLY STATUS
✅ Fully replied:${completedList || "\n  (None)"}

❌ Not fully replied:${incompleteList || "\n  (None)"}

═════════════════════════════════════

<@&${RAID_ROLE_ID}>

💡 NOTE:
If your account is detected as not fully replying even though you've replied to all:
1️⃣ Check if your account is ghost banned (shadowbanned)
2️⃣ If not ghost banned, it means you didn't actually raid that tweet
3️⃣ Make sure your reply appears on others' timeline, not just on your profile

⚠️ If you have any issues, make sure to report to admins to avoid getting WARN role!
`;

    if (report.length > 1900) {
        const chunks = report.match(/[\s\S]{1,1900}/g) || [];
        for (const chunk of chunks) await channel.send(chunk);
    } else {
        await channel.send(report);
    }
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
        let startHour = parseInt(h);
        
        let warnH = startHour;
        let warnM = 59;
        if (startHour === 0) { warnH = 23; } else { warnH = startHour - 1; }
        
        const jobWarn = cron.schedule(`${warnM} ${warnH} * * *`, () => {
            console.log(`⏰ Warning for Session ${startHour}`);
            sendWarning();
        });

        const jobOpen = cron.schedule(`0 ${startHour} * * *`, () => {
            console.log(`⏰ Opening Session ${startHour}`);
            openSession();
        });

        let closeHour = (startHour + 1) % 24;
        const jobClose = cron.schedule(`0 ${closeHour} * * *`, () => {
            console.log(`⏰ Closing Session (Locking) ${startHour}`);
            closeSessionOnly();
        });

        let reportHour = (startHour + 3) % 24;
        const jobReport = cron.schedule(`0 ${reportHour} * * *`, () => {
            console.log(`⏰ Generating Report for ${startHour}`);
            generateFinalReport();
        });

        activeCronJobs.push(jobWarn, jobOpen, jobClose, jobReport);
    });
}

// ==========================================
// 🛠️ COMMANDS
// ==========================================
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const channelId = getSetting('channel_id');
    
    // ==========================================
    // 🧪 NEW !test COMMAND (FOR ADMIN SIMULATION)
    // ==========================================
    if (message.content.startsWith('!test')) {
        // Only Super Admins can use this
        if (!SUPER_ADMINS.includes(message.author.id)) return;

        const args = message.content.trim().split(/\s+/);
        if (args.length < 3) return message.reply("Usage: `!test <link> <@user>`");

        const link = args[1];
        const mention = args[2];

        // Extract Tweet ID
        const match = link.match(/(?:x|twitter)\.com\/([a-zA-Z0-9_]+)\/status\/(\d+)/);
        const matchMobile = link.match(/(?:x|twitter)\.com\/i\/status\/(\d+)/);

        let tweetId = null;
        if (match) tweetId = match[2];
        else if (matchMobile) tweetId = matchMobile[1];

        if (!tweetId) return message.reply("❌ Invalid Tweet Link");

        // Get User from Mention
        const targetUser = message.mentions.users.first();
        if (!targetUser) return message.reply("❌ Could not find user. Did you @mention them?");

        // Check if user is registered
        const dbUser = getUser(targetUser.id);
        if (!dbUser) return message.reply(`❌ <@${targetUser.id}> is not registered in the database.`);

        // Inject into session
        addSessionLink(tweetId, targetUser.id);
        
        // React to original message
        try { await message.react('💉'); } catch {}

        return message.reply(`✅ **Test Injection:** Added tweet for <@${targetUser.id}> (@${dbUser.handle}) to the session.`);
    }

    // ==========================================
    // 📝 NORMAL LINK LISTENER
    // ==========================================
    if (channelId && message.channel.id === channelId) {
        const match = message.content.match(/(?:x|twitter)\.com\/([a-zA-Z0-9_]+)\/status\/(\d+)/);
        const matchMobile = message.content.match(/(?:x|twitter)\.com\/i\/status\/(\d+)/); 

        let tweetId = null;
        let detectedUser = null;

        if (match) {
            detectedUser = match[1];
            tweetId = match[2];
        } else if (matchMobile) {
            tweetId = match[1];
        }

        if (tweetId) {
            const user = getUser(message.author.id);
            if (!user) {
                try {
                    await message.delete();
                    const w = await message.channel.send(`⛔ <@${message.author.id}> **Unregistered.**`);
                    setTimeout(() => w.delete().catch(() => {}), 5000);
                } catch (e) {}
                return;
            }
            if (detectedUser && user.handle.toLowerCase() !== detectedUser.toLowerCase()) {
                try {
                    await message.delete();
                    const w = await message.channel.send(`⛔ <@${message.author.id}> **Wrong Account.** (Registered: @${user.handle})`);
                    setTimeout(() => w.delete().catch(() => {}), 5000);
                } catch (e) {}
                return;
            }

            // Check duplicates
            if (isUserInSession(message.author.id)) {
                // If Test Mode is ON and User is Super Admin, allow update
                if (isManualTestMode && SUPER_ADMINS.includes(message.author.id)) {
                    console.log(`[TEST MODE] Admin ${message.author.id} updated their link.`);
                } else {
                    // Standard Error
                    try {
                        await message.delete();
                        const w = await message.channel.send(`⚠️ <@${message.author.id}> **One link only.**`);
                        setTimeout(() => w.delete().catch(() => {}), 5000);
                    } catch (e) {}
                    return;
                }
            }

            addSessionLink(tweetId, message.author.id);
            await message.react('💎');
        }
    }

    // ==========================================
    // ⚙️ ADMIN COMMANDS
    // ==========================================
    if (!message.content.startsWith('!')) return;
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    let isAdmin = SUPER_ADMINS.includes(message.author.id);
    if (!isAdmin) {
        const roleId = getSetting('admin_role_id');
        if (roleId && message.member.roles.cache.has(roleId)) isAdmin = true;
        if (message.member.permissions.has('Administrator')) isAdmin = true;
    }
    if (!isAdmin) return; 

    if (command === 'settime') {
        const hourOptions = [];
        for (let i = 0; i < 24; i++) {
            const label = i < 10 ? `0${i}:00 UTC` : `${i}:00 UTC`;
            hourOptions.push(new StringSelectMenuOptionBuilder().setLabel(label).setValue(String(i)));
        }
        const select1 = new StringSelectMenuBuilder().setCustomId('select_s1').setPlaceholder('Session 1 Start').addOptions(hourOptions);
        const select2 = new StringSelectMenuBuilder().setCustomId('select_s2').setPlaceholder('Session 2 Start').addOptions(hourOptions);
        const select3 = new StringSelectMenuBuilder().setCustomId('select_s3').setPlaceholder('Session 3 Start').addOptions(hourOptions);

        const reply = await message.reply({ 
            content: "**⏰ Configure Schedule (UTC)**\nSelect start times below.",
            components: [
                new ActionRowBuilder().addComponents(select1),
                new ActionRowBuilder().addComponents(select2),
                new ActionRowBuilder().addComponents(select3)
            ]
        });

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

    if (command === 'listusers') {
        const allUsers = db.prepare('SELECT * FROM users').all();
        if (allUsers.length === 0) return message.reply({ content: "❌ No users are currently registered." });

        const itemsPerPage = 5;
        let currentPage = 0;
        const totalPages = Math.ceil(allUsers.length / itemsPerPage);

        const generateEmbed = (page) => {
            const start = page * itemsPerPage;
            const end = start + itemsPerPage;
            const pageData = allUsers.slice(start, end);
            const userListString = pageData.map(u => `<@${u.discord_id}> — [@${u.handle}](https://x.com/${u.handle})`).join('\n');
            return new EmbedBuilder()
                .setTitle('📋 Registered Database')
                .setDescription(userListString)
                .setColor('#3498db')
                .setFooter({ text: `Page ${page + 1} / ${totalPages} | Total Users: ${allUsers.length}` })
                .setTimestamp();
        };

        const getButtons = (page) => {
            return new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('prev_page').setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                new ButtonBuilder().setCustomId('next_page').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages - 1)
            );
        };

        const msg = await message.reply({ embeds: [generateEmbed(currentPage)], components: [getButtons(currentPage)] });
        const collector = msg.createMessageComponentCollector({ time: 60000 });

        collector.on('collect', async i => {
            if (i.user.id !== message.author.id) return i.reply({ content: '❌ These buttons are not for you!', ephemeral: true });
            if (i.customId === 'prev_page') currentPage--;
            if (i.customId === 'next_page') currentPage++;
            await i.update({ embeds: [generateEmbed(currentPage)], components: [getButtons(currentPage)] });
        });

        collector.on('end', async () => {
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('prev_page').setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(true),
                new ButtonBuilder().setCustomId('next_page').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(true)
            );
            await msg.edit({ components: [disabledRow] }).catch(() => {});
        });
    }

    if (command === 'register') {
        const targetUser = message.mentions.users.first();
        const handle = args[1]?.replace('@', '').trim();
        if (!targetUser || !handle) return message.reply("❌ Usage: `!register @Discord @Twitter`");
        const statusMsg = await message.reply(`🔍 Verifying...`);
        const nid = await getNumericId(handle);
        if (nid) {
            saveUser(targetUser.id, handle, nid);
            await statusMsg.edit(`✅ Linked <@${targetUser.id}> to **@${handle}**`);
        } else {
            await statusMsg.edit(`❌ Failed. Check handle/API.`);
        }
    }

    if (command === 'version') return message.reply(`🤖 Bot Version: **${VERSION}**`);
    if (command === 'setchannel') {
        const channel = message.mentions.channels.first();
        setSetting('channel_id', channel.id);
        message.reply(`✅ Raid Channel: ${channel}`);
    }
    
    if (command === 'start') {
        isManualTestMode = true;
        message.reply("🚀 **Force Open...**");
        openSession(message);
    }

    if (command === 'end' || command === 'close') {
        message.reply("🔒 **Force Close...**");
        closeSessionOnly(message);
    }

    if (command === 'forcereport') {
        message.reply("📊 **Force Report...**");
        generateFinalReport(message);
    }
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag} - ${VERSION}`);
    rescheduleCrons();
});

client.login(TOKEN);
