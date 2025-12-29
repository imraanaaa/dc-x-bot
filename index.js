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

// 🔒 SECURITY FIX: Key is now ONLY read from Environment Variables
const RAPID_API_KEY = process.env.RAPID_API_KEY; 
if (!RAPID_API_KEY) console.warn("⚠️ WARNING: RAPID_API_KEY is missing in Railway Variables!");

const RAPID_HOST = "twitter241.p.rapidapi.com";

// 👑 ADMIN LIST
const SUPER_ADMINS = [
    "1442310589362999428", // You
    "1442618881285034099"  // Second Admin
];

const VERSION = "v12.0 (Secure + Help)";

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
    if (!channelId) return console.log("⚠️ No Channel Set. Skipping Session.");

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

    await channel.send(`⏳ **Checking last 100 replies for ${sessionTweets.size} participants...**`);

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
            completedList += `\n✅ <@${p.id}> — **${p.score}/${req}**`;
        } else {
            const filled = Math.round((pct / 100) * 5);
            const empty = 5 - filled;
            const bar = "🟩".repeat(filled) + "⬜".repeat(empty);
            incompleteList += `\n⚠️ <@${p.id}> — **${p.score}/${req}** ${bar} (${pct}%)`;
        }
    }

    let report = `
═══════════════════════════════════════
💎 **ELITE RAID REPORT** — ${dateStr}
═══════════════════════════════════════

🎯 **SESSION STATS**
▸ Total Links: **${targets.length}**
▸ Participants: **${results.length}**

🌟 **COMPLETED RAIDERS** (${completeCount})
${completedList || "  *(None this session)*"}

🚧 **INCOMPLETE RAIDERS**
${incompleteList || "  *(Everyone completed!)*"}

═══════════════════════════════════════
🏆 **Excellent Work, Elites!**
`;

    const embed = new EmbedBuilder()
        .setTitle("🔴 SESSION CLOSED")
        .setDescription(`Checked ${results.length} users.`)
        .setColor(0xFF0000)
        .setTimestamp();

    await channel.send({ embeds: [embed] });
    
    if (report.length > 1900) {
        const chunks = report.match(/[\s\S]{1,1900}/g) || [];
        for (const chunk of chunks) await channel.send(chunk);
    } else {
        await channel.send(report);
    }
}

// ==========================================
// ⏰ DYNAMIC SCHEDULER
// ==========================================
function rescheduleCrons() {
    activeCronJobs.forEach(job => job.stop());
    activeCronJobs = [];

    const h1 = getSetting('session1_hour') || "8";
    const h2 = getSetting('session2_hour') || "14";
    const h3 = getSetting('session3_hour') || "21";

    [h1, h2, h3].forEach(h => {
        const job = cron.schedule(`0 ${h} * * *`, () => {
            console.log(`⏰ Auto-Starting Session (Hour: ${h})`);
            openSession();
            setTimeout(() => {
                console.log(`⏰ Auto-Closing Session (Hour: ${h})`);
                closeAndReport();
            }, 60 * 60 * 1000);
        });
        activeCronJobs.push(job);
    });
}

// ==========================================
// 🛠️ COMMANDS
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
                    const warning = await message.channel.send(`<@${message.author.id}> ⛔ **Access Denied.**\nYou are not registered. Ask an Admin.`);
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
    // 👮 PERMISSIONS
    // ==================================================
    let isAdmin = SUPER_ADMINS.includes(message.author.id);
    if (!isAdmin) {
        const roleId = getSetting('admin_role_id');
        if (roleId && message.member.roles.cache.has(roleId)) isAdmin = true;
        if (message.member.permissions.has('Administrator')) isAdmin = true;
    }

    // ==================================================
    // 🛡️ HELP COMMAND (ADMIN ONLY)
    // ==================================================
    if (command === 'help') {
        if (!isAdmin) return; // Silent fail for non-admins
        
        const embed = new EmbedBuilder()
            .setTitle("🛡️ Elite Raid Admin Menu")
            .setColor(0x0099FF)
            .addFields(
                { name: '⚙️ Setup', value: '`!setchannel #raid` - Set raid channel\n`!setrole @role` - Add admin role\n`!settime` - Configure Auto-Schedule' },
                { name: '⚡ Control', value: '`!start` - Force open session\n`!end` - Force close & report\n`!register @user @handle` - Manually link user' },
                { name: '🔧 Tools', value: '`!diagnose @handle` - Test API\n`!version` - Check bot version' }
            )
            .setFooter({ text: 'Visible only to Admins' });
        
        return message.reply({ embeds: [embed] });
    }

    // ==================================================
    // 👑 ADMIN COMMANDS
    // ==================================================
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

        const embed = new EmbedBuilder()
            .setTitle("⏰ Configure Schedule (UTC)")
            .setDescription("Select start times. Sessions run for 1 hour.")
            .setColor(0x0099FF);

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
            await i.reply({ content: `✅ Updated to **${val}:00 UTC**.`, ephemeral: true });
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

    if (command === 'diagnose') {
        const handle = args[0]?.replace('@', '');
        if (!handle) return message.reply("Usage: `!diagnose @username`");
        await message.reply(`🕵️ Diagnosing @${handle}...`);
        const nid = await getNumericId(handle);
        if (!nid) return message.channel.send("❌ ID Lookup Failed.");
        message.channel.send(`✅ ID: \`${nid}\`. Checking replies...`);
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
            if (ids.size === 0) message.channel.send("⚠️ Connected, but found 0 replies.");
            else message.channel.send(`✅ API Healthy. Found ${ids.size} replies.`);
        } catch (e) { message.channel.send(`❌ API Error: ${e.message}`); }
    }

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
    rescheduleCrons();
});

client.login(TOKEN);
