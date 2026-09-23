import "dotenv/config";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
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
import { HealthcheckService } from "./services/healthcheck.js";
import { helpText } from "./help.js";

const config = loadConfig();
const logger = new Logger(config.LOG_LEVEL);
const db = await SqliteDatabase.open(config.DATABASE_PATH);
db.cleanup();
const accounts = new AccountService(db, config.DEVELOPER_TEST_DISCORD_ID, config.LINK_CODE_PEPPER, config.FREE_LINK_LIMIT);
const watches = new WatchService(db, accounts);
const notifications = new NotificationService(db, accounts, logger, () => Date.now(), { maxPendingPerMain: config.MAX_PENDING_PER_MAIN, minIntervalMs: config.DM_MIN_INTERVAL_MS });
const healthchecks = new HealthcheckService(db, logger, config.HEALTHCHECKS_HEARTBEAT_URL, config.HEALTHCHECKS_MAX_PENDING_QUEUE, config.HEALTHCHECKS_MAX_FAILURES_15M);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});
const pendingApprovals = new ApprovalStore();
const pendingDeletions = new ApprovalStore();
const memberCache = new MemberCache<GuildMember>(5_000);

function privateReply(interaction: ChatInputCommandInteraction | ButtonInteraction, content: string, components?: ActionRowBuilder<ButtonBuilder>[]): Promise<unknown> {
  const message = { content, ...(components ? { components } : {}) };
  if (interaction.replied || interaction.deferred) return interaction.editReply(message);
  return interaction.reply({ ...message, ...(interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {}) });
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

async function authorizeQueuedNotification(input: { mainUserId: string; guildId: string; channelId: string; targetUserIds: string[] }): Promise<Array<{ userId: string; label: string }>> {
  if (!input.channelId) return [];
  const guild = client.guilds.cache.get(input.guildId);
  if (!guild) return [];
  let channel: GuildBasedChannel | null | undefined = guild.channels.cache.get(input.channelId);
  if (!channel) {
    try { channel = await guild.channels.fetch(input.channelId); } catch { return []; }
  }
  if (!channel || !("permissionsFor" in channel)) return [];
  const permissionChannel = channel as unknown as { permissionsFor: (member: GuildMember) => { has: (permission: bigint) => boolean } | null };
  const activeLinks = accounts.linkedSubsForGuild(input.guildId).filter((link) => link.mainUserId === input.mainUserId && input.targetUserIds.includes(link.subUserId));
  const authorized: Array<{ userId: string; label: string }> = [];
  for (const link of activeLinks) {
    try {
      // Membership is an authorization boundary. Do not reuse the short-lived
      // inspection cache here; fetch the current member state immediately before
      // sending so a recent guild departure cannot receive a queued notification.
      const member = await guild.members.fetch(link.subUserId);
      if (!member) continue;
      const permissions = permissionChannel.permissionsFor(member);
      if (permissions?.has(PermissionFlagsBits.ViewChannel)) authorized.push({ userId: link.subUserId, label: link.username });
    } catch {
      // A departed account or an inaccessible channel is intentionally skipped.
    }
  }
  return authorized;
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  try {
    if (interaction.commandName === "help") {
      await privateReply(interaction, helpText(config.APP_NAME));
      return;
    }
    if (interaction.commandName === "main" && subcommand === "set") {
      await interaction.deferReply(interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {});
      await accounts.registerMain(interaction.user.id, interaction.user.username, async () => { await interaction.user.send({ content: "メインアカウントの登録を確認しました。", allowedMentions: { parse: [] } }); });
      await interaction.editReply("このアカウントをメインアカウントに設定しました。\n次に /link issue を実行してください。");
      return;
    }
    if (interaction.commandName === "link" && subcommand === "issue") {
      const code = accounts.issueLinkCode(interaction.user.id);
      await privateReply(interaction, `連携コード：${code}\n有効期限：10分\n\n次の順で操作してください。\n1. サブアカウントへ切り替える\n2. /link approve を実行する\n3. このコードを入力する\n4. 表示された承認ボタンを押す`);
      return;
    }
    if (interaction.commandName === "link" && subcommand === "approve") {
      const code = interaction.options.getString("code", true);
      const preview = accounts.previewLinkCode(interaction.user.id, code);
      const token = pendingApprovals.issue(interaction.user.id, accounts.hashForApproval(code));
      const button = new ButtonBuilder().setCustomId(`link-approve:${token}`).setLabel("連携を承認する").setStyle(ButtonStyle.Primary);
      await privateReply(interaction, `連携先：${preview.mainUsername}\n\n承認すると、Botが導入され、あなたが参加しているサーバーを自動監視します。\n特定のサーバーだけ停止する場合は、そのサーバーで /watch off を実行してください。\n\n承認後はこれで設定完了です。通常は /watch on は不要です。`, [new ActionRowBuilder<ButtonBuilder>().addComponents(button)]);
      return;
    }
    if (interaction.commandName === "watch") {
      if (!interaction.guildId) { await privateReply(interaction, "サーバー内で実行してください"); return; }
      const sub = subcommand;
      if (sub === "status") {
        const state = watches.status(interaction.guildId, interaction.user.id);
        const text = state === "auto" ? "監視：自動（Bot導入済み・参加中のサーバー）" : state === "on" ? "監視：ON" : state === "off" ? "監視：OFF（このサーバーのみ）" : "監視：連携されていません";
        await privateReply(interaction, text);
        return;
      }
      const guild = interaction.guild;
      if (!guild) { await privateReply(interaction, "サーバー内で実行してください"); return; }
      await watches.set(interaction.guildId, interaction.user.id, sub === "on", { isMember: async (userId) => { try { await guild.members.fetch(userId); return true; } catch { return false; } } });
      await privateReply(interaction, sub === "on" ? "このサーバーの監視を再開しました。" : "このサーバーの監視をOFFにしました。再起動後も維持されます。");
      return;
    }
    if (interaction.commandName === "unlink") {
      const status = accounts.getStatus(interaction.user.id);
      const target = interaction.options.getUser("account", false)?.id;
      if (status.kind === "main" && !target) { await privateReply(interaction, "メインアカウントは、解除するサブアカウントを指定してください。"); return; }
      const removed = accounts.unlink(interaction.user.id, target);
      await privateReply(interaction, removed ? "連携を解除しました。未送信の対象通知も停止しました。全データを削除する場合は /account delete を実行してください。" : "連携が見つかりません。");
      return;
    }
    if (interaction.commandName === "account" && subcommand === "delete") {
      const token = pendingDeletions.issue(interaction.user.id, "delete");
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`account-delete:${token}`).setLabel("削除する").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`account-delete-cancel:${token}`).setLabel("キャンセル").setStyle(ButtonStyle.Secondary)
      );
      await privateReply(interaction, `${config.APP_NAME}に保存された連携・監視設定・未送信通知を削除します。この操作は取り消せません。`, [row]);
      return;
    }
    if (interaction.commandName === "status") {
      const status = accounts.getStatus(interaction.user.id);
      if (status.kind === "none") { await privateReply(interaction, "まだ設定されていません。メインアカウントなら /main set を実行してください。"); return; }
      if (status.kind === "main") {
        const links = status.links.length ? status.links.map((link) => `${link.username}${link.watchOffGuilds?.length ? `（個別OFF ${link.watchOffGuilds.length}件）` : "（自動監視）"}`).join("、") : "なし";
        await privateReply(interaction, `立場：メイン\n連携数：${status.links.length}/${status.linkLimit ?? 5}\n連携中：${links}\n個別OFFサーバー数：${status.watchOffGuilds.length}`);
        return;
      }
      await privateReply(interaction, `立場：サブ\n連携先：${status.mainUsername}\n監視：Bot導入済みで参加中のサーバーを自動監視\n個別OFFサーバー数：${status.watchOffGuilds.length}`);
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

client.once(Events.ClientReady, (ready) => {
  logger.info("gateway ready", { guilds: ready.guilds.cache.size });
  void healthchecks.check(true);
});
client.on(Events.ShardDisconnect, (event) => logger.warn("gateway disconnected", { code: event.code }));
client.on(Events.ShardReconnecting, () => logger.warn("gateway reconnecting"));
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) await handleCommand(interaction);
  if (!interaction.isButton()) return;
  if (interaction.customId.startsWith("account-delete-cancel:")) {
    await interaction.update({ content: "削除をキャンセルしました。", components: [] });
    return;
  }
  if (interaction.customId.startsWith("account-delete:")) {
    const token = interaction.customId.slice("account-delete:".length);
    try {
      pendingDeletions.consume(token, interaction.user.id);
      const result = accounts.deleteAccount(interaction.user.id);
      await interaction.update({ content: result === "none" ? "削除するデータがありません。" : "保存されていたAltNotiのデータを削除しました。", components: [] });
    } catch (error) { await privateReply(interaction, error instanceof Error ? error.message : "削除に失敗しました"); }
    return;
  }
  if (!interaction.customId.startsWith("link-approve:")) return;
  const token = interaction.customId.slice("link-approve:".length);
  try {
    const codeHash = pendingApprovals.consume(token, interaction.user.id);
    const result = accounts.approveLinkByHash(interaction.user.id, codeHash, interaction.user.username);
    await interaction.update({ content: "連携を承認しました。これで設定完了です。\nBotが導入され、サブアカウントが参加しているサーバーを自動監視します。\n通常は /watch on は不要です。", components: [] });
    await client.users.send(result.mainUserId, { content: `サブアカウント「${interaction.user.username}」を連携しました。`, allowedMentions: { parse: [] } }).catch((error: unknown) => logger.warn("link confirmation DM failed", { mainUserId: result.mainUserId, error: error instanceof Error ? error.message : "unknown" }));
  } catch (error) { await privateReply(interaction, error instanceof Error ? error.message : "連携に失敗しました"); }
});
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author.bot) return;
    const mentionedUserIds = [...message.mentions.users.keys()];
    const labels = new Map(mentionedUserIds.map((id) => [id, message.mentions.users.get(id)?.globalName ?? message.mentions.users.get(id)?.username ?? id]));
    await notifications.inspect({ id: message.id, guildId: message.guild.id, channelId: message.channelId, authorBot: message.author.bot, mentionedUserIds, mentionEveryone: message.mentions.everyone }, memberAccess(message), labels);
  } catch (error) { logger.error("message inspection failed", { error: error instanceof Error ? error.message : "unknown" }); }
});

