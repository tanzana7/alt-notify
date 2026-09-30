# AltNoti スケーラビリティ調査

調査日：2026-09-30

この文書は、現在の実装を変更せずに、イベント経路・ローカルモック負荷・本番VMの観測値を整理したものです。ユーザー数や市場平均からの推定ではありません。

## 結論

現在の1 Guild・少数連携ではSQLiteを維持できます。通常メッセージはメンション配列を確認して即時終了するため、連携数に比例した処理はありません。

最初のボトルネックは、ロール/全体メンションで連携サブアカウントごとに所属確認を行うREST/cache経路と、`sql.js` が書き込みのたびにデータベース全体をエクスポートして保存する方式です。高頻度イベントや数百〜数千連携を前提にする前に、DBアダプタとMember情報の観測・キャッシュを見直す必要があります。

## 1イベントの処理経路

| 経路 | 受信時の処理 | DB | Discord API / cache | 通知処理 |
| --- | --- | --- | --- | --- |
| 通常メッセージ | `guild`、Bot投稿、`mention_everyone`、ユーザー/ロールメンション配列を確認して終了 | なし | なし | なし |
| 直接メンション | Guild監視対象をSELECTし、該当サブ垢だけ所属・閲覧権限を確認 | dedup INSERT、queue INSERT | Memberは5秒TTLの`MemberCache`。miss時に個別fetch。権限判定はcache上のMemberでローカル処理 | workerが送信直前に再確認し、DMを1通送信 |
| ロールメンション | Guildの監視対象リンクを取得し、各候補のMember所属とRole IDを照合 | 直接と同じ | Role判定のため各候補を個別確認。全メンバー一括取得なし | 直接と同じ。通知種別はロール |
| `@everyone` / `@here` | Guildの監視対象リンクを取得し、各候補の所属・閲覧権限を確認 | 直接と同じ | 各候補を個別確認 | queueに60秒遅延で保存し、送信直前に再確認 |

受信側は本文を解析せず、Discordメッセージオブジェクトの`mentions`、`mention_roles`、`mention_everyone`だけを利用します。Discord公式のMessage Objectにもこれらのフィールドがあり、本文・添付ファイルは`MESSAGE_CONTENT`の対象です。

### 送信直前の追加処理

通知workerは最大50件を取得し、条件付きUPDATEで1件ずつprocessingにします。認可を指定した場合は、Guild cache、必要ならchannel fetch、対象Member fetch、チャンネル閲覧権限を確認してから`users.fetch`とDM送信を行います。REST取得の一時失敗は有限retry、確定的な不在/権限なしはcancelです。

受信側のMemberCacheは5秒TTLですが、送信直前の`authorizeQueuedNotification`は別の再確認経路であり、MemberCacheを共有していません。これはプライバシー優先の再確認としては安全ですが、高負荷時にはREST回数の主要因になります。

## ローカルモック負荷試験

実行スクリプト：`scripts/benchmark.ts`

実行環境：Windows、Node.js v24.18.0、AMD Ryzen 5 PRO 5650U、物理メモリ約15.9GB。Discord REST/DMはモックし、本番DBは使用していません。SQLiteファイルはシナリオごとの一時DBです。

| シナリオ | 入力 | 経過時間 | 処理速度 | 最大RSS | DBサイズ | キュー結果 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 通常 | 100,000件 / 5,000リンク | 55ms | 約1,827,783件/s | 94MB | 438KB | なし |
| 直接 | 1,000件 / 5,000リンク | 34.7s | 約29件/s | 207MB | 659KB | pending 200 / failed 800 |
| ロール | 1,000件 / 100リンク | 7.3s | 約136件/s | 114MB | 4.26MB | pending 200 / failed 800 |
| 全体 | 1,000件 / 100リンク | 7.3s | 約138件/s | 98MB | 4.27MB | pending 200 / failed 800 |
| ロール | 100件 / 1,000リンク | 1.5s | 約67件/s | 70MB | 3.02MB | pending 100 |
| ロール | 100件 / 5,000リンク | 10.6s | 約9件/s | 69MB | 14.77MB | pending 100 |

直接1,000件/100リンクではqueue上限到達後の200件送信も実行し、モックDMは200件成功しました。`MAX_PENDING_PER_MAIN=200`により、超過分は黙って削除されずfailed記録になります。

直接10,000件/5,000リンク、ロール10,000件/100リンクは、ローカルで数分実行しても完了せず打ち切りました。後者では一時DBが約28MBまで増加しました。この値は「何件まで動く」という保証ではなく、現行保存方式の高負荷時の傾向を示す観測です。

### 測定値の読み方

