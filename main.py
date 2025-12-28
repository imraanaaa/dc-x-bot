import discord
from discord.ext import commands, tasks
from datetime import datetime, time, timezone
import asyncio
import re
import requests
import os
import json
from dotenv import load_dotenv

# Load .env (for local testing)
load_dotenv()

# ==========================================
# ⚙️ CONFIG & PATHS
# ==========================================
TOKEN = os.getenv("DISCORD_TOKEN")
RAPID_API_KEY = os.getenv("RAPID_API_KEY")
RAPID_HOST = "twitter241.p.rapidapi.com"
SUPER_ADMIN_ID = 1442310589362999428

# 📂 DATA PERSISTENCE
DATA_DIR = "/dataaa"
DATA_FILE = os.path.join(DATA_DIR, "users.json")

# Runtime Settings
SETTINGS = {
    "channel_id": None,
    "admin_role_id": None
}

# Schedule (UTC Time)
OPEN_TIMES = [time(8, 0), time(14, 0), time(21, 0)] 
SESSION_DURATION_MINUTES = 60 

# ==========================================
# 💾 DATA MANAGER
# ==========================================
def load_data():
    if not os.path.exists(DATA_DIR):
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
        except OSError as e:
            print(f"⚠️ Could not create data directory: {e}")
            return {}
    
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r") as f:
                data = json.load(f)
                return {int(k): v for k, v in data.items()}
        except Exception as e:
            print(f"⚠️ Error loading data: {e}")
    return {}

def save_data():
    try:
        with open(DATA_FILE, "w") as f:
            json.dump(registered_users, f)
    except Exception as e:
        print(f"⚠️ Error saving data: {e}")

# ==========================================
# 🤖 BOT SETUP
# ==========================================
intents = discord.Intents.default()
intents.message_content = True 
intents.members = True         
bot = commands.Bot(command_prefix="!", intents=intents)

registered_users = load_data() 
session_tweets = {} 

# ==========================================
# 🛡️ PERMISSION CHECK
# ==========================================
def is_admin():
    async def predicate(ctx):
        if ctx.author.id == SUPER_ADMIN_ID: return True
        if SETTINGS["admin_role_id"]:
            role = ctx.guild.get_role(SETTINGS["admin_role_id"])
            if role and role in ctx.author.roles: return True
        return ctx.author.guild_permissions.administrator
    return commands.check(predicate)

# ==========================================
# 📡 API FUNCTIONS (DEBUG MODE ADDED)
# ==========================================
def get_numeric_id(username):
    url = f"https://{RAPID_HOST}/user"
    querystring = {"username": username}
    headers = {"x-rapidapi-key": RAPID_API_KEY, "x-rapidapi-host": RAPID_HOST}
    
    print(f"🔍 DEBUG: Looking up ID for {username}...") # Log start
    
    try:
        response = requests.get(url, headers=headers, params=querystring)
        data = response.json()
        
        # PRINT THE RAW DATA TO LOGS SO WE CAN SEE ERRORS
        print(f"🔍 DEBUG API RESPONSE: {data}")

        if 'result' in data and 'rest_id' in data['result']:
            return data['result']['rest_id']
        elif 'data' in data and 'user' in data['data']:
             return data['data']['user']['result']['rest_id']
        elif 'id' in data:
            return data['id']
            
    except Exception as e:
        print(f"❌ API Error fetching ID: {e}")
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
        
        # Basic parsing attempt
        if 'content' in data and 'items' in data['content']:
            entries = data['content']['items']
        elif 'data' in data:
            entries = data['data']
            
        for tweet in entries:
            reply_to = tweet.get('in_reply_to_status_id_str') or tweet.get('in_reply_to_status_id')
            if reply_to and str(reply_to) in target_tweet_ids:
                matches += 1
    except Exception as e:
        print(f"❌ API Error checking replies: {e}")
    return matches

