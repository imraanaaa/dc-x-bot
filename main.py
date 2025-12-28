import discord
from discord.ext import commands, tasks
from datetime import datetime, time, timezone
import asyncio
import re
import requests
import os
import json
from dotenv import load_dotenv

load_dotenv()

# ==========================================
# ⚙️ CONFIG
# ==========================================
TOKEN = os.getenv("DISCORD_TOKEN")
RAPID_API_KEY = os.getenv("RAPID_API_KEY")
RAPID_HOST = "twitter241.p.rapidapi.com"
SUPER_ADMIN_ID = 1442310589362999428
BOT_VERSION = "v3.2 (Dynamic Count)"

DATA_DIR = "/dataaa"
DATA_FILE = os.path.join(DATA_DIR, "users.json")

SETTINGS = {
    "channel_id": None,
    "admin_role_id": None
}

# 8 AM, 2 PM, 9 PM (UTC)
OPEN_TIMES = [time(8, 0), time(14, 0), time(21, 0)] 
SESSION_DURATION_MINUTES = 60 

# ==========================================
# 💾 DATA MANAGER
# ==========================================
def load_data():
    if not os.path.exists(DATA_DIR):
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
        except OSError: return {}
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r") as f:
                data = json.load(f)
                return {int(k): v for k, v in data.items()}
        except Exception: pass
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
# 📡 API FUNCTIONS (NUCLEAR SEARCH + DYNAMIC COUNT)
# ==========================================
def find_key_recursive(data, target_key):
    """Finds a key anywhere in JSON."""
    if isinstance(data, dict):
        for k, v in data.items():
            if k == target_key: return v
            item = find_key_recursive(v, target_key)
            if item is not None: return item
    elif isinstance(data, list):
        for item in data:
            result = find_key_recursive(item, target_key)
            if result is not None: return result
    return None

def get_numeric_id(username):
    url = f"https://{RAPID_HOST}/user"
    querystring = {"username": username}
    headers = {"x-rapidapi-key": RAPID_API_KEY, "x-rapidapi-host": RAPID_HOST}
    
    print(f"🔍 Lookup ID for {username}...") 
    try:
        response = requests.get(url, headers=headers, params=querystring)
        data = response.json()
        
        # 1. Try Nuclear Search for 'rest_id'
        rid = find_key_recursive(data, 'rest_id')
        if rid: return rid
        
        # 2. Try 'id'
        sid = find_key_recursive(data, 'id')
        if sid and str(sid).isdigit(): return sid
        
    except Exception as e:
        print(f"❌ Error fetching ID: {e}")
    return None

def check_replies(user_numeric_id, target_tweet_ids):
    if not user_numeric_id: return 0
    
    # 🧠 SMART LOGIC: Dynamic Count based on Participants
    # If 50 people joined, we check 70 tweets. If 2 joined, we check 20.
    needed_count = len(target_tweet_ids) + 20
    if needed_count < 20: needed_count = 20
    if needed_count > 100: needed_count = 100 # Cap at 100 to prevent API errors
    
    url = f"https://{RAPID_HOST}/user-replies-v2"
    querystring = {"user": user_numeric_id, "count": str(needed_count)} 
    headers = {"x-rapidapi-key": RAPID_API_KEY, "x-rapidapi-host": RAPID_HOST}
    
    matches = 0
    try:
        response = requests.get(url, headers=headers, params=querystring)
        data = response.json()
        
        # NUCLEAR SEARCH for 'in_reply_to_status_id_str'
        # We manually crawl the JSON to find ALL occurrences of this key
        # This is safer than guessing the path
        
        found_ids = set()
        
        def collect_reply_ids(obj):
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if k == 'in_reply_to_status_id_str' or k == 'in_reply_to_status_id':
                        if v: found_ids.add(str(v))
                    else:
                        collect_reply_ids(v)
            elif isinstance(obj, list):
                for item in obj:
                    collect_reply_ids(item)
                    
        collect_reply_ids(data)
        
        # Count matches
        for tid in target_tweet_ids:
            if tid in found_ids:
                matches += 1

    except Exception as e:
        print(f"❌ Error checking replies: {e}")
    return matches

# ==========================================
# 📅 SCHEDULER
# ==========================================
@tasks.loop(minutes=1)
async def raid_scheduler():
    if not SETTINGS["channel_id"]: return
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
    embed.description = "Post links & Reply! Type `!register @username` if new."
    await channel.send(embed=embed)

async def close_and_report():
    channel = bot.get_channel(SETTINGS["channel_id"])
    if not channel: return
    await channel.set_permissions(channel.guild.default_role, send_messages=False)
    
    target_ids = list(session_tweets.keys())
    if not target_ids:
        await channel.send("🔴 Session ended. No links.")
        return

    # Notify about dynamic check
    check_count = len(target_ids) + 20
    if check_count > 100: check_count = 100
    await channel.send(f"⏳ **Checking last {check_count} replies for {len(session_tweets)} users...**")
    
    results = []
    participants = set(session_tweets.values())
    
    for dc_id in participants:
        user = registered_users.get(dc_id)
        
        # Ensure we have data
        if not user or not user['numeric_id']:
            handle = user['handle'] if user else "Unknown"
            # Try last minute lookup
            if user:
                nid = get_numeric_id(handle)
                if nid: 
                    registered_users[dc_id]['numeric_id'] = nid
                    user['numeric_id'] = nid
                    save_data()
            
            if not user or not user['numeric_id']:
                results.append({"id": dc_id, "handle": handle, "score": 0})
                continue
        
        score = check_replies(user['numeric_id'], target_ids)
        score = min(score, len(target_ids))
        results.append({"id": dc_id, "handle": user['handle'], "score": score})

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
def is_admin():
    async def predicate(ctx):
        if ctx.author.id == SUPER_ADMIN_ID: return True
        if SETTINGS["admin_role_id"]:
            role = ctx.guild.get_role(SETTINGS["admin_role_id"])
            if role and role in ctx.author.roles: return True
        return ctx.author.guild_permissions.administrator
    return commands.check(predicate)

@bot.command()
async def version(ctx):
    await ctx.reply(f"🤖 Bot Version: **{BOT_VERSION}**")

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

@bot.command(aliases=['forceraid'])
@is_admin()
async def start(ctx):
    if not SETTINGS["channel_id"]:
        return await ctx.send("❌ Setup channel first! `!setchannel #name`")
    await ctx.send("🚀 **Force starting session...**")
    await open_session()

# ==========================================
# 👤 USER COMMANDS
# ==========================================
@bot.command()
async def register(ctx, handle):
    clean_handle = handle.replace("@", "").strip()
    msg = await ctx.reply(f"🔄 Linking @{clean_handle}...")
    
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
    print(f"Logged in as {bot.user} - {BOT_VERSION}")
    raid_scheduler.start()

if __name__ == "__main__":
    if TOKEN: bot.run(TOKEN)
