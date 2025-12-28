import discord
from discord.ext import commands, tasks
from datetime import datetime, time
import asyncio
import re
import requests
import os
from dotenv import load_dotenv

# Load variables from .env file (for local testing)
load_dotenv()

# ==========================================
# ⚙️ SECURITY & CONFIG
# ==========================================
TOKEN = os.getenv("DISCORD_TOKEN")
RAPID_API_KEY = os.getenv("RAPID_API_KEY")
RAPID_HOST = "twitter241.p.rapidapi.com"
SUPER_ADMIN_ID = 1442310589362999428  # You have permanent access

# Runtime Settings (Set these via commands inside Discord)
# These reset if the bot restarts on Railway unless you hardcode defaults here
SETTINGS = {
    "channel_id": None,
    "admin_role_id": None
}

# Schedule (UTC Time - Railway servers usually run on UTC)
# Adjust these times if your server is in a different timezone
OPEN_TIMES = [time(8, 0), time(14, 0), time(21, 0)] 
SESSION_DURATION_MINUTES = 60 

# ==========================================
# 🤖 BOT SETUP
# ==========================================
intents = discord.Intents.default()
intents.message_content = True
intents.members = True
bot = commands.Bot(command_prefix="!", intents=intents)

# Data Storage
session_tweets = {}   # {"tweet_id": user_id}
registered_users = {} # {user_id: {"handle": "abc", "numeric_id": "123"}}

# ==========================================
# 🛡️ PERMISSION CHECK
# ==========================================
def is_admin():
    async def predicate(ctx):
        # Allow if user is YOU (Super Admin)
        if ctx.author.id == SUPER_ADMIN_ID:
            return True
        # Allow if user has Admin Role
        if SETTINGS["admin_role_id"]:
            role = ctx.guild.get_role(SETTINGS["admin_role_id"])
            if role and role in ctx.author.roles:
                return True
        # Fallback: Check if user has generic "Administrator" permission
        return ctx.author.guild_permissions.administrator
    return commands.check(predicate)

# ==========================================
# 📡 API FUNCTIONS
# ==========================================
def get_numeric_id(username):
    url = f"https://{RAPID_HOST}/user"
    querystring = {"username": username}
    headers = {"x-rapidapi-key": RAPID_API_KEY, "x-rapidapi-host": RAPID_HOST}
    try:
        response = requests.get(url, headers=headers, params=querystring)
        data = response.json()
        if 'result' in data and 'rest_id' in data['result']:
            return data['result']['rest_id']
        elif 'data' in data and 'user' in data['data']:
             return data['data']['user']['result']['rest_id']
        elif 'id' in data:
            return data['id']
    except Exception as e:
        print(f"Error fetching ID: {e}")
    return None

def check_replies(user_numeric_id, target_tweet_ids):
    if not user_numeric_id: return 0
    url = f"https://{RAPID_HOST}/user-replies-v2"
    querystring = {"user": user_numeric_id, "count": "40"} 
    headers = {"x-rapidapi-key": RAPID_API_KEY, "x-rapidapi-host": RAPID_HOST}
    matches = 0
    try:
        response = requests.get(url, headers=headers, params=querystring)
        data = response.json()
        entries = []
        if 'content' in data and 'items' in data['content']:
            entries = data['content']['items']
        elif 'data' in data:
            entries = data['data']
        for tweet in entries:
            reply_to = tweet.get('in_reply_to_status_id_str') or tweet.get('in_reply_to_status_id')
            if reply_to and str(reply_to) in target_tweet_ids:
                matches += 1
    except Exception:
        pass
    return matches

# ==========================================
# 📅 SCHEDULER
# ==========================================
@tasks.loop(minutes=1)
async def raid_scheduler():
    if not SETTINGS["channel_id"]: return # Don't run if not setup
    
    now = datetime.utcnow().time() # Using UTC for Railway
    for start_time in OPEN_TIMES:
        if now.hour == start_time.hour and now.minute == start_time.minute:
            await open_session()
            await asyncio.sleep(SESSION_DURATION_MINUTES * 60)
            await close_and_report()

async def open_session():
    session_tweets.clear()
    channel = bot.get_channel(SETTINGS["channel_id"])
    if not channel: return
    
    await channel.set_permissions(channel.guild.default_role, send_messages=True)
    embed = discord.Embed(title="🟢 RAID SESSION OPEN", color=0x00ff00)
    embed.description = (
        "**START ENGAGING!**\n"
        "1. Post your Tweet Link.\n"
        "2. Reply to everyone else's link.\n"
        "3. Ensure you are registered: `!register @username`"
    )
    await channel.send(embed=embed)

