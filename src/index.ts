import "dotenv/config";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message
} from "discord.js";
import { loadConfig } from "./config.js";
import { SqliteDatabase } from "./db.js";
import { Logger } from "./logger.js";
import { AccountService } from "./services/accounts.js";
import { WatchService } from "./services/watches.js";
import { NotificationService } from "./services/notifications.js";
import { getStats } from "./services/stats.js";
import { ApprovalStore } from "./services/approval.js";
import { canUseAdminStats } from "./services/permissions.js";
import { MemberCache } from "./services/member-cache.js";

const config = loadConfig();
const logger = new Logger(config.LOG_LEVEL);
const db = await SqliteDatabase.open(config.DATABASE_PATH);
const accounts = new AccountService(db, config.DEVELOPER_TEST_DISCORD_ID, config.LINK_CODE_PEPPER);
const watches = new WatchService(db, accounts);
const notifications = new NotificationService(db, accounts, logger);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});
const pendingApprovals = new ApprovalStore();
const memberCache = new MemberCache<GuildMember>(5_000);

function privateReply(interaction: ChatInputCommandInteraction | ButtonInteraction, content: string, components?: ActionRowBuilder<ButtonBuilder>[]): Promise<unknown> {
  const message = { content, ...(components ? { components } : {}) };
  if (interaction.replied || interaction.deferred) return interaction.editReply(message);
  return interaction.reply({ ...message, ...(interaction.inGuild() ? { ephemeral: true } : {}) });
}

