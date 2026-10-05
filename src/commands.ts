import { REST, Routes, SlashCommandBuilder } from "discord.js";
import type { AppConfig } from "./config.js";

export function commandDefinitions(appName = "AltNoti") {
  return [
    new SlashCommandBuilder().setName("main").setDescription("メインアカウントを登録します").addSubcommand((s) => s.setName("set").setDescription("このアカウントをメインに設定")),
    new SlashCommandBuilder().setName("link").setDescription("アカウント連携を管理します")
      .addSubcommand((s) => s.setName("issue").setDescription("連携コードを発行"))
      .addSubcommand((s) => s.setName("approve").setDescription("連携コードを承認").addStringOption((o) => o.setName("code").setDescription("連携コード").setRequired(true))),
    new SlashCommandBuilder().setName("watch").setDescription("通知監視を管理します")
      .addSubcommand((s) => s.setName("on").setDescription("このサーバーを監視"))
      .addSubcommand((s) => s.setName("off").setDescription("このサーバーの監視を停止"))
      .addSubcommand((s) => s.setName("status").setDescription("このサーバーの監視状態")),
    new SlashCommandBuilder().setName("unlink").setDescription("アカウント連携を解除").addUserOption((o) => o.setName("account").setDescription("メイン側が解除するサブアカウント")),
    new SlashCommandBuilder().setName("status").setDescription("連携と監視設定を表示"),
    new SlashCommandBuilder().setName("help").setDescription("使い方を表示"),
    new SlashCommandBuilder().setName("account").setDescription("アカウント設定を管理します")
      .addSubcommand((s) => s.setName("refresh").setDescription("保存済み表示情報を現在のDiscord情報へ更新"))
      .addSubcommand((s) => s.setName("delete").setDescription(`${appName}の登録データを削除`)),
    new SlashCommandBuilder().setName("admin-stats").setDescription("運営統計を表示")
  ];
}

export async function deployCommands(config: AppConfig): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
  const body = commandDefinitions(config.APP_NAME).map((command) => command.toJSON());
  if (config.DISCORD_DEV_GUILD_ID) await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_DEV_GUILD_ID), { body });
  else await rest.put(Routes.applicationCommands(config.DISCORD_CLIENT_ID), { body });
}
