try {
    require('dotenv').config();
} catch {
    try {
        if (typeof process.loadEnvFile === 'function') {
            process.loadEnvFile();
        }
    } catch {
        // .env がない環境（クラウド側の環境変数設定など）でも続行
    }
}
const { 
    Client, GatewayIntentBits, REST, Routes, 
    SlashCommandBuilder, PermissionFlagsBits, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType
} = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, ROLE_ID, UNVERIFIED_ROLE_ID, LOG_CHANNEL_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
    console.error('エラー: .env に DISCORD_TOKEN または CLIENT_ID が設定されていません。');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ]
});

// クールダウン管理 (連打・DoS防止)
const cooldowns = new Map();
const COOLDOWN_TIME = 3000; // 3秒

function checkCooldown(userId) {
    const now = Date.now();
    const lastTime = cooldowns.get(userId);
    if (lastTime && now - lastTime < COOLDOWN_TIME) {
        const remaining = ((COOLDOWN_TIME - (now - lastTime)) / 1000).toFixed(1);
        return remaining;
    }
    cooldowns.set(userId, now);
    return null;
}

// 古いクールダウンのクリーンアップ (1時間ごと)
setInterval(() => {
    const now = Date.now();
    for (const [userId, time] of cooldowns.entries()) {
        if (now - time > 60000) {
            cooldowns.delete(userId);
        }
    }
}, 3600000);

// ランダム文字列生成 (CAPTCHA用: 誤認しやすい 0, O, 1, I は除外)
function generateCaptcha(length = 4) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// 稼働時間のフォーマット
function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts = [];
    if (d > 0) parts.push(`${d}日`);
    if (h > 0) parts.push(`${h}時間`);
    if (m > 0) parts.push(`${m}分`);
    parts.push(`${s}秒`);
    return parts.join(' ');
}

// 認証ログ送信ヘルパー
async function sendAuthLog(guild, user, role, removedRole) {
    const logChannelId = process.env.LOG_CHANNEL_ID;
    if (!logChannelId) return;

    try {
        const channel = await guild.channels.fetch(logChannelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return;

        const fields = [
            { name: 'ユーザー', value: `${user.tag} (<@${user.id}>)`, inline: true },
            { name: 'ユーザーID', value: user.id, inline: true },
            { name: '付与ロール', value: role ? `<@&${role.id}>` : '不明', inline: true }
        ];

        if (removedRole) {
            fields.push({ name: '剥奪ロール', value: `<@&${removedRole.id}>`, inline: true });
        }

        const logEmbed = new EmbedBuilder()
            .setTitle('📋 認証ログ')
            .setDescription('ユーザーが認証を完了しました。')
            .setColor(0x2ECC71)
            .addFields(fields)
            .setThumbnail(user.displayAvatarURL())
            .setTimestamp();

        await channel.send({ embeds: [logEmbed] });
    } catch (error) {
        console.error('ログ送信エラー:', error);
    }
}

// ウェルカムDM送信ヘルパー
async function sendWelcomeDM(member) {
    try {
        const dmEmbed = new EmbedBuilder()
            .setTitle(`🎉 ${member.guild.name} へようこそ！`)
            .setDescription('認証が完了し、チャンネルが利用可能になりました！\nサーバーのルールをご確認の上、お楽しみください。')
            .setColor(0x00FF00)
            .setTimestamp();

        await member.send({ embeds: [dmEmbed] });
    } catch (error) {
        // DM受信拒否設定などの場合はスキップ
    }
}

// 共通ロール付与 & 剥奪処理
async function handleRoleAssignment(interaction, targetRoleId, targetRemoveRoleId) {
    const roleId = (targetRoleId && targetRoleId !== 'default') ? targetRoleId : ROLE_ID;
    if (!roleId) {
        return interaction.reply({
            content: 'エラー: 付与するロールが設定されていません。管理者に連絡してください。',
            ephemeral: true
        });
    }

    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
        return interaction.reply({ 
            content: 'エラー: 付与するロールが見つかりません。管理者に連絡してください。', 
            ephemeral: true 
        });
    }

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
        return interaction.reply({
            content: 'エラー: ユーザー情報の取得に失敗しました。',
            ephemeral: true
        });
    }

    if (member.roles.cache.has(roleId)) {
        return interaction.reply({ 
            content: 'すでに認証されています！', 
            ephemeral: true 
        });
    }

    try {
        // ロールを付与
        await member.roles.add(role);

        // 未認証ロールの剥奪処理（指定されている場合）
        const removeId = (targetRemoveRoleId && targetRemoveRoleId !== 'none') ? targetRemoveRoleId : UNVERIFIED_ROLE_ID;
        let removedRole = null;
        if (removeId) {
            const rRole = await interaction.guild.roles.fetch(removeId).catch(() => null);
            if (rRole && member.roles.cache.has(removeId)) {
                await member.roles.remove(rRole).catch(err => console.error('ロール剥奪エラー:', err));
                removedRole = rRole;
            }
        }

        await interaction.reply({ 
            content: '認証が完了しました！ロールを付与しました🎉', 
            ephemeral: true 
        });

        // ログ送信 & DM送信
        await sendAuthLog(interaction.guild, interaction.user, role, removedRole);
        await sendWelcomeDM(member);
    } catch (error) {
        console.error('ロール操作エラー:', error);
        await interaction.reply({ 
            content: 'エラーが発生しました。Botのロール位置が、付与・剥奪したいロールより上にあるか確認してください！', 
            ephemeral: true 
        });
    }
}

