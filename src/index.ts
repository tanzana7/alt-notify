import "dotenv/config";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember
} from "discord.js";
import { loadConfig } from "./config.js";
import { SqliteDatabase } from "./db.js";
import { Logger } from "./logger.js";
import { AccountService } from "./services/accounts.js";
import { WatchService, memberAccessForWatch } from "./services/watches.js";
import { NotificationService } from "./services/notifications.js";
import { getStats } from "./services/stats.js";
import { ApprovalStore } from "./services/approval.js";
import { canUseAdminStats } from "./services/permissions.js";
import { MemberCache } from "./services/member-cache.js";
import { HealthcheckService } from "./services/healthcheck.js";
import { isGatewayReady } from "./services/gateway-state.js";
import { helpText } from "./help.js";
import { createMessageVisibility } from "./services/message-visibility.js";
import { authorizeQueuedNotification } from "./services/authorization.js";
import { SingleFlight } from "./services/single-flight.js";
import { UserFacingError, userMessageForError } from "./services/user-error.js";
import { confirmAccountDeletion } from "./services/account-delete-button.js";
import { cancelAccountDeletion } from "./services/account-delete-button.js";
import { createDiscordNotificationSender } from "./services/discord-notification-sender.js";
import { getGuildGateState, shouldLeaveNewGuild } from "./services/guild-gate.js";

const config = loadConfig();
const logger = new Logger(config.LOG_LEVEL);
const db = await SqliteDatabase.open(config.DATABASE_PATH, { requireExisting: true });
db.cleanup();
const accounts = new AccountService(db, config.DEVELOPER_TEST_DISCORD_ID, config.LINK_CODE_PEPPER, config.FREE_LINK_LIMIT);
const watches = new WatchService(db, accounts);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});
const notifications = new NotificationService(
  db,
  accounts,
  logger,
  () => Date.now(),
  { maxPendingPerMain: config.MAX_PENDING_PER_MAIN, minIntervalMs: config.DM_MIN_INTERVAL_MS },
  (guildId, channelId) => {
    const guild = client.guilds.cache.get(guildId);
    const channel = channelId ? guild?.channels.cache.get(channelId) : undefined;
    const guildName = guild?.name;
    const channelName = channel && "name" in channel && typeof channel.name === "string" ? channel.name : undefined;
    return {
      ...(guildName ? { guildName } : {}),
      ...(channelName ? { channelName } : {})
    };
  }
);
const healthchecks = new HealthcheckService(db, logger, config.HEALTHCHECKS_HEARTBEAT_URL, config.HEALTHCHECKS_MAX_PENDING_QUEUE, config.HEALTHCHECKS_MAX_FAILURES_15M, undefined, undefined, {
  maxQueueAgeMs: config.HEALTHCHECKS_MAX_QUEUE_AGE_MS,
  maxOffsiteBackupAgeMs: config.HEALTHCHECKS_MAX_OFFSITE_BACKUP_AGE_MS,
  offsiteStatusPath: config.HEALTHCHECKS_OFFSITE_STATUS_PATH
});
const pendingApprovals = new ApprovalStore();
const pendingDeletions = new ApprovalStore();
const memberCache = new MemberCache<GuildMember>(5_000);
const notificationWorker = new SingleFlight();
function interactionError(error: unknown, action: string): string {
  if (error instanceof UserFacingError) return error.message;
  // Unexpected errors can contain Discord/DB internals. Keep details in the
  // operator log and give users one actionable, stable response.
  logger.error("interaction failed", { action, errorName: error instanceof Error ? error.name : "unknown" });
  return userMessageForError(error);
}

