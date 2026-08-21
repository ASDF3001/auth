# Discord 認証 Bot (auth)

高機能で安全な Discord サーバー向け認証 Bot です。

## 主な機能

1. **認証パネル設置 (`/set-panel`)**
   - パネルのタイトル・説明文・ボタンラベルを自由にカスタマイズ可能
   - パネルごとに付与するロールを個別に指定可能
2. **多彩な認証方式**
   - **ワンクリック認証**: ボタンを押すだけで即座にロールを付与
   - **CAPTCHA認証**: スパムBot対策としてランダムな4桁の認証コード入力
   - **合言葉認証**: ルールを読んだユーザーのみが通れるキーワード入力
3. **認証ログ通知**
   - 認証完了時に指定のチャンネルへログ（ユーザー情報・付与ロール・日時）を通知
4. **ウェルカムDM案内**
   - 認証完了時にユーザーへ自動で案内DMを送信
5. **ステータス自動ローテーション**
   - 10秒ごとに「〇〇人 \| 〇〇鯖」「ping 〇〇ms」「Powered by rds9」を切り替え表示

## セットアップ手順

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 環境変数の設定

`.env.example` をコピーして `.env` を作成し、必要な値を設定します。

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
ROLE_ID=your_default_role_id_here
LOG_CHANNEL_ID=your_log_channel_id_here # 任意（未設定時はログ送信なし）
```

### 3. Botの起動

```bash
node index.js
```

## コマンド一覧

- `/set-panel` (管理者限定)
  - `role`: 付与するロール（未指定時はデフォルトロール）
  - `title`: パネルのタイトル
  - `description`: パネルの説明文
  - `button_label`: ボタンの表示テキスト
  - `auth_type`: 認証方式 (`ワンクリック認証` / `CAPTCHA認証` / `合言葉認証`)
  - `passphrase`: 合言葉認証を選択した場合の正解キーワード

## ライセンス

[MIT License](LICENSE)
