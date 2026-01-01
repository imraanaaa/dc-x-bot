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
    ButtonBuilder,     // <--- ADD THIS
    ButtonStyle        // <--- ADD THIS
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

const VERSION = "v18.0 (OG Text Format)";

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
    
    // API Call
    let fetchCount = 480; 
    const options = {
        method: 'GET',
        url: `https://${RAPID_HOST}/user-replies-v2`,
        params: { user: userNumericId, count: String(fetchCount) },
        headers: { 'x-rapidapi-key': RAPID_API_KEY, 'x-rapidapi-host': RAPID_HOST }
    };

    try {
        const response = await axios.request(options);
        const foundIds = new Set();
        // Collect all replies this user made
        findValuesByKey(response.data, 'in_reply_to_status_id_str', Array.from(foundIds)).forEach(id => foundIds.add(String(id)));
        findValuesByKey(response.data, 'in_reply_to_status_id', Array.from(foundIds)).forEach(id => foundIds.add(String(id)));

        // Match against targets
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
// 📅 SESSION MANAGERS (TEXT MODE)
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
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
    } catch (e) {
        if (triggerMsg) triggerMsg.reply("❌ Permission Error: Cannot lock.");
    }

    const sessionData = getSessionLinks();
    
    // Calculate 2 hours from now
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

    // 1. Get List of all Tweet IDs
    const allTargets = sessionData.map(r => r.tweet_id);
    const results = [];
    const uniqueUsers = new Set(sessionData.map(r => r.discord_id));

    // 2. Check each user
    for (let userId of uniqueUsers) {
        let user = getUser(userId);
        let score = 0;
        let handle = user ? user.handle : "Unknown";
        
        // FIND USER'S OWN LINK TO IGNORE
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

        // OG Text Format
        if (pct >= 100) {
            completedList += `\n  ▸ <@${p.id}> (@${p.handle}) — ${p.score}/${p.req} (100%)`;
        } else {
            incompleteList += `\n  ▸ <@${p.id}> (@${p.handle}) — ${p.score}/${p.req} (${pct}%)`;
        }
    }

    let report = `
═══════════════════════════════════════
📊 OG YAPPERS REPORT — ${dateStr}
═══════════════════════════════════════

📈 STATISTICS
▸ Total tweets checked: ${allTargets.length}
▸ Total senders: ${results.length}
▸ Self-reply: Not required

🔍 REPLY STATUS
✅ Fully replied:${completedList || "\n  (None)"}

❌ Not fully replied:${incompleteList || "\n  (None)"}

═══════════════════════════════════════

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
            if (isUserInSession(message.author.id)) {
                try {
                    await message.delete();
                    const w = await message.channel.send(`⚠️ <@${message.author.id}> **One link only.**`);
                    setTimeout(() => w.delete().catch(() => {}), 5000);
                } catch (e) {}
                return;
            }
            addSessionLink(tweetId, message.author.id);
            await message.react('💎');
        }
    }

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

    // ADMIN COMMANDS
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

                if (command === 'checkr') {
        // 1. Check if a user was mentioned
        const targetUser = message.mentions.users.first();
        if (!targetUser) return message.reply("❌ Usage: `!checkr @DiscordUser`");

        // 2. Get user data from DB
        const user = getUser(targetUser.id);
        if (!user) return message.reply(`❌ <@${targetUser.id}> is not registered.`);

        // 3. Tell bot we are working
        const statusMsg = await message.reply(`📡 Connecting to X API to fetch recent replies for @${user.handle}...`);

        // ==========================================
        // 🔧 LOCAL API HELPER (With Pagination Loop)
        // ==========================================
        const getRecentRepliesData = async (numericId) => {
            if (!numericId || !RAPID_API_KEY) return [];
            
            let tweets = [];
            let nextToken = null;
            const maxPages = 18; // Fetch 4 pages (200 items each = 800 items total)

            // Loop through pages
            for (let i = 0; i < maxPages; i++) {
                const options = {
                    method: 'GET',
                    url: `https://${RAPID_HOST}/user-replies-v2`,
                    params: { 
                        user: numericId, 
                        count: '200' 
                    }, 
                    headers: { 'x-rapidapi-key': RAPID_API_KEY, 'x-rapidapi-host': RAPID_HOST }
                };

                // Add cursor token if we are on page 2+
                if (nextToken) {
                    options.params.cursor = nextToken;
                }

                try {
                    const response = await axios.request(options);
                    
                    // Recursive function to find tweet objects containing text
                    function extractTweets(obj) {
                        if (!obj) return;
                        if (Array.isArray(obj)) {
                            obj.forEach(item => extractTweets(item));
                        } else if (typeof obj === 'object') {
                            // Check if this object looks like a Tweet Result
                            if (obj.legacy && obj.legacy.full_text) {
                                tweets.push({
                                    id: obj.legacy.id_str,
                                    text: obj.legacy.full_text,
                                    replyTo: obj.legacy.in_reply_to_status_id_str
                                });
                            }
                            // Keep digging recursively
                            Object.values(obj).forEach(val => extractTweets(val));
                        }
                    }

                    extractTweets(response.data);

                    // --- FIND CURSOR FOR NEXT PAGE ---
                    const cursors = findValuesByKey(response.data, 'cursor');
                    
                    if (cursors.length > 0) {
                        nextToken = cursors[cursors.length - 1];
                    } else {
                        break; // No more pages
                    }

                } catch (e) {
                    console.error(`❌ API Error: ${e.message}`);
                    break; 
                }
            }
            
            return tweets; 
        };

        // 4. Fetch Data
        const tweets = await getRecentRepliesData(user.numeric_id);

        if (tweets.length === 0) {
            return statusMsg.edit("❌ API Error: No replies found or the account is private/suspended.");
        }

        // 5. Pagination Setup
        const itemsPerPage = 20; // Reduced from 30 to prevent hitting 4096 char limit
        let currentPage = 0;
        const totalPages = Math.ceil(tweets.length / itemsPerPage);

        // Helper to create the embed
        const generateEmbed = (page) => {
            const start = page * itemsPerPage;
            const end = start + itemsPerPage;
            const pageData = tweets.slice(start, end);

            // Format the list
            const content = pageData.map(t => {
                const link = `https://x.com/i/status/${t.id}`;
                // Truncate text if it's too long (kept to 60 for cleanliness)
                const displayText = t.text.length > 60 ? t.text.substring(0, 60) + "..." : t.text;
                const replyTarget = t.replyTo ? `(Reply to: ${t.replyTo})` : `(Root Reply)`;
                return `**[Link](${link})**\n"${displayText}" ${replyTarget}`;
            }).join('\n\n');

            // SAFETY CHECK: Ensure description is under 4096 chars
            let safeContent = content;
            if (safeContent.length > 4090) {
                safeContent = safeContent.substring(0, 4085) + "...";
            }

            return new EmbedBuilder()
                .setTitle(`📝 Last Replies for @${user.handle}`)
                .setDescription(safeContent || "No data for this page.")
                .setColor('#3498db') // Blue Embed
                .setFooter({ text: `Page ${page + 1} / ${totalPages} | Total Replies Found: ${tweets.length}` })
                .setTimestamp();
        };

        // Helper to create Buttons (Blue = ButtonStyle.Primary)
        const getButtons = (page) => {
            return new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('prev_page')
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Primary) // Blue Color
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('next_page')
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Primary) // Blue Color
                    .setDisabled(page === totalPages - 1)
            );
        };

        // Edit the original status message with the embed
        await statusMsg.edit({ 
            content: `✅ Found **${tweets.length}** recent replies for <@${targetUser.id}>:`,
            embeds: [generateEmbed(currentPage)], 
            components: [getButtons(currentPage)] 
        });

        // Collector for pagination
        const collector = statusMsg.createMessageComponentCollector({ time: 120000 }); 

        collector.on('collect', async i => {
            if (i.user.id !== message.author.id) {
                return i.reply({ content: 'Not for you.', ephemeral: true });
            }

            if (i.customId === 'prev_page') currentPage--;
            if (i.customId === 'next_page') currentPage++;

            await i.update({ 
                embeds: [generateEmbed(currentPage)], 
                components: [getButtons(currentPage)] 
            });
        });

        collector.on('end', async () => {
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('prev_page')
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('next_page')
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(true)
            );
            await statusMsg.edit({ components: [disabledRow] }).catch(() => {});
        });
    }

        if (command === 'listusers') {
        const allUsers = db.prepare('SELECT * FROM users').all();

        if (allUsers.length === 0) {
            return message.reply({ content: "❌ No users are currently registered." });
        }

        // Pagination Settings
        const itemsPerPage = 15; // How many users per page
        let currentPage = 0;
        const totalPages = Math.ceil(allUsers.length / itemsPerPage);

        // Helper function to generate the embed for a specific page
        const generateEmbed = (page) => {
            const start = page * itemsPerPage;
            const end = start + itemsPerPage;
            const pageData = allUsers.slice(start, end);

            const userListString = pageData.map(u => {
                return `<@${u.discord_id}> — [@${u.handle}](https://x.com/${u.handle})`;
            }).join('\n');

            return new EmbedBuilder()
                .setTitle('📋 Registered Database')
                .setDescription(userListString)
                .setColor('#3498db')
                .setFooter({ text: `Page ${page + 1} / ${totalPages} | Total Users: ${allUsers.length}` })
                .setTimestamp();
        };

        // Create the buttons (Grey = ButtonStyle.Secondary)
        const getButtons = (page) => {
            return new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('prev_page')
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Secondary) // Grey
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('next_page')
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Secondary) // Grey
                    .setDisabled(page === totalPages - 1)
            );
        };

        // Send the first message
        const msg = await message.reply({ 
            embeds: [generateEmbed(currentPage)], 
            components: [getButtons(currentPage)] 
        });

        // Collector to handle button clicks
        const collector = msg.createMessageComponentCollector({ time: 60000 }); // 60 seconds timeout

        collector.on('collect', async i => {
            // Ensure only the person who typed the command can click the buttons
            if (i.user.id !== message.author.id) {
                return i.reply({ content: '❌ These buttons are not for you!', ephemeral: true });
            }

            // Update page number based on button clicked
            if (i.customId === 'prev_page') currentPage--;
            if (i.customId === 'next_page') currentPage++;

            // Update the message with new embed and new button states
            await i.update({ 
                embeds: [generateEmbed(currentPage)], 
                components: [getButtons(currentPage)] 
            });
        });

        // When time runs out, disable the buttons
        collector.on('end', async () => {
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('prev_page')
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('next_page')
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
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
        message.reply("🚀 **Force Open...**");
        openSession(message);
    }
    if (command === 'end' || command === 'close') {
        message.reply("🔒 **Force Close (Grace Period)...**");
        closeSessionOnly(message);
    }
    if (command === 'forcereport') {
        message.reply("📊 **Force Report...**");
        generateFinalReport(message);
    }
    if (command === 'testwarn') sendWarning();
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag} - ${VERSION}`);
    rescheduleCrons();
});

client.login(TOKEN);