- 通常メッセージは、5,000リンクでもDB/REST処理がゼロなので入力数に対して軽い。
- 直接メンションは対象ユーザーを絞れるが、毎イベントのDB全体保存が支配的になる。
- ロール/全体メンションは候補リンク数に比例してMember確認が増える。5,000リンクでは100イベントでも約9件/sまで低下した。
- DBサイズはリンク、dedup、queue履歴を含む。7日cleanupがあるため、長期サイズはイベント頻度と送信/失敗の比率に依存する。

## シナリオ別の見方

以下のA〜Dは負荷を比較するためのモデルです。投稿頻度は利用者の平均ではなく、観測したい入力レート`M`として扱います。

| シナリオ | Gateway | 現実的な評価 |
| --- | --- | --- |
| A：10 Guild / 20 user | `MESSAGE_CREATE`は全投稿を受信するが、通常投稿は早期終了 | 現行構成の対象範囲。RESTはメンション発生時だけで、SQLiteを維持しやすい |
| B：100 Guild / 500 user | Guild数より、同時に発生するロール/全体メンションと連携数が効く | まずMember fetch回数、pending滞留、p95処理時間を観測する段階 |
| C：1,000 Guild / 5,000 user | Gatewayイベント、Guild cache、REST確認対象が増える。1プロセス・1GB VMの余裕は測定なしに断定できない | VMメモリ、REST 429、queue age、SQLite保存時間を閾値監視し、sharding準備を始める |
| D：2,500 Guild以上 | Discord公式上、各shard最大2,500 Guildで、2,500以上のアプリはsharding必須 | 単一接続を継続しない。shard分割とDB共有設計を先に行う |

RESTの概算は、cache miss時のロール/全体イベントで最大`O(連携サブ垢数)`のMember取得、送信直前に対象ごとの再確認、さらに本垢ごとのDM送信です。Discordの全体HTTP制限は50 req/sで、per-route制限も別に存在するため、イベント数から単純に処理可能Guild数へ変換できません。

## SQLite評価

本番DBの読み取り確認では、`journal_mode=delete`、`synchronous=2 (FULL)`、page size 4096、19 pages、freelist 0でした。現在の`sql.js`はDB全体をWASMメモリに保持し、変更時に一時ファイルへ全量exportしてrenameします。これは単一Nodeプロセスでの原子保存には適しますが、WALを使うネイティブSQLiteの同時read/write特性とは異なります。

SQLite公式仕様上、複数readは可能でも同時writeは1つです。WALはreader/writerの同時性を改善しますが、現在のアプリの全量export方式を自動的にWAL化するものではありません。複数Botプロセス・複数ホスト共有へそのまま拡張する前提にはしません。

### 移行トリガー

次のいずれかを継続的に観測したら、単なるVM増強ではなく、ネイティブSQLite/WALまたはPostgreSQL等の評価を開始します。

- DB export/save p95が通知処理周期を超える
- DB write待ち、queue age、failed件数が継続的に増える
- 1プロセスのRSSがVMのメモリ余力を圧迫する
- 2つ以上のBot processや複数Shardを別ホストで動かす必要が出る
- バックアップ中のDB整合性・停止時間が許容できない
- queue上限200に近い状態が繰り返される

## Stage別ロードマップ

### Stage 1：現在

単一Oracle VM、単一Node process、SQLite、systemd。現状の運用を続け、`Gateway ready`、reconnect、RSS、DB save latency、queue age、429/5xx、failed件数を記録します。

### Stage 2：利用増加時

まずVMのメモリ/CPU余力を増やし、Member/Channel cacheのhit率とREST結果を計測可能にします。全量exportの時間が閾値を超えたら、ネイティブSQLite/WALまたはDBサーバー移行を比較します。

### Stage 3：Discord sharding

Guild数が2,500に近づく、またはGatewayイベント処理が1接続のCPU/メモリを継続的に圧迫した時点で導入します。Discordの`Get Gateway Bot`が返す推奨shard数とsession start limitを使い、Identifyを無制限に再試行しません。

### Stage 4：複数process / PostgreSQL

Shardを複数process・複数VMに分ける必要が出たとき、SQLite単一ファイルを共有しません。queue、dedup、account/watch設定をPostgreSQL等へ移し、worker leaseとmigration手順を定義します。

## 参照した公式資料

- [Discord Gateway](https://docs.discord.com/developers/events/gateway)
- [Discord Gateway Events / Message Create](https://docs.discord.com/developers/events/gateway-events)
- [Discord Message Resource](https://docs.discord.com/developers/resources/message)
- [Discord Guild Resource / Get Guild Member](https://docs.discord.com/developers/resources/guild)
- [Discord Rate Limits](https://docs.discord.com/developers/topics/rate-limits)
- [SQLite Transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [SQLite PRAGMA](https://www.sqlite.org/pragma.html)