function memberAccess(message: Message) {
  const guild = message.guild!;
  const getMember = (userId: string): Promise<GuildMember | null> => memberCache.get(`${guild.id}:${userId}`, async () => guild.members.cache.get(userId) ?? await guild.members.fetch(userId));
  return {
    isMember: async (userId: string): Promise<boolean> => {
      return Boolean(await getMember(userId));
    },
    canViewChannel: async (userId: string): Promise<boolean> => {
      const member = await getMember(userId);
      if (!member) return false;
      const permissions = (message.channel as unknown as { permissionsFor: (member: GuildMember) => { has: (permission: bigint) => boolean } | null }).permissionsFor(member);
      return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel));
    }
  };
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  try {
    if (interaction.commandName === "main" && subcommand === "set") {
      await interaction.deferReply({ ephemeral: interaction.inGuild() });
      await accounts.registerMain(interaction.user.id, interaction.user.username, async () => { await interaction.user.send({ content: "メインアカウントの登録を確認しました。", allowedMentions: { parse: [] } }); });
      await interaction.editReply("メインアカウントを登録しました");
      return;
    }
    if (interaction.commandName === "link" && subcommand === "issue") {
      const code = accounts.issueLinkCode(interaction.user.id);
      await privateReply(interaction, `連携コード：${code}\n有効期限：10分`);
      return;
    }
    if (interaction.commandName === "link" && subcommand === "approve") {
      const code = interaction.options.getString("code", true);
      const preview = accounts.previewLinkCode(interaction.user.id, code);
      const token = pendingApprovals.issue(interaction.user.id, accounts.hashForApproval(code));
      const button = new ButtonBuilder().setCustomId(`link-approve:${token}`).setLabel("連携を承認する").setStyle(ButtonStyle.Primary);
      await privateReply(interaction, `連携先：${preview.mainUsername}\nID：${preview.mainUserId}\n自動監視：連携承認後に有効`, [new ActionRowBuilder<ButtonBuilder>().addComponents(button)]);
      return;
    }
    if (interaction.commandName === "watch") {
      if (!interaction.guildId) { await privateReply(interaction, "サーバー内で実行してください"); return; }
      const sub = subcommand;
      if (sub === "status") {
        const state = watches.status(interaction.guildId, interaction.user.id);
        const text = state === "auto" ? "自動監視中" : state === "on" ? "監視中（手動ON）" : state === "off" ? "このサーバーはOFF" : "連携されていません";
        await privateReply(interaction, text);
        return;
      }
      const guild = interaction.guild;
      if (!guild) { await privateReply(interaction, "サーバー内で実行してください"); return; }
      await watches.set(interaction.guildId, interaction.user.id, sub === "on", { isMember: async (userId) => { try { await guild.members.fetch(userId); return true; } catch { return false; } } });
      await privateReply(interaction, sub === "on" ? "このサーバーの監視を再開しました" : "このサーバーの監視をOFFにしました");
      return;
    }
    if (interaction.commandName === "unlink") {
      const status = accounts.getStatus(interaction.user.id);
      const target = interaction.options.getUser("account", false)?.id;
      if (status.kind === "main" && !target) { await privateReply(interaction, "解除するサブアカウントを指定してください"); return; }
      const removed = accounts.unlink(interaction.user.id, target);
      await privateReply(interaction, removed ? "連携を解除しました" : "連携が見つかりません");
      return;
    }
    if (interaction.commandName === "status") {
      const status = accounts.getStatus(interaction.user.id);
      if (status.kind === "none") { await privateReply(interaction, "連携はありません"); return; }
      if (status.kind === "main") {
        await privateReply(interaction, status.links.length ? `連携中：${status.links.map((link) => `${link.username}${link.watchOffGuilds?.length ? `（個別OFF ${link.watchOffGuilds.length}件）` : "（自動監視）"}`).join("、")}` : "連携中のサブアカウントはありません");
        return;
      }
      await privateReply(interaction, `連携先：${status.mainUsername}\n自動監視：有効\n個別OFFサーバー数：${status.watchOffGuilds.length}`);
      return;
    }
    if (interaction.commandName === "admin-stats") {
      if (!canUseAdminStats(interaction.user.id, config.OWNER_DISCORD_ID)) { await privateReply(interaction, "権限がありません"); return; }
      const stats = getStats(db, client.ws.status === 0, client.guilds.cache.size);
      await privateReply(interaction, `導入サーバー数：${stats.guilds}\nメイン登録数：${stats.mainAccounts}\n連携済みアカウント数：${stats.linkedAccounts}\n本日の通知送信数：${stats.notificationsSentToday}\n送信失敗数：${stats.notificationFailures}\n送信待ち：${stats.pendingQueue}\nGateway：${stats.gatewayReady ? "接続" : "未接続"}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作に失敗しました";
    await privateReply(interaction, message).catch(() => undefined);
  }
}

client.once(Events.ClientReady, (ready) => logger.info("gateway ready", { guilds: ready.guilds.cache.size }));
client.on(Events.ShardDisconnect, (event) => logger.warn("gateway disconnected", { code: event.code }));
client.on(Events.ShardReconnecting, () => logger.warn("gateway reconnecting"));
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) await handleCommand(interaction);
  if (!interaction.isButton() || !interaction.customId.startsWith("link-approve:")) return;
  const token = interaction.customId.slice("link-approve:".length);
  try {
    const codeHash = pendingApprovals.consume(token, interaction.user.id);
    const result = accounts.approveLinkByHash(interaction.user.id, codeHash, interaction.user.username);
    await interaction.update({ content: "連携を承認しました。自動監視を有効にしました", components: [] });
    await client.users.send(result.mainUserId, { content: `サブアカウント「${interaction.user.username}」を連携しました。`, allowedMentions: { parse: [] } }).catch((error: unknown) => logger.warn("link confirmation DM failed", { mainUserId: result.mainUserId, error: error instanceof Error ? error.message : "unknown" }));
  } catch (error) { await privateReply(interaction, error instanceof Error ? error.message : "連携に失敗しました"); }
});
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author.bot) return;
    const mentionedUserIds = [...message.mentions.users.keys()];
    const labels = new Map(mentionedUserIds.map((id) => [id, message.mentions.users.get(id)?.globalName ?? message.mentions.users.get(id)?.username ?? id]));
    await notifications.inspect({ id: message.id, guildId: message.guild.id, authorBot: message.author.bot, mentionedUserIds, mentionEveryone: message.mentions.everyone }, memberAccess(message), labels);
  } catch (error) { logger.error("message inspection failed", { error: error instanceof Error ? error.message : "unknown" }); }
});

const timer = setInterval(() => {
  void notifications.drain({ send: async (mainUserId, content) => { const user = await client.users.fetch(mainUserId); await user.send({ content, allowedMentions: { parse: [] } }); } }).catch((error) => logger.error("notification worker failed", { error: error instanceof Error ? error.message : "unknown" }));
}, 5_000);

async function shutdown(signal: string): Promise<void> {
  logger.info("shutting down", { signal });
  clearInterval(timer);
  client.destroy();
  db.close();
}
process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

client.login(config.DISCORD_TOKEN).catch((error: unknown) => {
  logger.error("gateway login failed", { error: error instanceof Error ? error.message : "unknown" });
  // 認証失敗後もワーカーを残すと、閉じたDBへアクセスして二次障害になるため即時停止する。
  clearInterval(timer);
  client.destroy();
  db.close();
  process.exitCode = 1;
});
