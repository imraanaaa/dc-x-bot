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
    ButtonStyle 
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

// 🔔 ROLE TO TAG (For Lock/Unlock)
const RAID_ROLE_ID = "1455184518104485950";

const VERSION = "v19.3 (V1 API & Deep Scan)";

// 📂 DATABASE SETUP
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

function getUserByHandle(handle) {
    return db.prepare('SELECT * FROM users WHERE LOWER(handle) = LOWER(?)').get(handle);
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

// ==========================================
// 📡 API ENGINE (High Accuracy)
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

async function getTweetAuthorHandle(tweetId) {
    if (!RAPID_API_KEY) return null;
    try {
        const options = {
            method: 'GET',
            url: `https://${RAPID_HOST}/tweet`,
            params: { id: tweetId },
            headers: { 'x-rapidapi-key': RAPID_API_KEY, 'x-rapidapi-host': RAPID_HOST }
        };
        const response = await axios.request(options);
        const handles = findValuesByKey(response.data, 'screen_name');
        if (handles.length > 0) return handles[0].toLowerCase();
        return null;
    } catch (e) {
        console.error(`[Lookup] Failed to find author for tweet ${tweetId}`);
        return null;
    }
}

async function checkReplies(userNumericId, targetTweetIds) {
    if (!userNumericId || !RAPID_API_KEY) return 0;

    const targetSet = new Set(targetTweetIds);
    if (targetSet.size === 0) return 0;

    let matches = 0;
    let nextToken = null;
    
    // Config: 16 pages * 45 tweets = 720 tweets depth (Covers > 400 requirement)
    const maxPages = 16;
    const countPerPage = 45;

    for (let i = 0; i < maxPages; i++) {
        // Delay to prevent Rate Limit 429
        if (i > 0) await new Promise(resolve => setTimeout(resolve, 800));

        const options = {
            method: 'GET',
            url: `https://${RAPID_HOST}/user-replies`, // CHANGED TO V1
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
            // 🛡️ RECOVERY SYSTEM: If Rate Limited, wait and retry.
            if (e.response && e.response.status === 429) {
                console.warn(`⚠️ Rate Limit Hit for user ${userNumericId}. Retrying in 5s...`);
                await new Promise(r => setTimeout(r, 5000));
                i--; // Retry this page
                continue;
            }
            console.error(`❌ API Reply Error for user ${userNumericId}: ${e.message}`);
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
        await channel.permissionOverwrites.edit(RAID_ROLE_ID, { SendMessages: true });
    } catch (e) {
        if (triggerMsg) triggerMsg.reply("❌ Permission Error: Cannot unlock role.");
        return;
    }

    const msg = `
🟢 **CHANNEL OPENED**

Session is now open! Please post your Elite tweets.
One link per person.

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
        await channel.permissionOverwrites.edit(RAID_ROLE_ID, { SendMessages: false });
    } catch (e) {
        if (triggerMsg) triggerMsg.reply("❌ Permission Error: Cannot lock role.");
    }

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

    await channel.send(`⏳ **Checking ${sessionData.length} participants...**`);

    const allTargets = sessionData.map(r => r.tweet_id);
    const results = [];
    const uniqueUsers = new Set(sessionData.map(r => r.discord_id));

    for (let userId of uniqueUsers) {
        let user = getUser(userId);
        let score = 0;
        let handle = "Unknown";
        let isGhost = false;

        // INTERNAL LOGIC: If ID starts with ghost:, it was an admin injection.
        if (userId.startsWith('ghost:')) {
            isGhost = true;
            handle = userId.split(':')[1];
        } else if (user) {
            handle = user.handle;
        }
        
        const userLinks = sessionData.filter(r => r.discord_id === userId).map(r => r.tweet_id);
        const targetsForThisUser = allTargets.filter(id => !userLinks.includes(id));
        
        let requirement = targetsForThisUser.length; 
        if (requirement === 0) requirement = 1;

        if (!isGhost && user && user.numeric_id) {
            score = await checkReplies(user.numeric_id, targetsForThisUser);
            if (score > requirement) score = requirement;
            await new Promise(r => setTimeout(r, 2000));
        }
        
        results.push({ id: userId, handle, score, req: requirement, isGhost });
    }

    results.sort((a, b) => b.score - a.score);

    const dateStr = new Date().toISOString().split('T')[0];
    let completedList = "";
    let incompleteList = "";

    for (let p of results) {
        let pct = Math.floor((p.score / p.req) * 100);
        if (pct > 100) pct = 100;

        let displayName = p.isGhost ? `👻 @${p.handle}` : `<@${p.id}> (@${p.handle})`;

        if (pct >= 100) {
            completedList += `\n  ▸ ${displayName} — ${p.score}/${p.req} (100%)`;
        } else {
            incompleteList += `\n  ▸ ${displayName} — ${p.score}/${p.req} (${pct}%)`;
        }
    }

    let report = `
═════════════════════════════════════
📊 OG YAPPERS REPORT — ${dateStr}
═════════════════════════════════════

📈 STATISTICS
▸ Total tweets checked: ${allTargets.length}
▸ Total senders: ${results.length}

🔍 REPLY STATUS
✅ Fully replied:${completedList || "\n  (None)"}

❌ Not fully replied:${incompleteList || "\n  (None)"}

═════════════════════════════════════

<@&${RAID_ROLE_ID}>
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
// 🛠️ COMMANDS & LINKS
// ==========================================
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const channelId = getSetting('channel_id');
    
    // TRACKING LOGIC (For Users)
    if (channelId && message.channel.id === channelId) {
        const user = getUser(message.author.id);
        const urlRegex = /(?:x|twitter)\.com\/(?:[a-zA-Z0-9_]+\/status\/|i\/status\/)(\d+)/g;
        const matches = [...message.content.matchAll(urlRegex)];

        if (matches.length > 0) {
            if (!user) {
                try {
                    await message.delete();
                    const w = await message.channel.send(`⛔ <@${message.author.id}> **Unregistered.**`);
                    setTimeout(() => w.delete().catch(() => {}), 5000);
                } catch (e) {}
                return;
            }

            let addedCount = 0;
            const isAdmin = SUPER_ADMINS.includes(message.author.id);

            for (const match of matches) {
                let tweetId = match[1];
                let finalDiscordId = message.author.id; 
                
                // 🧠 SMART ADMIN INJECTION (Silent)
                // If an admin pastes a link, we check if it belongs to someone else.
                if (isAdmin) {
                    const twitterHandle = await getTweetAuthorHandle(tweetId);
                    if (twitterHandle) {
                        const dbUser = getUserByHandle(twitterHandle);
                        if (dbUser) {
                            finalDiscordId = dbUser.discord_id;
                        } else {
                            finalDiscordId = `ghost:${twitterHandle.toLowerCase()}`;
                        }
                    }
                }

                addSessionLink(tweetId, finalDiscordId);
                addedCount++;
            }

            if (addedCount > 0) {
                await message.react('💎');
            }
        }
    }

    // COMMAND LOGIC (Strictly Admin Only)
    if (!message.content.startsWith('!')) return;
    
    let isAdmin = SUPER_ADMINS.includes(message.author.id);
    if (!isAdmin) {
        const roleId = getSetting('admin_role_id');
        if (roleId && message.member.roles.cache.has(roleId)) isAdmin = true;
        if (message.member.permissions.has('Administrator')) isAdmin = true;
    }

    // 🛑 STOP if not admin
    if (!isAdmin) return; 

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // HELP COMMAND
    if (command === 'help') {
        const embed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle('🛡️ Admin Command Center')
            .setDescription('Only admins can execute these commands.')
            .addFields(
                { name: '🕹️ Session Control', value: '`!start` - Force Open Session\n`!close` - Force Close Session\n`!forcereport` - Run Report Now' },
                { name: '👥 User Management', value: '`!register @user @handle` - Link user manually\n`!listusers` - View database' },
                { name: '⚙️ Config', value: '`!settime` - Set schedule\n`!setchannel #channel` - Set raid channel' }
            );
        return message.reply({ embeds: [embed] });
    }

    // ... (Existing commands) ...
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
        message.reply("🚀 **Session Force Opened**");
        openSession(message);
    }

    if (command === 'end' || command === 'close') {
        message.reply("🔒 **Session Force Closed**");
        closeSessionOnly(message);
    }

    if (command === 'forcereport') {
        message.reply("📊 **Generating Report...**");
        generateFinalReport(message);
    }
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag} - ${VERSION}`);
    rescheduleCrons();
});

client.login(TOKEN);
