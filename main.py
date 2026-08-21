import os
import sys
import time
import random
from datetime import datetime

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import discord
from discord import app_commands
from discord.ext import commands, tasks

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN")
CLIENT_ID = os.getenv("CLIENT_ID")
ROLE_ID = int(os.getenv("ROLE_ID")) if os.getenv("ROLE_ID") and os.getenv("ROLE_ID").isdigit() else None
UNVERIFIED_ROLE_ID = int(os.getenv("UNVERIFIED_ROLE_ID")) if os.getenv("UNVERIFIED_ROLE_ID") and os.getenv("UNVERIFIED_ROLE_ID").isdigit() else None
LOG_CHANNEL_ID = int(os.getenv("LOG_CHANNEL_ID")) if os.getenv("LOG_CHANNEL_ID") and os.getenv("LOG_CHANNEL_ID").isdigit() else None

if not DISCORD_TOKEN:
    print("エラー: 環境変数 DISCORD_TOKEN が設定されていません。")
    sys.exit(1)

# クールダウン管理 (連打・DoS防止)
cooldowns = {}
COOLDOWN_TIME = 3.0
start_time = time.time()
status_index = 0

def check_cooldown(user_id: int) -> float | None:
    now = time.time()
    last_time = cooldowns.get(user_id)
    if last_time and (now - last_time) < COOLDOWN_TIME:
        return round(COOLDOWN_TIME - (now - last_time), 1)
    cooldowns[user_id] = now
    return None

def generate_captcha(length: int = 4) -> str:
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choices(chars, k=length))

def format_uptime(seconds: float) -> str:
    seconds = int(seconds)
    d = seconds // 86400
    h = (seconds % 86400) // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    parts = []
    if d > 0:
        parts.append(f"{d}日")
    if h > 0:
        parts.append(f"{h}時間")
    if m > 0:
        parts.append(f"{m}分")
    parts.append(f"{s}秒")
    return " ".join(parts)

# 認証ログ送信ヘルパー
async def send_auth_log(guild: discord.Guild, user: discord.User | discord.Member, role: discord.Role | None, removed_role: discord.Role | None = None):
    if not LOG_CHANNEL_ID:
        return
    try:
        channel = guild.get_channel(LOG_CHANNEL_ID)
        if not channel:
            channel = await guild.fetch_channel(LOG_CHANNEL_ID)
        if channel and isinstance(channel, discord.TextChannel):
            embed = discord.Embed(
                title="📋 認証ログ",
                description="ユーザーが認証を完了しました。",
                color=discord.Color.green(),
                timestamp=datetime.now()
            )
            embed.add_field(name="ユーザー", value=f"{user} ({user.mention})", inline=True)
            embed.add_field(name="ユーザーID", value=str(user.id), inline=True)
            embed.add_field(name="付与ロール", value=role.mention if role else "不明", inline=True)
            if removed_role:
                embed.add_field(name="剥奪ロール", value=removed_role.mention, inline=True)
            if user.avatar:
                embed.set_thumbnail(url=user.avatar.url)
            await channel.send(embed=embed)
    except Exception as e:
        print(f"ログ送信エラー: {e}")

# ウェルカムDM送信ヘルパー
async def send_welcome_dm(member: discord.Member):
    try:
        embed = discord.Embed(
            title=f"🎉 {member.guild.name} へようこそ！",
            description="認証が完了し、チャンネルが利用可能になりました！\nサーバーのルールをご確認の上、お楽しみください。",
            color=discord.Color.green(),
            timestamp=datetime.now()
        )
        await member.send(embed=embed)
    except Exception:
        pass