async def close_and_report():
    channel = bot.get_channel(SETTINGS["channel_id"])
    if not channel: return

    await channel.set_permissions(channel.guild.default_role, send_messages=False)
    
    target_ids = list(session_tweets.keys())
    if not target_ids:
        await channel.send("🔴 Session ended. No links posted.")
        return

    await channel.send(f"⏳ **Verifying {len(session_tweets)} participants via API...**")

    results = []
    participants = set(session_tweets.values())
    
    for dc_id in participants:
        user_data = registered_users.get(dc_id)
        if not user_data:
            results.append({"id": dc_id, "handle": "Unknown", "score": 0})
            continue
            
        if not user_data['numeric_id']:
            nid = get_numeric_id(user_data['handle'])
            if nid:
                registered_users[dc_id]['numeric_id'] = nid
                user_data['numeric_id'] = nid
            else:
                results.append({"id": dc_id, "handle": user_data['handle'], "score": 0})
                continue
        
        score = check_replies(user_data['numeric_id'], target_ids)
        score = min(score, len(target_ids))
        
        results.append({"id": dc_id, "handle": user_data['handle'], "score": score})

    results.sort(key=lambda x: x['score'], reverse=True)

    date_str = datetime.now().strftime("%Y-%m-%d")
    report = f"""
═══════════════════════════════════════
📊 RAID REPORT — {date_str}
═══════════════════════════════════════

📈 STATISTICS
▸ Total Tweets: {len(target_ids)}
▸ Participants: {len(results)}

🔍 STATUS
✅ 100% Completed:"""

    for p in results:
        required = len(target_ids) - 1 if len(target_ids) > 1 else 1
        pct = int((p['score'] / required) * 100)
        if pct > 100: pct = 100
        report += f"\n  ▸ <@{p['id']}> (@{p['handle']}) — {p['score']}/{required} ({pct}%)"
    
    report += "\n═══════════════════════════════════════"

    embed = discord.Embed(title="🔴 SESSION CLOSED", color=0xff0000)
    embed.description = f"Session Ended. {len(results)} checked."
    await channel.send(embed=embed)
    
    if len(report) > 1900:
        await channel.send(report[:1900])
        await channel.send(report[1900:])
    else:
        await channel.send(report)

# ==========================================
# 🛠️ SETUP COMMANDS (Admin/Owner Only)
# ==========================================

@bot.command()
@is_admin()
async def setchannel(ctx, channel: discord.TextChannel):
    """Set the channel where raids happen. Usage: !setchannel #general"""
    SETTINGS["channel_id"] = channel.id
    await ctx.send(f"✅ Raid channel set to: {channel.mention}")

@bot.command()
@is_admin()
async def setrole(ctx, role: discord.Role):
    """Set the Admin role for the bot. Usage: !setrole @Admin"""
    SETTINGS["admin_role_id"] = role.id
    await ctx.send(f"✅ Admin role set to: {role.name}")

@bot.command()
@is_admin()
async def config(ctx):
    """Check current settings."""
    ch = f"<#{SETTINGS['channel_id']}>" if SETTINGS['channel_id'] else "Not Set"
    rl = f"<@&{SETTINGS['admin_role_id']}>" if SETTINGS['admin_role_id'] else "Not Set"
    await ctx.send(f"⚙️ **Current Config:**\nRaid Channel: {ch}\nAdmin Role: {rl}\nSuper Admin: <@{SUPER_ADMIN_ID}>")

@bot.command()
@is_admin()
async def forceraid(ctx):
    """Manually start a raid now."""
    if not SETTINGS["channel_id"]:
        return await ctx.send("❌ Setup channel first! `!setchannel #name`")
    await ctx.send("Force starting session...")
    await open_session()

@bot.command()
@is_admin()
async def forceclose(ctx):
    """Manually end a raid now."""
    if not SETTINGS["channel_id"]:
        return await ctx.send("❌ Setup channel first! `!setchannel #name`")
    await ctx.send("Force closing session...")
    await close_and_report()

# ==========================================
# 👤 USER COMMANDS
# ==========================================
@bot.command()
async def register(ctx, handle):
    clean_handle = handle.replace("@", "").strip()
    msg = await ctx.reply(f"🔄 Linking @{clean_handle}...")
    nid = get_numeric_id(clean_handle)
    
    if nid:
        registered_users[ctx.author.id] = {"handle": clean_handle, "numeric_id": nid}
        await msg.edit(content=f"✅ Registered @{clean_handle} (ID: {nid})")
    else:
        registered_users[ctx.author.id] = {"handle": clean_handle, "numeric_id": None}
        await msg.edit(content=f"⚠️ Registered @{clean_handle} (ID lookup failed, retrying during raid).")

@bot.event
async def on_message(message):
    if message.author.bot: return

    # Link Collector
    if SETTINGS["channel_id"] and message.channel.id == SETTINGS["channel_id"]:
        match = re.search(r'status/(\d+)', message.content)
        if match:
            tweet_id = match.group(1)
            session_tweets[tweet_id] = message.author.id
            await message.add_reaction("👀")

    await bot.process_commands(message)

@bot.event
async def on_ready():
    print(f"Logged in as {bot.user}")
    raid_scheduler.start()

if __name__ == "__main__":
    if not TOKEN:
        print("❌ Error: DISCORD_TOKEN not found in environment variables.")
    else:
        bot.run(TOKEN)