# ==========================================
# 📅 SCHEDULER
# ==========================================
@tasks.loop(minutes=1)
async def raid_scheduler():
    if not SETTINGS["channel_id"]: return
    # FIXED DEPRECATION WARNING BELOW:
    now = datetime.now(timezone.utc).time()
    
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
    embed.description = "Post your link, reply to others, and use `!register @user` if new!"
    await channel.send(embed=embed)

async def close_and_report():
    channel = bot.get_channel(SETTINGS["channel_id"])
    if not channel: return

    await channel.set_permissions(channel.guild.default_role, send_messages=False)
    
    target_ids = list(session_tweets.keys())
    if not target_ids:
        await channel.send("🔴 Session ended. No links posted.")
        return

    await channel.send(f"⏳ **Checking replies for {len(session_tweets)} participants...**")

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
                save_data()
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
📊 REPORT — {date_str}
═══════════════════════════════════════
Total Tweets: {len(target_ids)} | Participants: {len(results)}
✅ 100% Completed:"""

    for p in results:
        required = len(target_ids) - 1 if len(target_ids) > 1 else 1
        pct = int((p['score'] / required) * 100)
        if pct > 100: pct = 100
        report += f"\n  ▸ <@{p['id']}> — {p['score']}/{required} ({pct}%)"
    
    report += "\n═══════════════════════════════════════"

    await channel.send(embed=discord.Embed(title="🔴 SESSION CLOSED", description=f"Checked {len(results)} users.", color=0xff0000))
    if len(report) > 1900:
        await channel.send(report[:1900])
        await channel.send(report[1900:])
    else:
        await channel.send(report)

# ==========================================
# 🛠️ ADMIN COMMANDS
# ==========================================
@bot.command()
@is_admin()
async def setchannel(ctx, channel: discord.TextChannel):
    SETTINGS["channel_id"] = channel.id
    await ctx.send(f"✅ Raid channel: {channel.mention}")

@bot.command()
@is_admin()
async def setrole(ctx, role: discord.Role):
    SETTINGS["admin_role_id"] = role.id
    await ctx.send(f"✅ Admin role: {role.name}")

@bot.command(aliases=['forceclose'])
@is_admin()
async def end(ctx):
    if not SETTINGS["channel_id"]:
        return await ctx.send("❌ Setup channel first! `!setchannel #name`")
    await ctx.send("🛑 **Ending session & Checking replies...**")
    await close_and_report()

@bot.command()
@is_admin()
async def start(ctx):
    if not SETTINGS["channel_id"]:
        return await ctx.send("❌ Setup channel first! `!setchannel #name`")
    await ctx.send("🚀 **Force starting session...**")
    await open_session()

@bot.command()
@is_admin()
async def config(ctx):
    """Check current settings."""
    ch = f"<#{SETTINGS['channel_id']}>" if SETTINGS['channel_id'] else "Not Set"
    rl = f"<@&{SETTINGS['admin_role_id']}>" if SETTINGS['admin_role_id'] else "Not Set"
    await ctx.send(f"⚙️ **Current Config:**\nRaid Channel: {ch}\nAdmin Role: {rl}\nSuper Admin: <@{SUPER_ADMIN_ID}>")

# ==========================================
# 👤 USER COMMANDS
# ==========================================
@bot.command()
async def register(ctx, handle):
    clean_handle = handle.replace("@", "").strip()
    msg = await ctx.reply(f"🔄 Linking @{clean_handle}...")
    
    # Debugging print
    print(f"📝 User {ctx.author.name} requesting register for {clean_handle}")
    
    nid = get_numeric_id(clean_handle)
    
    registered_users[ctx.author.id] = {"handle": clean_handle, "numeric_id": nid}
    save_data()
    
    if nid:
        await msg.edit(content=f"✅ Registered @{clean_handle} (ID: {nid})")
    else:
        await msg.edit(content=f"⚠️ Registered @{clean_handle} (ID lookup failed - Check Logs)")

@bot.event
async def on_message(message):
    if message.author.bot: return
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
    if TOKEN: bot.run(TOKEN)