# 共通ロール付与 & 剥奪処理
async def handle_role_assignment(interaction: discord.Interaction, target_role_id: int | None, remove_role_id: int | None):
    guild = interaction.guild
    if not guild:
        return await interaction.response.send_message("この操作はサーバー内でのみ有効です。", ephemeral=True)

    role_id = target_role_id or ROLE_ID
    if not role_id:
        return await interaction.response.send_message("エラー: 付与するロールが設定されていません。管理者に連絡してください。", ephemeral=True)

    role = guild.get_role(role_id)
    if not role:
        try:
            role = await guild.fetch_role(role_id)
        except Exception:
            role = None

    if not role:
        return await interaction.response.send_message("エラー: 付与するロールが見つかりません。管理者に連絡してください。", ephemeral=True)

    member = interaction.user
    if not isinstance(member, discord.Member):
        try:
            member = await guild.fetch_member(interaction.user.id)
        except Exception:
            return await interaction.response.send_message("エラー: ユーザー情報の取得に失敗しました。", ephemeral=True)

    if role in member.roles:
        return await interaction.response.send_message("すでに認証されています！", ephemeral=True)

    try:
        await member.add_roles(role)

        r_id = remove_role_id or UNVERIFIED_ROLE_ID
        removed_role = None
        if r_id:
            unverified_role = guild.get_role(r_id)
            if not unverified_role:
                try:
                    unverified_role = await guild.fetch_role(r_id)
                except Exception:
                    unverified_role = None
            if unverified_role and unverified_role in member.roles:
                try:
                    await member.remove_roles(unverified_role)
                    removed_role = unverified_role
                except Exception as err:
                    print(f"ロール剥奪エラー: {err}")

        await interaction.response.send_message("認証が完了しました！ロールを付与しました🎉", ephemeral=True)

        await send_auth_log(guild, member, role, removed_role)
        await send_welcome_dm(member)
    except discord.Forbidden:
        await interaction.response.send_message("エラーが発生しました。Botのロール位置が、付与・剥奪したいロールより上にあるか確認してください！", ephemeral=True)
    except Exception as e:
        print(f"ロール操作エラー: {e}")
        await interaction.response.send_message("予期せぬエラーが発生しました。管理者に連絡してください。", ephemeral=True)

# モーダル定義
class CaptchaModal(discord.ui.Modal, title="サーバー認証 (CAPTCHA)"):
    def __init__(self, target_role_id: int | None, remove_role_id: int | None, expected_captcha: str):
        super().__init__()
        self.target_role_id = target_role_id
        self.remove_role_id = remove_role_id
        self.expected_captcha = expected_captcha

        self.captcha_input = discord.ui.TextInput(
            label=f"確認コード「{expected_captcha}」を入力",
            placeholder=expected_captcha,
            min_length=4,
            max_length=4,
            required=True
        )
        self.add_item(self.captcha_input)

    async def on_submit(self, interaction: discord.Interaction):
        if self.captcha_input.value.strip().upper() != self.expected_captcha.upper():
            return await interaction.response.send_message("❌ 認証コードが一致しません。もう一度やり直してください。", ephemeral=True)
        await handle_role_assignment(interaction, self.target_role_id, self.remove_role_id)

class PassphraseModal(discord.ui.Modal, title="サーバー認証 (合言葉)"):
    def __init__(self, target_role_id: int | None, remove_role_id: int | None, expected_passphrase: str):
        super().__init__()
        self.target_role_id = target_role_id
        self.remove_role_id = remove_role_id
        self.expected_passphrase = expected_passphrase

        self.pass_input = discord.ui.TextInput(
            label="合言葉を入力してください",
            placeholder="ルール等に書かれた合言葉",
            required=True
        )
        self.add_item(self.pass_input)

    async def on_submit(self, interaction: discord.Interaction):
        if self.pass_input.value.strip() != self.expected_passphrase.strip():
            return await interaction.response.send_message("❌ 合言葉が間違っています。もう一度お試しください。", ephemeral=True)
        await handle_role_assignment(interaction, self.target_role_id, self.remove_role_id)

class TermsModal(discord.ui.Modal, title="サーバー認証 (利用規約同意)"):
    def __init__(self, target_role_id: int | None, remove_role_id: int | None):
        super().__init__()
        self.target_role_id = target_role_id
        self.remove_role_id = remove_role_id

        self.terms_input = discord.ui.TextInput(
            label="「同意する」と入力してください",
            placeholder="同意する",
            required=True
        )
        self.add_item(self.terms_input)

    async def on_submit(self, interaction: discord.Interaction):
        val = self.terms_input.value.strip()
        if val not in ("同意する", "同意") and val.lower() != "agree":
            return await interaction.response.send_message("❌ 「同意する」と正確に入力してください。", ephemeral=True)
        await handle_role_assignment(interaction, self.target_role_id, self.remove_role_id)

# Botクラス
class AuthBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.guilds = True
        intents.members = True
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        try:
            synced = await self.tree.sync()
            print(f"コマンド同期成功: {len(synced)} 件")
        except Exception as e:
            print(f"コマンド同期エラー: {e}")

bot = AuthBot()

# ステータスローテーション (10秒ごと)
@tasks.loop(seconds=10)
async def rotate_status():
    global status_index
    if not bot.is_ready() or not bot.user:
        return

    total_members = sum(g.member_count or 0 for g in bot.guilds)
    total_guilds = len(bot.guilds)
    ping = max(0, round(bot.latency * 1000))

    statuses = [
        f"{total_members}人 | {total_guilds}鯖",
        f"ping {ping}ms",
        "Powered by rds9"
    ]

    text = statuses[status_index % len(statuses)]
    status_index += 1

    activity = discord.CustomActivity(name=text)
    await bot.change_presence(activity=activity, status=discord.Status.online)

