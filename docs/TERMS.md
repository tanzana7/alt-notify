# Alt Notify 利用条件（β版）

最終更新：2026-10-02

Alt Notifyは、Discordアカウント間の本人承認済み連携と、Discord公式Bot APIで受信した対象イベントの通知を補助するβ版サービスです。利用者は、利用するアカウントとサーバーについて必要な権限を持ち、Discordおよび所属サーバーの規約に従うものとします。

Alt NotifyはDiscordとは独立したサービスであり、Discordが提供・保証するサービスではありません。

## 禁止事項

- 他人のアカウントを本人の同意なく連携すること
- Discordのユーザートークン、Self-Bot、回避的な自動化を使うこと
- 大量リクエスト、スパム、嫌がらせ、違法行為、第三者の権利侵害
- Botやサービスの認証情報を第三者へ共有すること
- Bot、Discord API、サービスの脆弱性や権限を悪用すること

## β版の注意

本サービスはβ版であり、通知の到達、即時性、完全性、保存データの無欠損を保証しません。Discordの障害、権限変更、DM拒否、ネットワーク障害、VM障害、イベント欠落などで通知できない場合があります。サービスの仕様変更、停止、利用制限、終了を予告なく行う場合があります。

## データ削除

`/unlink` は個別連携を解除し、`/account delete` は本人の登録データ、監視設定、未送信通知を削除します。バックアップ上のコピーは保存世代の期限まで残る場合があります。

課金機能は公開βでは提供していません。利用者は、Botを導入するサーバーの管理者または必要な権限を持つ者として操作してください。

## 変更・連絡

利用条件はβ運用に合わせて更新します。一般的な問い合わせは [GitHub Issues](https://github.com/tanzana7/alt-notify/issues) を利用できます。公開Issueに個人情報・認証情報を投稿しないでください。

Discordの公式条件・開発者向け条件も適用されます。利用前に [Discord Terms of Service](https://discord.com/terms) と [Discord Developer Terms of Service](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service) を確認してください。
