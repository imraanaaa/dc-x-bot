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
    "627327810079424533",  // Admin 3
    "986489740045987880"   // Developer (imraanaaa)
];

// 🔔 ROLE TO TAG (For Lock/Unlock)
const RAID_ROLE_ID = "1455184518104485950";

const VERSION = "v21.1 (Comments-V2 + Admin Post Features)";

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

function isSessionOpen() {
    return getSetting('session_status') === 'open';
}

// ==========================================
// 📡 API ENGINE (V2 with Deep Scanning)
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
    if (!RAPID_API_KEY) {
        console.error("❌ CRITICAL: RAPID_API_KEY missing!");
        return null;
    }
    
    const options = {
        method: 'GET',
        url: `https://${RAPID_HOST}/user`,
        params: { username: username },
        headers: { 
            'x-rapidapi-key': RAPID_API_KEY, 
            'x-rapidapi-host': RAPID_HOST 
        },
        timeout: 15000
    };

    try {
        const response = await axios.request(options);
        let ids = findValuesByKey(response.data, 'rest_id');
        if (ids.length > 0) return ids[0];
        ids = findValuesByKey(response.data, 'id');
        for (let id of ids) { 
            if (!isNaN(id) && id.length > 5) return id; 
        }
    } catch (e) { 
        console.error(`❌ API ID Error for ${username}: ${e.message}`); 
    }
    return null;
}

async function getTweetAuthorHandle(tweetId) {
    if (!RAPID_API_KEY) return null;
    try {
        const options = {
            method: 'GET',
            url: `https://${RAPID_HOST}/tweet`,
            params: { id: tweetId },
            headers: { 
                'x-rapidapi-key': RAPID_API_KEY, 
                'x-rapidapi-host': RAPID_HOST 
            },
            timeout: 15000
        };
        const response = await axios.request(options);
        const handles = findValuesByKey(response.data, 'screen_name');
        if (handles.length > 0) return handles[0].toLowerCase();
        return null;
    } catch (e) {
        console.error(`[Lookup] Failed to find author for tweet ${tweetId}: ${e.message}`);
        return null;
    }
}

/**
 * Extract tweet ID from various Twitter/X URL formats
 * Supports: /status/, /statuses/, /post/, twitter.com, x.com
 */
function extractTweetId(url) {
    const patterns = [
        /\/status\/(\d+)/i,
        /\/statuses\/(\d+)/i,
        /\/post\/(\d+)/i,
        /twitter\.com\/\w+\/status\/(\d+)/i,
        /twitter\.com\/\w+\/statuses\/(\d+)/i,
        /twitter\.com\/\w+\/post\/(\d+)/i,
        /x\.com\/\w+\/status\/(\d+)/i,
        /x\.com\/\w+\/statuses\/(\d+)/i,
        /x\.com\/\w+\/post\/(\d+)/i
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }
    
    return null;
}

/**
 * 🚀 ENHANCED COMMENTS-V2 API CHECKER 
 * - Uses comments-v2 endpoint to fetch ALL replies to target tweets
 * - Fetches up to 100 comments per tweet
 * - Checks if registered user's handle appears in ANY comment
 * - Returns match count for the user across all target tweets
 */