function privateReply(interaction: ChatInputCommandInteraction | ButtonInteraction, content: string, components?: ActionRowBuilder<ButtonBuilder>[]): Promise<unknown> {
  const message = { content, ...(components ? { components } : {}) };
  if (interaction.replied || interaction.deferred) return interaction.editReply(message);
  return interaction.reply({ ...message, ...(interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {}) });
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
      await watches.set(interaction.guildId, interaction.user.id, sub === "on", memberAccessForWatch(async (userId) => {
        const guild = interaction.guild;
        if (!guild) throw new UserFacingError("メンバーを確認できません。時間をおいて再度お試しください。");
        return guild.members.fetch(userId);
      }));
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
      await privateReply(interaction, `${config.APP_NAME}に保存された連携・監視設定・通知履歴など、このアカウントのデータを削除します。バックアップ上のコピーは保持期間中残る場合があります。この操作は取り消せません。`, [row]);
      return;
    }
    if (interaction.commandName === "status") {
      const status = accounts.getStatus(interaction.user.id);
      if (status.kind === "none") { await privateReply(interaction, "まだ設定されていません。メインアカウントなら /main set を実行してください。"); return; }
      if (status.kind === "main") {
        const links = status.links.length ? status.links.map((link) => `${link.username}${link.watchOffGuilds?.length ? `（個別OFF ${link.watchOffGuilds.length}件）` : "（自動監視）"}`).join("、") : "なし";
        await privateReply(interaction, `立場：メイン\n連携数：${status.links.length}/${status.linkLimit ?? 1}\nβ版Free上限：サブアカウント1つ（開発者・テスト用/Pro：5つ）\n連携中：${links}\n個別OFFサーバー数：${status.watchOffGuilds.length}${status.alsoLinkedAsSub ? "\n別のメインアカウントにもサブとして連携中です。/account delete は両方のデータを削除します。" : ""}`);
        return;
      }
      await privateReply(interaction, `立場：サブ\n連携先：${status.mainUsername}\n監視：Bot導入済みで参加中のサーバーを自動監視\n個別OFFサーバー数：${status.watchOffGuilds.length}`);
      return;
    }
    if (interaction.commandName === "admin-stats") {
      if (!canUseAdminStats(interaction.user.id, config.OWNER_DISCORD_ID)) { await privateReply(interaction, "権限がありません"); return; }
      const stats = getStats(db, isGatewayReady(client), client.guilds.cache.size, Date.now(), config.GUILD_VERIFICATION_PREP_THRESHOLD, config.GUILD_HARD_LIMIT);
      await privateReply(interaction, `導入サーバー数：${stats.guilds}\nVerification準備開始：${stats.prepThreshold}\n新規導入停止：${stats.hardLimit}\nゲート状態：${stats.verificationState}\nメイン登録数：${stats.mainAccounts}\n連携済みアカウント数：${stats.linkedAccounts}\n本日の通知送信数：${stats.notificationsSentToday}\n送信失敗数：${stats.notificationFailures}\n送信待ち：${stats.pendingQueue}\nGateway：${stats.gatewayReady ? "接続" : "未接続"}`);
    }
  } catch (error) {
    await privateReply(interaction, interactionError(error, interaction.commandName)).catch(() => undefined);
  }
}

