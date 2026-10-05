export function helpText(appName: string): string {
  return `【${appName}とは】
別のDiscordアカウントへのメンションを、メインアカウントへ通知します。

【最短設定】
1. メイン垢：/main set
2. メイン垢：/link issue
3. サブ垢：/link approve
4. 承認ボタンを押す

/watch on は通常不要です。
同じアカウントをメインとサブの両方には登録できません。

β版では、通常Freeユーザーはサブアカウントを1つまで無料で連携できます。開発者・テスト用権限は5つまでです。

【通知対象】
・サブ垢への直接メンション
・サブ垢が所属するロールへのメンション
・@everyone / @here 相当

ロールメンションはDiscord本体の通知設定とは独立して判定します。

【通知対象外】
・普通のメッセージ、DM、非公開スレッド、キーワード
・メッセージ本文

【設定】
/watch off /watch on /watch status /status /unlink /account refresh /account delete`;
}
