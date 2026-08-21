require('dotenv').config();
const { 
    Client, GatewayIntentBits, REST, Routes, 
    SlashCommandBuilder, PermissionFlagsBits, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType
} = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, ROLE_ID, LOG_CHANNEL_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
    console.error('エラー: .env に DISCORD_TOKEN または CLIENT_ID が設定されていません。');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

// ランダム文字列生成 (CAPTCHA用: 誤認しやすい 0, O, 1, I は除外)
function generateCaptcha(length = 4) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// 認証ログ送信ヘルパー
async function sendAuthLog(guild, user, role) {
    const logChannelId = process.env.LOG_CHANNEL_ID;
    if (!logChannelId) return;

    try {
        const channel = await guild.channels.fetch(logChannelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return;

        const logEmbed = new EmbedBuilder()
            .setTitle('📋 認証ログ')
            .setDescription('ユーザーが認証を完了しました。')
            .setColor(0x2ECC71)
            .addFields(
                { name: 'ユーザー', value: `${user.tag} (<@${user.id}>)`, inline: true },
                { name: 'ユーザーID', value: user.id, inline: true },
                { name: '付与ロール', value: role ? `<@&${role.id}>` : '不明', inline: true }
            )
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

// 共通ロール付与処理
async function handleRoleAssignment(interaction, targetRoleId) {
    const roleId = targetRoleId || ROLE_ID;
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
        await member.roles.add(role);
        await interaction.reply({ 
            content: '認証が完了しました！ロールを付与しました🎉', 
            ephemeral: true 
        });

        // ログ送信 & DM送信
        await sendAuthLog(interaction.guild, interaction.user, role);
        await sendWelcomeDM(member);
    } catch (error) {
        console.error('ロール付与エラー:', error);
        await interaction.reply({ 
            content: 'エラーが発生しました。Botのロール位置が、付与したいロールより上にあるか確認してください！', 
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
                        { name: '合言葉認証（キーワード入力）', value: 'passphrase' }
                    ))
            .addStringOption(option =>
                option.setName('passphrase')
                    .setDescription('合言葉認証を選択した場合の正解キーワード')
                    .setRequired(false))
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
    // === スラッシュコマンド（パネル設置） ===
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'set-panel') {
            const targetRole = interaction.options.getRole('role');
            const title = interaction.options.getString('title') || '✅ サーバー認証';
            const description = interaction.options.getString('description') || '下のボタンを押して認証を完了し、すべてのチャンネルを解放してください。';
            const buttonLabel = interaction.options.getString('button_label') || '認証する';
            const authType = interaction.options.getString('auth_type') || 'direct';
            const passphrase = interaction.options.getString('passphrase');

            if (authType === 'passphrase' && !passphrase) {
                return interaction.reply({
                    content: 'エラー: 合言葉認証を選択した場合は「passphrase」オプションで合言葉を指定してください。',
                    ephemeral: true
                });
            }

            const roleIdParam = targetRole ? targetRole.id : 'default';
            let customId = `auth_btn:${roleIdParam}:${authType}`;
            if (authType === 'passphrase') {
                customId = `auth_btn:${roleIdParam}:pass:${passphrase}`;
            }

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(description)
                .setColor(0x00FF00);

            const button = new ButtonBuilder()
                .setCustomId(customId)
                .setLabel(buttonLabel)
                .setStyle(ButtonStyle.Success)
                .setEmoji('🔓');

            const row = new ActionRowBuilder().addComponents(button);

            await interaction.reply({ content: '認証パネルを設置しました！', ephemeral: true });
            await interaction.channel.send({ embeds: [embed], components: [row] });
        }
    }

    // === ボタンが押された時の処理 ===
    if (interaction.isButton()) {
        // 旧バージョンパネルの下位互換対応
        if (interaction.customId === 'auth_button') {
            return await handleRoleAssignment(interaction, null);
        }

        if (interaction.customId.startsWith('auth_btn:')) {
            const parts = interaction.customId.split(':');
            const roleId = parts[1];
            const authType = parts[2];

            if (authType === 'captcha') {
                const captcha = generateCaptcha(4);
                const modal = new ModalBuilder()
                    .setCustomId(`auth_modal:${roleId}:captcha:${captcha}`)
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
                const pass = parts.slice(3).join(':');
                const modal = new ModalBuilder()
                    .setCustomId(`auth_modal:${roleId}:pass:${pass}`)
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

            // ワンクリック認証
            await handleRoleAssignment(interaction, roleId === 'default' ? null : roleId);
        }
    }

    // === モーダル送信時の処理 ===
    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('auth_modal:')) {
            const parts = interaction.customId.split(':');
            const roleId = parts[1];
            const authType = parts[2];

            if (authType === 'captcha') {
                const expected = parts.slice(3).join(':');
                const input = interaction.fields.getTextInputValue('captcha_input');

                if (input.trim().toUpperCase() !== expected.toUpperCase()) {
                    return interaction.reply({
                        content: '❌ 認証コードが一致しません。もう一度やり直してください。',
                        ephemeral: true
                    });
                }

                await handleRoleAssignment(interaction, roleId === 'default' ? null : roleId);
                return;
            }

            if (authType === 'pass') {
                const expected = parts.slice(3).join(':');
                const input = interaction.fields.getTextInputValue('pass_input');

                if (input.trim() !== expected.trim()) {
                    return interaction.reply({
                        content: '❌ 合言葉が間違っています。もう一度お試しください。',
                        ephemeral: true
                    });
                }

                await handleRoleAssignment(interaction, roleId === 'default' ? null : roleId);
                return;
            }
        }
    }
});

client.login(DISCORD_TOKEN);