@bot.event
async def on_ready():
    print(f"認証Bot起動完了！ ({bot.user})")
    if not rotate_status.is_running():
        rotate_status.start()

# ボタンクリック検知リスナー
@bot.listen("on_interaction")
async def on_button_click(interaction: discord.Interaction):
    if interaction.type != discord.InteractionType.component:
        return

    custom_id = interaction.data.get("custom_id", "")

    # 連打防止
    rem = check_cooldown(interaction.user.id)
    if rem is not None:
        return await interaction.response.send_message(f"⚠️ 操作が早すぎます。あと **{rem}秒** 待ってから再度お試しください。", ephemeral=True)

    # 旧バージョン互換
    if custom_id == "auth_button":
        return await handle_role_assignment(interaction, None, None)

    if custom_id.startswith("auth_btn:"):
        parts = custom_id.split(":")
        role_id = int(parts[1]) if len(parts) > 1 and parts[1] != "default" and parts[1].isdigit() else None
        remove_role_id = int(parts[2]) if len(parts) > 2 and parts[2] != "none" and parts[2].isdigit() else None
        auth_type = parts[3] if len(parts) > 3 else "direct"

        if auth_type == "captcha":
            captcha = generate_captcha(4)
            return await interaction.response.send_modal(CaptchaModal(role_id, remove_role_id, captcha))

        if auth_type == "pass":
            passphrase = ":".join(parts[4:]) if len(parts) > 4 else ""
            return await interaction.response.send_modal(PassphraseModal(role_id, remove_role_id, passphrase))

        if auth_type == "terms":
            return await interaction.response.send_modal(TermsModal(role_id, remove_role_id))

        # direct
        return await handle_role_assignment(interaction, role_id, remove_role_id)

# === スラッシュコマンド ===

@bot.tree.command(name="set-panel", description="認証パネルをこのチャンネルに設置します（管理者限定）")
@app_commands.default_permissions(administrator=True)
@app_commands.describe(
    role="認証時に付与するロール（未指定時はデフォルトロール）",
    remove_role="認証時に剥奪するロール（未認証ロール等）",
    title="パネルのタイトル",
    description="パネルの説明文",
    button_label="ボタンのテキスト（デフォルト: 認証する）",
    auth_type="認証の方式（デフォルト: ワンクリック）",
    passphrase="合言葉認証を選択した場合の正解キーワード",
    terms_text="規約同意認証で表示する規約メッセージ"
)
@app_commands.choices(auth_type=[
    app_commands.Choice(name="ワンクリック認証", value="direct"),
    app_commands.Choice(name="CAPTCHA認証（ランダム文字列）", value="captcha"),
    app_commands.Choice(name="合言葉認証（キーワード入力）", value="passphrase"),
    app_commands.Choice(name="規約同意認証（同意入力）", value="terms"),
])
async def set_panel(
    interaction: discord.Interaction,
    role: discord.Role | None = None,
    remove_role: discord.Role | None = None,
    title: str = "✅ サーバー認証",
    description: str = "下のボタンを押して認証を完了し、すべてのチャンネルを解放してください。",
    button_label: str = "認証する",
    auth_type: app_commands.Choice[str] | None = None,
    passphrase: str | None = None,
    terms_text: str = "本サーバーのルールを守り、他のメンバーへ迷惑となる行為を行わないことに同意します。"
):
    selected_auth = auth_type.value if auth_type else "direct"
    if selected_auth == "passphrase" and not passphrase:
        return await interaction.response.send_message("エラー: 合言葉認証を選択した場合は「passphrase」オプションで合言葉を指定してください。", ephemeral=True)

    role_id_str = str(role.id) if role else "default"
    remove_role_id_str = str(remove_role.id) if remove_role else "none"

    if selected_auth == "passphrase":
        custom_id = f"auth_btn:{role_id_str}:{remove_role_id_str}:pass:{passphrase}"
    elif selected_auth == "terms":
        custom_id = f"auth_btn:{role_id_str}:{remove_role_id_str}:terms"
    else:
        custom_id = f"auth_btn:{role_id_str}:{remove_role_id_str}:{selected_auth}"

    embed = discord.Embed(
        title=title,
        description=description,
        color=discord.Color.green()
    )

    if selected_auth == "terms":
        embed.add_field(name="📜 利用規約", value=terms_text, inline=False)

    view = discord.ui.View(timeout=None)
    button = discord.ui.Button(
        label=button_label,
        style=discord.ButtonStyle.success,
        emoji="🔓",
        custom_id=custom_id
    )
    view.add_item(button)

    await interaction.response.send_message("認証パネルを設置しました！", ephemeral=True)
    if interaction.channel:
        await interaction.channel.send(embed=embed, view=view)

