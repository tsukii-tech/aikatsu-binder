アイカツ！バインダー Supabase 永続保存版

【重要】このパッケージはSupabaseの public.app_storage テーブルを使用します。
必要なRender環境変数:
  SUPABASE_URL = SupabaseのProject URL
  SUPABASE_SECRET_KEY = SupabaseのSecret key

Supabase側で実行するSQL（作成済みなら再実行不要）:
create table if not exists public.app_storage (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_storage enable row level security;

手順:
1. 現在のGitHubリポジトリとRenderのログイン/所持データを可能な限りバックアップしてください。
2. ZIPの server.js、package.json、public/index.html、public/style.css、public/admin.html、public/admin.css を既存プロジェクトの同じ場所に反映します。
3. Renderの環境変数2つを確認し、デプロイします。
4. 最初の起動ではSupabaseにまだないキーだけ、ローカルJSONから初期登録します。既存のSupabaseキーは上書きしません。
5. RenderのLogsで [Supabase] 永続保存が有効です と表示されることを確認します。
6. テストユーザーで所持状態を変更し、ログアウト/再ログイン後に保持されるか確認してください。

保存するキー:
cards = cards.json
admin = admin.json
users = users.json
user-data = user-data.json

注意:
- Render Freeのファイルシステムにしか残っていない既存データは、初回起動前に消失すると復元できません。初回デプロイ前に、既存データをバックアップできるなら必ず行ってください。
- 初回起動時にSupabaseのテーブル/キーの読み書き権限に問題がある場合、アプリは起動を中止しLogsにエラーを出します。
- これは現在の同期型ファイル保存処理を維持しつつクラウド同期する互換アダプターです。保存はキューで順番に実行されます。テスト中に保存エラーが出た場合は利用を続けず、Logsを確認してください。
- Secret keyはHTMLやGitHubに記載しないでください。RenderのEnvironmentにだけ設定します。
