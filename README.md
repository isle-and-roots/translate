# Meet Interpreter

Google Meet 向けの英日双方向通訳 Chrome 拡張（Manifest V3）と、OpenAI 短期トークンを発行する Cloudflare Worker です。

相手の英語を日本語でイヤホンへ、自分の日本語を英語にして BlackHole 経由で Meet へ送ります。会議音声は Worker を経由しません。

## 構成

| 要素 | 役割 |
| --- | --- |
| `extension/` | ポップアップ / setup / offscreen / service worker |
| `worker/` | 認証付き `POST /api/translation-token` |
| `shared/` | コマンド・状態・設定の型と検証 |

## 必要条件

- macOS（V1 受入想定）+ Google Chrome 116+
- [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole)
- OpenAI API（`gpt-realtime-translate` が使えるプロジェクト）
- Cloudflare アカウント（Workers）
- 有線イヤホン推奨（AirPods は追加試験）

## セットアップ

### 1. 依存関係とビルド

```bash
npm install
node scripts/generate-icons.mjs
BROKER_BASE_URL=https://YOUR-SUBDOMAIN.workers.dev npm run build
npm test
```

成果物は `extension/dist/` です。Chrome の「パッケージ化されていない拡張機能を読み込む」でこのフォルダを指定します。

拡張を読み込んだら `chrome://extensions` で **拡張 ID** を控えます。

### 2. 接続コード（ペアリング）

```bash
npm run gen:pairing
```

表示されたトークンを setup 画面に入力し、SHA-256 を Worker シークレットに登録します。

### 3. Cloudflare Worker

```bash
cd worker
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put PAIRING_TOKEN_SHA256
```

`wrangler.toml` の `ALLOWED_EXTENSION_ORIGIN` を次の形式に更新します。

```toml
ALLOWED_EXTENSION_ORIGIN = "chrome-extension://<YOUR_EXTENSION_ID>"
```

デプロイ:

```bash
npx wrangler deploy
```

### 4. 拡張の初期設定（setup）

1. BlackHole 2ch をインストールし、Chrome を再起動
2. 拡張の「設定」を開き、マイク権限を許可
3. 物理マイク / イヤホン出力 / BlackHole 出力を選択
4. Worker URL と接続コードを保存
5. Meet のマイクを **BlackHole 2ch**、スピーカーを **イヤホン** に設定

接続コードは `chrome.storage.session` のみに保持されます。Chrome 再起動後は再入力が必要です。OpenAI API キーは拡張に入れません。

## 使い方

1. Meet に参加し、機器設定を確認
2. Meet タブを前面にして拡張を開き **開始（双方向）** をワンクリック
3. そのまま会話（相手の英語→日本語で聴取、自分の声→英語で Meet へ）
4. 退室前は **すべて停止**

### 操作一覧

- **開始（双方向）** … 受信（EN→JA）と送信（JA→EN）をまとめて起動
- **すべて停止** … 両方向を停止（出力遮断 → 接続解放 → キャプチャ終了）
- **送信だけ停止 / 送信を再開（緊急）** … 通常は使わない。送信だけ切りたいとき用
- **原音を聞く** … 原音 100% / 訳音 0% の一時切替

## セキュリティ

- Worker は Bearer 接続コードの SHA-256 照合が必須
- CORS は固定した `chrome-extension://<ID>` のみ
- 標準 OpenAI API キーは Worker シークレットのみ
- 短期トークンはメモリ上で使い捨て、永続化しない
- 音声・字幕・会議 URL・SDP・資格情報はログに出さない

## 開発

```bash
npm run build          # 拡張を extension/dist へ
npm run typecheck      # TypeScript
npm test               # 単体 / 契約テスト
npm run gen:pairing    # 接続コード生成
```

安定した拡張 ID が必要な場合は、PEM を `EXTENSION_KEY` に渡してビルドします。

```bash
EXTENSION_KEY="$(cat extension.pem)" BROKER_BASE_URL=https://....workers.dev npm run build
```

## 制限（V1）

- 話者分離なし（tabCapture は混合音声）
- 送信切断後の自動再開なし（緊急ボタンで手動再開）
- 暫定 45 分更新案内 / 50 分計画停止
- 概算費用の警告・停止は端末側の目安（請求確定値ではない）
- Windows は VB-CABLE 等への置換と再試験が必要

## 実機試験が必要な項目

自動テストでは Meet タブ音声・BlackHole 経路・WebRTC 実接続までは検証できません。設計書 T01–T15 の受入は本人環境で実施してください。