async function checkReplies(userNumericId, targetTweetIds) {
    if (!userNumericId || !RAPID_API_KEY) {
        console.warn(`⚠️ Missing userNumericId or API key`);
        return 0;
    }

    const targetSet = new Set(targetTweetIds.map(id => String(id)));
    if (targetSet.size === 0) return 0;

    // Get the user's handle from database
    const userRecord = db.prepare('SELECT handle FROM users WHERE numeric_id = ?').get(userNumericId);
    if (!userRecord) {
        console.warn(`⚠️ No handle found for numeric_id: ${userNumericId}`);
        return 0;
    }
    
    const userHandle = userRecord.handle.toLowerCase();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔍 CHECKING COMMENTS FOR USER: ${userHandle} (${userNumericId})`);
    console.log(`🎯 Target tweets to check: ${targetSet.size}`);
    console.log(`📋 Targets: ${Array.from(targetSet).join(', ')}`);
    console.log(`${'='.repeat(60)}\n`);

    let matches = 0;
    const matchedTweets = new Set();
    let totalCommentsScanned = 0;
    
    // Check each target tweet for user's comments
    for (const tweetId of targetSet) {
        console.log(`\n📄 Fetching comments for tweet ${tweetId}...`);
        
        // Rate limiting delay
        if (matchedTweets.size > 0) {
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        const options = {
            method: 'GET',
            url: `https://${RAPID_HOST}/comments-v2`,
            params: {
                pid: tweetId,
                rankingMode: 'Relevance',
                count: '100'
            },
            headers: {
                'x-rapidapi-key': RAPID_API_KEY,
                'x-rapidapi-host': RAPID_HOST
            },
            timeout: 25000
        };

        let retries = 3;
        let commentsData = null;

        // Retry logic with exponential backoff
        while (retries > 0) {
            try {
                const response = await axios.request(options);
                commentsData = response.data;
                break; // Success
            } catch (e) {
                retries--;
                
                if (e.response && e.response.status === 429) {
                    const waitTime = (4 - retries) * 5000; // 5s, 10s, 15s
                    console.warn(`⚠️ Rate limit hit for tweet ${tweetId}. Waiting ${waitTime/1000}s... (${retries} retries left)`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }
                
                if (retries === 0) {
                    console.error(`❌ Failed to fetch comments for tweet ${tweetId}: ${e.message}`);
                    commentsData = null;
                    break;
                }
                
                // Other errors - short retry
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (!commentsData || !commentsData.data) {
            console.warn(`⚠️ No comments data returned for tweet ${tweetId}`);
            continue;
        }

        const comments = Array.isArray(commentsData.data) ? commentsData.data : [];
        totalCommentsScanned += comments.length;
        
        console.log(`📊 Found ${comments.length} comments on tweet ${tweetId}`);

        // Check if user commented on this tweet
        let userCommented = false;
        
        for (const comment of comments) {
            // Extract commenter's handle from various possible structures
            let commenterHandle = null;
            
            // Try different structures
            if (comment.user && comment.user.screen_name) {
                commenterHandle = comment.user.screen_name.toLowerCase();
            } else if (comment.screen_name) {
                commenterHandle = comment.screen_name.toLowerCase();
            } else if (comment.author && comment.author.username) {
                commenterHandle = comment.author.username.toLowerCase();
            } else if (comment.author && comment.author.screen_name) {
                commenterHandle = comment.author.screen_name.toLowerCase();
            } else if (comment.username) {
                commenterHandle = comment.username.toLowerCase();
            }
            
            // Check if it's our user
            if (commenterHandle && commenterHandle === userHandle) {
                userCommented = true;
                console.log(`   ✅ MATCH! User @${userHandle} commented on tweet ${tweetId}`);
                break;
            }
        }

        if (userCommented) {
            matchedTweets.add(tweetId);
            matches++;
        } else {
            console.log(`   ❌ User @${userHandle} did NOT comment on tweet ${tweetId}`);
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 FINAL SCAN RESULTS FOR USER @${userHandle} (${userNumericId})`);
    console.log(`   Tweets checked: ${targetSet.size}`);
    console.log(`   Total comments scanned: ${totalCommentsScanned}`);
    console.log(`   Matches found: ${matches}/${targetSet.size}`);
    console.log(`   Success rate: ${Math.floor((matches / targetSet.size) * 100)}%`);
    if (matches < targetSet.size) {
        const missing = Array.from(targetSet).filter(id => !matchedTweets.has(id));
        console.log(`   ❌ Missing comments on: ${missing.join(', ')}`);
    }
    console.log(`${'='.repeat(60)}\n`);
    
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
    setSetting('session_status', 'open');
    clearSession(); 
    const channelId = getSetting('channel_id');
    if (!channelId) return triggerMsg?.reply("❌ No Channel Set.");
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return triggerMsg?.reply("❌ Channel Not Found.");

    try {
        await channel.permissionOverwrites.edit(RAID_ROLE_ID, { SendMessages: true });
    } catch (e) {
        console.error(`Permission error: ${e.message}`);
        if (triggerMsg) triggerMsg.reply("❌ Permission Error: Cannot unlock role.");
        return;
    }

    const msg = `
🟢 **CHANNEL OPENED**

Session is now open! Please post your Elite tweets.
**ONE LINK PER PERSON.**

<@&${RAID_ROLE_ID}>
    `;

    await channel.send(msg);
}

async function closeSessionOnly(triggerMsg = null) {
    setSetting('session_status', 'closed');
    const channelId = getSetting('channel_id');
    if (!channelId) return triggerMsg?.reply("❌ No Channel.");
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return triggerMsg?.reply("❌ Channel Not Found.");

    try {
        await channel.permissionOverwrites.edit(RAID_ROLE_ID, { SendMessages: false });
    } catch (e) {
        console.error(`Permission error: ${e.message}`);
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
    if (sessionData.length === 0) return channel.send("⚠️ **No links posted this session.**");

    const statusMsg = await channel.send(`⏳ **Analyzing ${sessionData.length} participants...**\nThis may take several minutes.`);

    const allTargets = sessionData.map(r => r.tweet_id);
    const results = [];
    const uniqueUsers = new Set(sessionData.map(r => r.discord_id));

    let processedUsers = 0;
    for (let userId of uniqueUsers) {
        processedUsers++;
        
        // Update status every 3 users
        if (processedUsers % 3 === 0) {
            await statusMsg.edit(`⏳ **Analyzing participants... (${processedUsers}/${uniqueUsers.size})**`).catch(() => {});
        }

        let user = getUser(userId);
        let score = 0;
        let handle = "Unknown";
        let isGhost = false;

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
            try {
                score = await checkReplies(user.numeric_id, targetsForThisUser);
                if (score > requirement) score = requirement;
            } catch (e) {
                console.error(`Error checking replies for ${handle}: ${e.message}`);
                score = 0;
            }
            
            // Delay between users to avoid overwhelming API
            await new Promise(r => setTimeout(r, 2500));
        }
        
        results.push({ id: userId, handle, score, req: requirement, isGhost });
    }

    await statusMsg.delete().catch(() => {});

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
    
    // TRACKING LOGIC
    if (channelId && message.channel.id === channelId) {
        // Enhanced regex to catch /status/, /statuses/, /post/, and i/status formats
        const urlRegex = /(?:x|twitter)\.com\/(?:[a-zA-Z0-9_]+\/(?:status|statuses|post)\/|i\/(?:status|statuses|post)\/)(\d+)/gi;
        const matches = [...message.content.matchAll(urlRegex)];

        if (matches.length > 0) {
            
            if (!isSessionOpen()) {
                return;
            }

            const user = getUser(message.author.id);
            if (!user) {
                try {
                    await message.delete();
                    const w = await message.channel.send(`⛔ <@${message.author.id}> **Unregistered.**`);
                    setTimeout(() => w.delete().catch(() => {}), 5000);
                } catch (e) {
                    console.error(`Error handling unregistered user: ${e.message}`);
                }
                return;
            }

            let isAdmin = SUPER_ADMINS.includes(message.author.id);
            if (!isAdmin) {
                const roleId = getSetting('admin_role_id');
                if (roleId && message.member.roles.cache.has(roleId)) isAdmin = true;
                if (message.member.permissions.has('Administrator')) isAdmin = true;
            }

            if (!isAdmin) {
                if (matches.length > 1) {
                    await message.delete().catch(() => {});
                    const w = await message.channel.send(`⚠️ <@${message.author.id}> **One link per message only.**`);
                    setTimeout(() => w.delete().catch(() => {}), 5000);
                    return;
                }

                const existing = db.prepare('SELECT 1 FROM session_activity WHERE discord_id = ?').get(message.author.id);
                if (existing) {
                    await message.delete().catch(() => {});
                    const w = await message.channel.send(`⚠️ <@${message.author.id}> **You have already posted a link this session!**`);
                    setTimeout(() => w.delete().catch(() => {}), 5000);
                    return;
                }
            }

            let addedCount = 0;

            for (const match of matches) {
                let tweetId = match[1];
                let finalDiscordId = message.author.id; 
                
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
                await message.react('💎').catch(() => {});
            }
        }
    }

    // COMMAND LOGIC
    if (!message.content.startsWith('!')) return;
    
    let isAdmin = SUPER_ADMINS.includes(message.author.id);
    if (!isAdmin) {
        const roleId = getSetting('admin_role_id');
        if (roleId && message.member.roles.cache.has(roleId)) isAdmin = true;
        if (message.member.permissions.has('Administrator')) isAdmin = true;
    }

    if (!isAdmin) return; 

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'help') {
        const embed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle('🛡️ Admin Command Center')
            .setDescription('Only admins can execute these commands.')
            .addFields(
                { name: '🕹️ Session Control', value: '`!start` - Force Open Session\n`!close` - Force Close Session\n`!forcereport` - Run Report Now' },
                { name: '👥 User Management', value: '`!register @user @handle` - Link user manually\n`!listusers` - View database' },
                { name: '🔗 Admin Posting', value: '`!post @user <tweet_link>` - Post on behalf of user\n`!mypost <tweet_link>` - Post your own tweet link' },
                { name: '⚙️ Config', value: '`!settime` - Set schedule\n`!setchannel #channel` - Set raid channel\n`!version` - Show bot version' }
            );
        return message.reply({ embeds: [embed] });
    }

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

    if (command === 'post') {
        // Admin posts a tweet link on behalf of a registered user
        if (!isSessionOpen()) {
            return message.reply("❌ Session is not open. Start a session first with `!start`");
        }

        const targetUser = message.mentions.users.first();
        const tweetUrl = args[args.length - 1]; // Last argument should be the URL
        
        if (!targetUser || !tweetUrl) {
            return message.reply("❌ Usage: `!post @user <tweet_link>`");
        }

        const tweetId = extractTweetId(tweetUrl);
        if (!tweetId) {
            return message.reply("❌ Invalid tweet link. Please provide a valid Twitter/X URL.");
        }

        const dbUser = getUser(targetUser.id);
        if (!dbUser) {
            return message.reply(`❌ <@${targetUser.id}> is not registered. Use \`!register @user @handle\` first.`);
        }

        // Check if this user already posted
        const existing = db.prepare('SELECT 1 FROM session_activity WHERE discord_id = ?').get(targetUser.id);
        if (existing) {
            return message.reply(`⚠️ <@${targetUser.id}> has already posted a link this session!`);
        }

        addSessionLink(tweetId, targetUser.id);
        await message.react('💎').catch(() => {});
        await message.reply(`✅ Posted tweet link for <@${targetUser.id}> (@${dbUser.handle})`);
    }

    if (command === 'mypost') {
        // Admin posts their own tweet link (bypassing automatic detection)
        if (!isSessionOpen()) {
            return message.reply("❌ Session is not open. Start a session first with `!start`");
        }

        const tweetUrl = args[0];
        if (!tweetUrl) {
            return message.reply("❌ Usage: `!mypost <tweet_link>`");
        }

        const tweetId = extractTweetId(tweetUrl);
        if (!tweetId) {
            return message.reply("❌ Invalid tweet link. Please provide a valid Twitter/X URL.");
        }

        const dbUser = getUser(message.author.id);
        if (!dbUser) {
            return message.reply(`❌ You are not registered. Use \`!register @${message.author.username} @YourTwitterHandle\` first.`);
        }

        // Check if admin already posted
        const existing = db.prepare('SELECT 1 FROM session_activity WHERE discord_id = ?').get(message.author.id);
        if (existing) {
            return message.reply(`⚠️ You have already posted a link this session!`);
        }

        addSessionLink(tweetId, message.author.id);
        await message.react('💎').catch(() => {});
        await message.reply(`✅ Your tweet link has been added (@${dbUser.handle})`);
    }

    if (command === 'version') return message.reply(`🤖 Bot Version: **${VERSION}**`);
    
    if (command === 'setchannel') {
        const channel = message.mentions.channels.first();
        if (!channel) return message.reply("❌ Usage: `!setchannel #channel`");
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
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`🤖 Version: ${VERSION}`);
    console.log(`📊 Database: ${dbPath}`);
    rescheduleCrons();
});

// Global error handlers
process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
});

client.login(TOKEN);
