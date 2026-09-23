export function helpText(appName: string): string {
  return `【${appName}とは】
別のDiscordアカウントへのメンションを、メインアカウントへ通知します。

【最短設定】
1. メイン垢：/main set
2. メイン垢：/link issue
3. サブ垢：/link approve
4. 承認ボタンを押す

/watch on は通常不要です。

【通知対象】
・サブ垢への直接メンション
・@everyone / @here 相当

【通知対象外】
・普通のメッセージ、DM、キーワード
・メッセージ本文

【設定】
/watch off /watch on /watch status /status /unlink /account delete`;
}