let startupGuildIds = new Set<string>();
let initialReadyHandled = false;
client.once(Events.ClientReady, (ready) => {
  const gatewayReady = isGatewayReady(client);
  logger.info("gateway ready", { guilds: ready.guilds.cache.size, shardCount: client.ws.shards.size, allShardsReady: gatewayReady });
  startupGuildIds = new Set(ready.guilds.cache.keys());
  initialReadyHandled = true;
  const gate = getGuildGateState(ready.guilds.cache.size, config.GUILD_VERIFICATION_PREP_THRESHOLD, config.GUILD_HARD_LIMIT);
  if (gate === "verification_prep") logger.warn("guild verification preparation threshold reached", { guilds: ready.guilds.cache.size, threshold: config.GUILD_VERIFICATION_PREP_THRESHOLD, hardLimit: config.GUILD_HARD_LIMIT });
  if (ready.guilds.cache.size === config.GUILD_HARD_LIMIT) logger.warn("guild hard limit reached at startup; existing guilds retained", { guilds: ready.guilds.cache.size, hardLimit: config.GUILD_HARD_LIMIT });
  if (ready.guilds.cache.size > config.GUILD_HARD_LIMIT) logger.error("guild hard limit exceeded at startup; existing guilds retained", { guilds: ready.guilds.cache.size, hardLimit: config.GUILD_HARD_LIMIT });
  void healthchecks.check(gatewayReady);
});
client.on(Events.GuildCreate, (guild) => {
  if (!initialReadyHandled || startupGuildIds.has(guild.id)) return;
  const guildCount = client.guilds.cache.size;
  const gate = getGuildGateState(guildCount, config.GUILD_VERIFICATION_PREP_THRESHOLD, config.GUILD_HARD_LIMIT);
  if (guildCount === config.GUILD_VERIFICATION_PREP_THRESHOLD) {
    logger.warn("guild verification preparation threshold reached", { guilds: guildCount, threshold: config.GUILD_VERIFICATION_PREP_THRESHOLD, hardLimit: config.GUILD_HARD_LIMIT });
  }
  if (shouldLeaveNewGuild({ guildId: guild.id, currentGuildCount: guildCount, hardLimit: config.GUILD_HARD_LIMIT, startupGuildIds })) {
    logger.warn("new guild rejected above hard limit", { guilds: guildCount, hardLimit: config.GUILD_HARD_LIMIT });
    void guild.leave().catch((error: unknown) => logger.error("new guild rejection failed", { errorName: error instanceof Error ? error.name : "unknown", guilds: guildCount, hardLimit: config.GUILD_HARD_LIMIT }));
  } else if (gate === "expansion_stopped") {
    logger.warn("guild hard limit reached; new guilds will be rejected", { guilds: guildCount, hardLimit: config.GUILD_HARD_LIMIT });
  }
});
function logGatewayConnected(shardId: number): void {
  // A single shard recovering is not enough to validate the whole Gateway.
  // ClientReady covers first login; these events cover re-identify and resume.
  if (isGatewayReady(client)) {
    logger.info("gateway connected", { shardId });
  }
}
client.on(Events.ShardReady, logGatewayConnected);
client.on(Events.ShardResume, logGatewayConnected);
client.on(Events.ShardDisconnect, (event, shardId) => logger.warn("gateway disconnected", { code: event.code, shardId }));
client.on(Events.ShardReconnecting, (shardId) => logger.warn("gateway reconnecting", { shardId }));
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) await handleCommand(interaction);
  if (!interaction.isButton()) return;
  if (interaction.customId.startsWith("account-delete-cancel:")) {
    const token = interaction.customId.slice("account-delete-cancel:".length);
    try { await cancelAccountDeletion(interaction, token, pendingDeletions); }
    catch (error) { await privateReply(interaction, interactionError(error, "account delete cancel")); }
    return;
  }
  if (interaction.customId.startsWith("account-delete:")) {
    const token = interaction.customId.slice("account-delete:".length);
    try {
      await confirmAccountDeletion(interaction, token, pendingDeletions, accounts);
    } catch (error) {
      const content = interactionError(error, "account delete");
      if (interaction.deferred) await interaction.editReply({ content, components: [] });
      else await privateReply(interaction, content);
    }
    return;
  }
  if (!interaction.customId.startsWith("link-approve:")) return;
  const token = interaction.customId.slice("link-approve:".length);
  try {
    const codeHash = pendingApprovals.consume(token, interaction.user.id);
    const result = accounts.approveLinkByHash(interaction.user.id, codeHash, interaction.user.username);
    await interaction.update({ content: "連携を承認しました。これで設定完了です。\nBotが導入され、サブアカウントが参加しているサーバーを自動監視します。\n通常は /watch on は不要です。", components: [] });
    await client.users.send(result.mainUserId, { content: `サブアカウント「${interaction.user.username}」を連携しました。`, allowedMentions: { parse: [] } }).catch((error: unknown) => logger.warn("link confirmation DM failed", { mainUserId: result.mainUserId, error: error instanceof Error ? error.message : "unknown" }));
  } catch (error) { await privateReply(interaction, interactionError(error, "link approve")); }
});
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author.bot || message.channel.type === ChannelType.PrivateThread) return;
    const mentionedUserIds = [...message.mentions.users.keys()];
    const mentionedRoleIds = [...message.mentions.roles.keys()];
    const labels = new Map(mentionedUserIds.map((id) => [id, message.mentions.users.get(id)?.globalName ?? message.mentions.users.get(id)?.username ?? id]));
    if (!message.mentions.everyone && mentionedUserIds.length === 0 && mentionedRoleIds.length === 0) return;
    await notifications.inspect({ id: message.id, guildId: message.guild.id, channelId: message.channelId, authorBot: message.author.bot, mentionedUserIds, mentionedRoleIds, mentionEveryone: message.mentions.everyone }, createMessageVisibility(message, memberCache), labels);
  } catch (error) { logger.error("message inspection failed", { error: error instanceof Error ? error.message : "unknown" }); }
});

const notificationSender = createDiscordNotificationSender(client.users);
const timer = setInterval(() => {
  void notificationWorker.run(() => notifications.drain(notificationSender, Date.now(), 50, { authorize: (input) => authorizeQueuedNotification(client, accounts, input) })).catch((error) => logger.error("notification worker failed", { error: error instanceof Error ? error.message : "unknown" }));
}, 5_000);
const memoryCleanupTimer = setInterval(() => {
  pendingApprovals.cleanup();
  pendingDeletions.cleanup();
  accounts.cleanupFailedAttempts();
  memberCache.cleanup();
}, 60_000);
memoryCleanupTimer.unref();
const cleanupTimer = setInterval(() => {
  try { db.cleanup(Date.now(), false); } catch (error) { logger.error("database cleanup failed", { error: error instanceof Error ? error.message : "unknown" }); }
}, 60 * 60 * 1_000);
const healthcheckTimer = config.HEALTHCHECKS_HEARTBEAT_URL ? setInterval(() => { void healthchecks.check(isGatewayReady(client)); }, config.HEALTHCHECKS_HEARTBEAT_INTERVAL_MS) : undefined;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  clearInterval(timer);
  clearInterval(memoryCleanupTimer);
  clearInterval(cleanupTimer);
  if (healthcheckTimer) clearInterval(healthcheckTimer);
  // The systemd stop budget is finite. Wait for a claimed DM to be marked
  // sent/failed before closing SQLite whenever the REST call completes.
  if (!(await notificationWorker.stop(20_000))) logger.warn("notification worker did not finish before shutdown timeout");
  client.destroy();
  db.close();
}
process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

client.login(config.DISCORD_TOKEN).catch((error: unknown) => {
  logger.error("gateway login failed", { error: error instanceof Error ? error.message : "unknown" });
  process.exitCode = 1;
  void shutdown("gateway login failed");
});
