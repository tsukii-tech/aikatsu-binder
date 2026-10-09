# アイカツ！バインダー：Renderで所持データを永続化する手順

## この修正版で変わること

- `DATA_DIR` 環境変数で保存先を切り替えられます。
- RenderのPersistent Diskを `/var/data` に接続し、`DATA_DIR=/var/data` に設定すると、カード情報・管理者設定・ユーザー一覧・ユーザーごとの所持データをディスク上に保存します。
- ログアウト、再ログイン、GitHubからの再デプロイ、通常のサーバー再起動後も、Persistent Disk上のJSONファイルを使い続けます。
- JSONファイルは一時ファイルに書いてから置き換え、書き込み途中の破損を減らします。
- ZIPには `data/` の中身を含めていません。既存データを誤って上書きしないためです。

## 重要：デプロイ前に既存データを確認・バックアップ

このZIPはソースコードだけでは、現在のRenderインスタンス内にある未バックアップのデータを取得できません。現在の所持状況を失わないように、ディスク設定や再デプロイの前に、現在の `data/cards.json`、`data/admin.json`、`data/users.json`、`data/user-data.json` をバックアップしてください。現在の環境にこれらのファイルが存在しない場合、以前の所持状況をコードだけで復元することはできません。

## Render Dashboardでの設定

1. Render Dashboardで、アイカツ！バインダーの **Web Service** を開きます。
2. **Disks** からPersistent Diskを追加します。
3. Mount Pathを `/var/data` にします。小規模なJSONデータなら最小サイズから始められます。
4. Persistent DiskはRenderのFree Web Serviceでは利用できないため、利用中のプランがFreeの場合は対応する有料インスタンスへの変更が必要です。
5. ディスクの追加後、サービスの **Environment** で次の環境変数を設定します。
   - Key: `DATA_DIR`
   - Value: `/var/data`
6. Build Commandは `npm install`（依存パッケージなしでも実行可）、Start Commandは `npm start` にします。現在の設定が動作している場合、Start Commandだけ `npm start` に変更しても構いません。
7. GitHubへ修正版を反映し、Renderでデプロイします。

## 既存データの移行

初回起動時、`/var/data` に各JSONファイルがなく、アプリの `data/` フォルダにファイルが存在する場合に限り、修正版はそちらからコピーします。Persistent Diskに既にあるファイルは上書きしません。

ただし、Renderの一時ファイルシステムにだけ存在し、GitHubにもバックアップにもないデータは、この移行処理では取得できません。既存の所持データを確実に引き継ぐには、デプロイ前に実際のデータファイルをバックアップし、Persistent Disk上へ移行してください。

## 保存されるファイル

- `cards.json`：カード情報
- `admin.json`：管理者設定
- `users.json`：ユーザー一覧
- `user-data.json`：ユーザーごとの所持・お気に入り・QR情報

`user-data.json` はユーザーIDごとのデータを保持します。ユーザー名だけをキーにしないため、表示名の変更で所持状況が別ユーザーに混ざりにくい構造です。

## 運用上の注意

- GitHubに `data/` の実データを含める必要はありません。むしろパスワード情報や利用者のデータを公開リポジトリへ入れないでください。
- Persistent Diskは単一のサービスインスタンスから使う構成です。複数インスタンスへ拡張する場合は、Render Postgresなどのデータベースへ移行してください。
- ディスクの追加・マウントパス変更前には必ずバックアップしてください。