@bot.tree.command(name="ping", description="Botの応答速度（Ping）を測定します")
async def ping(interaction: discord.Interaction):
    ws_ping = max(0, round(bot.latency * 1000))
    status_text = "🟢 良好" if ws_ping < 150 else ("🟡 普通" if ws_ping < 300 else "🔴 遅延")
    color = discord.Color.green() if ws_ping < 150 else (discord.Color.gold() if ws_ping < 300 else discord.Color.red())

    embed = discord.Embed(title="🏓 Pong!", color=color, timestamp=datetime.now())
    embed.add_field(name="WebSocket Ping", value=f"{ws_ping} ms", inline=True)
    embed.add_field(name="ステータス", value=status_text, inline=True)
    embed.set_footer(text="Powered by rds9")

    await interaction.response.send_message(embed=embed, ephemeral=True)

@bot.tree.command(name="stats", description="サーバーの認証統計やBotの稼働状態を表示します")
async def stats(interaction: discord.Interaction):
    guild = interaction.guild
    if not guild:
        return await interaction.response.send_message("このコマンドはサーバー内でのみ使用できます。", ephemeral=True)

    await interaction.response.defer(ephemeral=True)

    total_members = guild.member_count or len(guild.members)
    verified_count = 0
    if ROLE_ID:
        target_role = guild.get_role(ROLE_ID)
        if target_role:
            verified_count = sum(1 for m in guild.members if target_role in m.roles and not m.bot)

    unverified_count = max(0, total_members - verified_count)
    verified_rate = f"{(verified_count / total_members * 100):.1f}%" if total_members > 0 else "0%"
    uptime_str = format_uptime(time.time() - start_time)
    ws_ping = max(0, round(bot.latency * 1000))

    embed = discord.Embed(
        title=f"📊 {guild.name} 認証統計",
        color=discord.Color.blue(),
        timestamp=datetime.now()
    )
    if guild.icon:
        embed.set_thumbnail(url=guild.icon.url)

    embed.add_field(name="👥 総メンバー数", value=f"{total_members} 人", inline=True)
    embed.add_field(name="✅ 認証済みメンバー", value=f"{verified_count} 人 ({verified_rate})", inline=True)
    embed.add_field(name="⏳ 未認証メンバー", value=f"{unverified_count} 人", inline=True)
    embed.add_field(name="⏱️ Bot稼働時間", value=uptime_str, inline=True)
    embed.add_field(name="📶 WebSocket Ping", value=f"{ws_ping} ms", inline=True)
    embed.add_field(name="🌐 参加サーバー総数", value=f"{len(bot.guilds)} 鯖", inline=True)
    embed.set_footer(text="Powered by rds9")

    await interaction.followup.send(embed=embed)

@bot.tree.command(name="help", description="認証Botのヘルプと使い方を表示します")
async def help_command(interaction: discord.Interaction):
    embed = discord.Embed(
        title="📖 認証Bot ヘルプ & コマンド一覧",
        description="サーバーを安全に保護するための多機能認証Botです。",
        color=discord.Color.blue(),
        timestamp=datetime.now()
    )
    embed.add_field(
        name="🛠️ 管理者コマンド",
        value="`/set-panel`\n認証パネルを設置します。付与ロールや剥奪ロール、認証方式（ワンクリック/CAPTCHA/合言葉/規約同意）を細かく設定できます。",
        inline=False
    )
    embed.add_field(
        name="📊 情報コマンド",
        value="`/stats` - サーバーの認証人数や稼働状況を表示\n`/ping` - Botの応答速度（Ping）を測定\n`/help` - このヘルプを表示",
        inline=False
    )
    embed.add_field(
        name="🔐 認証方式の一覧",
        value="• **ワンクリック認証**: ボタンを押すだけで即時認証\n• **CAPTCHA認証**: ランダムな4文字の確認コード入力\n• **合言葉認証**: 設定されたキーワードを入力\n• **規約同意認証**: 規約を確認し「同意する」と入力",
        inline=False
    )
    embed.set_footer(text="Powered by rds9")

    await interaction.response.send_message(embed=embed, ephemeral=True)

if __name__ == "__main__":
    bot.run(DISCORD_TOKEN)