// ステータス更新処理 (10秒ごと)
let statusIndex = 0;
function startStatusRotation() {
    const updateStatus = () => {
        if (!client.user) return;

        const totalMembers = client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount || 0), 0);
        const totalGuilds = client.guilds.cache.size;
        const ping = Math.max(0, Math.round(client.ws.ping));

        const statuses = [
            `${totalMembers}人 | ${totalGuilds}鯖`,
            `ping ${ping}ms`,
            'Powered by rds9'
        ];

        const text = statuses[statusIndex % statuses.length];
        client.user.setPresence({
            activities: [{ name: text, type: ActivityType.Custom, state: text }],
            status: 'online'
        });

        statusIndex++;
    };

    updateStatus();
    setInterval(updateStatus, 10000);
}

client.once('ready', async () => {
    console.log(`認証Bot起動完了！ (${client.user.tag})`);

    // ステータスローテーション開始
    startStatusRotation();

    const commands = [
        new SlashCommandBuilder()
            .setName('set-panel')
            .setDescription('認証パネルをこのチャンネルに設置します（管理者限定）')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addRoleOption(option => 
                option.setName('role')
                    .setDescription('認証時に付与するロール（未指定時はデフォルトロール）')
                    .setRequired(false))
            .addRoleOption(option => 
                option.setName('remove_role')
                    .setDescription('認証時に剥奪するロール（未認証ロール等）')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('title')
                    .setDescription('パネルのタイトル')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('description')
                    .setDescription('パネルの説明文')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('button_label')
                    .setDescription('ボタンのテキスト（デフォルト: 認証する）')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('auth_type')
                    .setDescription('認証の方式（デフォルト: ワンクリック）')
                    .setRequired(false)
                    .addChoices(
                        { name: 'ワンクリック認証', value: 'direct' },
                        { name: 'CAPTCHA認証（ランダム文字列）', value: 'captcha' },
                        { name: '合言葉認証（キーワード入力）', value: 'passphrase' },
                        { name: '規約同意認証（同意入力）', value: 'terms' }
                    ))
            .addStringOption(option =>
                option.setName('passphrase')
                    .setDescription('合言葉認証を選択した場合の正解キーワード')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('terms_text')
                    .setDescription('規約同意認証で表示する規約メッセージ')
                    .setRequired(false)),
        new SlashCommandBuilder()
            .setName('stats')
            .setDescription('サーバーの認証統計やBotの稼働状態を表示します'),
        new SlashCommandBuilder()
            .setName('ping')
            .setDescription('Botの応答速度（Ping）を測定します'),
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('認証Botのヘルプと使い方を表示します')
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    try {
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );
        console.log('コマンド登録成功！');
    } catch (error) {
        console.error('コマンド登録エラー:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    // === スラッシュコマンド ===
    if (interaction.isChatInputCommand()) {
        // --- /set-panel ---
        if (interaction.commandName === 'set-panel') {
            const targetRole = interaction.options.getRole('role');
            const removeRole = interaction.options.getRole('remove_role');
            const title = interaction.options.getString('title') || '✅ サーバー認証';
            const description = interaction.options.getString('description') || '下のボタンを押して認証を完了し、すべてのチャンネルを解放してください。';
            const buttonLabel = interaction.options.getString('button_label') || '認証する';
            const authType = interaction.options.getString('auth_type') || 'direct';
            const passphrase = interaction.options.getString('passphrase');
            const termsText = interaction.options.getString('terms_text') || '本サーバーのルールを守り、他のメンバーへ迷惑となる行為を行わないことに同意します。';

            if (authType === 'passphrase' && !passphrase) {
                return interaction.reply({
                    content: 'エラー: 合言葉認証を選択した場合は「passphrase」オプションで合言葉を指定してください。',
                    ephemeral: true
                });
            }

            const roleIdParam = targetRole ? targetRole.id : 'default';
            const removeRoleIdParam = removeRole ? removeRole.id : 'none';

            let customId = `auth_btn:${roleIdParam}:${removeRoleIdParam}:${authType}`;
            if (authType === 'passphrase') {
                customId = `auth_btn:${roleIdParam}:${removeRoleIdParam}:pass:${passphrase}`;
            } else if (authType === 'terms') {
                // 短縮キーで保持
                customId = `auth_btn:${roleIdParam}:${removeRoleIdParam}:terms`;
            }

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(description)
                .setColor(0x00FF00);

            if (authType === 'terms') {
                embed.addFields({ name: '📜 利用規約', value: termsText });
            }

            const button = new ButtonBuilder()
                .setCustomId(customId)
                .setLabel(buttonLabel)
                .setStyle(ButtonStyle.Success)
                .setEmoji('🔓');

            const row = new ActionRowBuilder().addComponents(button);

            await interaction.reply({ content: '認証パネルを設置しました！', ephemeral: true });
            await interaction.channel.send({ embeds: [embed], components: [row] });
            return;
        }

        // --- /ping ---
        if (interaction.commandName === 'ping') {
            const wsPing = Math.max(0, Math.round(client.ws.ping));
            const embed = new EmbedBuilder()
                .setTitle('🏓 Pong!')
                .setColor(wsPing < 150 ? 0x2ECC71 : (wsPing < 300 ? 0xF1C40F : 0xE74C3C))
                .addFields(
                    { name: 'WebSocket Ping', value: `${wsPing} ms`, inline: true },
                    { name: 'ステータス', value: wsPing < 150 ? '🟢 良好' : (wsPing < 300 ? '🟡 普通' : '🔴 遅延'), inline: true }
                )
                .setFooter({ text: 'Powered by rds9' })
                .setTimestamp();

            return await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // --- /stats ---
        if (interaction.commandName === 'stats') {
            await interaction.deferReply({ ephemeral: true });
            const guild = interaction.guild;
            const totalMembers = guild.memberCount;

            let verifiedCount = 0;
            const targetRoleId = ROLE_ID;
            if (targetRoleId) {
                try {
                    const members = await guild.members.fetch();
                    verifiedCount = members.filter(m => m.roles.cache.has(targetRoleId) && !m.user.bot).size;
                } catch {
                    verifiedCount = guild.members.cache.filter(m => m.roles.cache.has(targetRoleId) && !m.user.bot).size;
                }
            }

            const unverifiedCount = Math.max(0, totalMembers - verifiedCount);
            const verifiedRate = totalMembers > 0 ? ((verifiedCount / totalMembers) * 100).toFixed(1) : 0;

            const embed = new EmbedBuilder()
                .setTitle(`📊 ${guild.name} 認証統計`)
                .setThumbnail(guild.iconURL({ dynamic: true }))
                .setColor(0x3498DB)
                .addFields(
                    { name: '👥 総メンバー数', value: `${totalMembers} 人`, inline: true },
                    { name: '✅ 認証済みメンバー', value: `${verifiedCount} 人 (${verifiedRate}%)`, inline: true },
                    { name: '⏳ 未認証メンバー', value: `${unverifiedCount} 人`, inline: true },
                    { name: '⏱️ Bot稼働時間', value: formatUptime(process.uptime()), inline: true },
                    { name: '📶 WebSocket Ping', value: `${Math.max(0, Math.round(client.ws.ping))} ms`, inline: true },
                    { name: '🌐 参加サーバー総数', value: `${client.guilds.cache.size} 鯖`, inline: true }
                )
                .setFooter({ text: 'Powered by rds9' })
                .setTimestamp();

            return await interaction.editReply({ embeds: [embed] });
        }

        // --- /help ---
        if (interaction.commandName === 'help') {
            const embed = new EmbedBuilder()
                .setTitle('📖 認証Bot ヘルプ & コマンド一覧')
                .setDescription('サーバーを安全に保護するための多機能認証Botです。')
                .setColor(0x3498DB)
                .addFields(
                    {
                        name: '🛠️ 管理者コマンド',
                        value: '`/set-panel`\n認証パネルを設置します。付与ロールや剥奪ロール、認証方式（ワンクリック/CAPTCHA/合言葉/規約同意）を細かく設定できます。'
                    },
                    {
                        name: '📊 情報コマンド',
                        value: '`/stats` - サーバーの認証人数や稼働状況を表示\n`/ping` - Botの応答速度（Ping）を測定\n`/help` - このヘルプを表示'
                    },
                    {
                        name: '🔐 認証方式の一覧',
                        value: '• **ワンクリック認証**: ボタンを押すだけで即時認証\n• **CAPTCHA認証**: ランダムな4文字の確認コード入力\n• **合言葉認証**: 設定されたキーワードを入力\n• **規約同意認証**: 規約を確認し「同意する」と入力'
                    }
                )
                .setFooter({ text: 'Powered by rds9' })
                .setTimestamp();

            return await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }

    // === ボタンが押された時の処理 ===
    if (interaction.isButton()) {
        // クールダウン判定（連打防止）
        const remaining = checkCooldown(interaction.user.id);
        if (remaining) {
            return interaction.reply({
                content: `⚠️ 操作が早すぎます。あと **${remaining}秒** 待ってから再度お試しください。`,
                ephemeral: true
            });
        }

        // 旧バージョンパネルの下位互換対応
        if (interaction.customId === 'auth_button') {
            return await handleRoleAssignment(interaction, null, null);
        }

        if (interaction.customId.startsWith('auth_btn:')) {
            const parts = interaction.customId.split(':');
            const roleId = parts[1];
            const removeRoleId = parts[2];
            const authType = parts[3];

            if (authType === 'captcha') {
                const captcha = generateCaptcha(4);
                const modal = new ModalBuilder()
                    .setCustomId(`auth_modal:${roleId}:${removeRoleId}:captcha:${captcha}`)
                    .setTitle('サーバー認証 (CAPTCHA)');

                const textInput = new TextInputBuilder()
                    .setCustomId('captcha_input')
                    .setLabel(`確認コード「${captcha}」を入力`)
                    .setStyle(TextInputStyle.Short)
                    .setMinLength(4)
                    .setMaxLength(4)
                    .setRequired(true);

                const row = new ActionRowBuilder().addComponents(textInput);
                modal.addComponents(row);
                return await interaction.showModal(modal);
            }

            if (authType === 'pass') {
                const pass = parts.slice(4).join(':');
                const modal = new ModalBuilder()
                    .setCustomId(`auth_modal:${roleId}:${removeRoleId}:pass:${pass}`)
                    .setTitle('サーバー認証 (合言葉)');

                const textInput = new TextInputBuilder()
                    .setCustomId('pass_input')
                    .setLabel('合言葉を入力してください')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const row = new ActionRowBuilder().addComponents(textInput);
                modal.addComponents(row);
                return await interaction.showModal(modal);
            }

            if (authType === 'terms') {
                const modal = new ModalBuilder()
                    .setCustomId(`auth_modal:${roleId}:${removeRoleId}:terms:agree`)
                    .setTitle('サーバー認証 (利用規約同意)');

                const textInput = new TextInputBuilder()
                    .setCustomId('terms_input')
                    .setLabel('「同意する」と入力してください')
                    .setPlaceholder('同意する')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const row = new ActionRowBuilder().addComponents(textInput);
                modal.addComponents(row);
                return await interaction.showModal(modal);
            }

            // ワンクリック認証
            await handleRoleAssignment(interaction, roleId === 'default' ? null : roleId, removeRoleId === 'none' ? null : removeRoleId);
        }
    }

    // === モーダル送信時の処理 ===
    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('auth_modal:')) {
            const parts = interaction.customId.split(':');
            const roleId = parts[1];
            const removeRoleId = parts[2];
            const authType = parts[3];

            if (authType === 'captcha') {
                const expected = parts.slice(4).join(':');
                const input = interaction.fields.getTextInputValue('captcha_input');

                if (input.trim().toUpperCase() !== expected.toUpperCase()) {
                    return interaction.reply({
                        content: '❌ 認証コードが一致しません。もう一度やり直してください。',
                        ephemeral: true
                    });
                }

                await handleRoleAssignment(interaction, roleId === 'default' ? null : roleId, removeRoleId === 'none' ? null : removeRoleId);
                return;
            }

            if (authType === 'pass') {
                const expected = parts.slice(4).join(':');
                const input = interaction.fields.getTextInputValue('pass_input');

                if (input.trim() !== expected.trim()) {
                    return interaction.reply({
                        content: '❌ 合言葉が間違っています。もう一度お試しください。',
                        ephemeral: true
                    });
                }

                await handleRoleAssignment(interaction, roleId === 'default' ? null : roleId, removeRoleId === 'none' ? null : removeRoleId);
                return;
            }

            if (authType === 'terms') {
                const input = interaction.fields.getTextInputValue('terms_input').trim();

                if (input !== '同意する' && input.toLowerCase() !== 'agree' && input !== '同意') {
                    return interaction.reply({
                        content: '❌ 「同意する」と正確に入力してください。',
                        ephemeral: true
                    });
                }

                await handleRoleAssignment(interaction, roleId === 'default' ? null : roleId, removeRoleId === 'none' ? null : removeRoleId);
                return;
            }
        }
    }
});

client.login(DISCORD_TOKEN);