const timer = setInterval(() => {
  void notifications.drain({ send: async (mainUserId, content) => { const user = await client.users.fetch(mainUserId); await user.send({ content, allowedMentions: { parse: [] } }); } }, Date.now(), 50, { authorize: authorizeQueuedNotification }).catch((error) => logger.error("notification worker failed", { error: error instanceof Error ? error.message : "unknown" }));
}, 5_000);
const cleanupTimer = setInterval(() => {
  try { db.cleanup(Date.now(), false); } catch (error) { logger.error("database cleanup failed", { error: error instanceof Error ? error.message : "unknown" }); }
}, 60 * 60 * 1_000);
const healthcheckTimer = config.HEALTHCHECKS_HEARTBEAT_URL ? setInterval(() => { void healthchecks.check(client.ws.status === 0); }, config.HEALTHCHECKS_HEARTBEAT_INTERVAL_MS) : undefined;

async function shutdown(signal: string): Promise<void> {
  logger.info("shutting down", { signal });
  clearInterval(timer);
  clearInterval(cleanupTimer);
  if (healthcheckTimer) clearInterval(healthcheckTimer);
  client.destroy();
  db.close();
}
process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

client.login(config.DISCORD_TOKEN).catch((error: unknown) => {
  logger.error("gateway login failed", { error: error instanceof Error ? error.message : "unknown" });
  // 認証失敗後もワーカーを残すと、閉じたDBへアクセスして二次障害になるため即時停止する。
  clearInterval(timer);
  clearInterval(cleanupTimer);
  if (healthcheckTimer) clearInterval(healthcheckTimer);
  client.destroy();
  db.close();
  process.exitCode = 1;
});
