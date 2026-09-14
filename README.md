# Meet Interpreter

Google Meet / Zoom 向けの英日双方向通訳 Chrome 拡張（Manifest V3）と、OpenAI 短期トークンを発行する Cloudflare Worker です。

相手の英語を日本語でイヤホンへ、自分の日本語を英語にして BlackHole 経由で会議アプリへ送ります。会議音声は Worker を経由しません。

## 対応会議アプリ

| 会議アプリ | 音声の取り方 | 追加で必要なもの |
| --- | --- | --- |
| Google Meet（Chrome タブ） | `tabCapture` | なし |
| Zoom ブラウザ版（Chrome タブ・URL に `/wc/`） | `tabCapture` | なし |
| Zoom デスクトップアプリ | 仮想デバイス経由の `getUserMedia` | 2 つ目の仮想デバイス（BlackHole 16ch など） |

Zoom ブラウザ版は `zoom.us` / `zoom.com` / `zoomgov.com` とそのサブドメイン（`app.`、`us02web.`、`pwa.` など）を判定します。`https://zoom.us/j/...` のような起動ページは対象外で、「ブラウザから参加」で開いた `/wc/` の画面が対象です。

## 構成

| 要素 | 役割 |
| --- | --- |
| `extension/` | ポップアップ / setup / offscreen / service worker |
| `worker/` | 認証付き `POST /api/translation-token` |
| `shared/` | コマンド・状態・設定の型と検証、会議アプリ判定 |

## 必要条件

- macOS（V1 受入想定）+ Google Chrome 116+
- [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole)
- Zoom デスクトップアプリを使う場合: BlackHole 16ch（2ch とは別のデバイス）
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
4. （Zoom アプリを使う場合）「2b. Zoom デスクトップアプリ」で会議音声入力に **BlackHole 16ch** を選択
5. Worker URL と接続コードを保存

接続コードは `chrome.storage.session` のみに保持されます。Chrome 再起動後は再入力が必要です。OpenAI API キーは拡張に入れません。

### 5. 会議アプリ側の音声設定

| | マイク | スピーカー |
| --- | --- | --- |
| Google Meet | BlackHole 2ch | イヤホン |
| Zoom ブラウザ版 | BlackHole 2ch | イヤホン |
| Zoom デスクトップアプリ | BlackHole 2ch | **BlackHole 16ch**（拡張が原音を取り込み、イヤホンへ再生します） |

Zoom では「オリジナルサウンド」を有効にし、背景雑音抑制を「低」にしてください。既定の強い雑音抑制は合成音声（英訳）を欠落させることがあります。

## 使い方

### Google Meet / Zoom ブラウザ版

1. 会議に参加し、機器設定を確認（Zoom は「ブラウザから参加」で `/wc/` の画面を開く）
2. 会議タブを前面にして拡張を開く。「接続先」が **前面タブ** になり、会議アプリが自動検出される
3. **開始（双方向）** をワンクリック
4. そのまま会話（相手の英語→日本語で聴取、自分の声→英語で会議へ）
5. 退室前は **すべて停止**

### Zoom デスクトップアプリ

1. Zoom の設定 > オーディオで マイク = BlackHole 2ch、スピーカー = BlackHole 16ch にして会議に参加
2. 拡張を開き、「接続先」を **Zoom デスクトップアプリ（仮想デバイス）** にする（会議タブがなく 16ch が設定済みなら自動で選ばれます）
3. **開始（双方向）** をワンクリック。以降は同じ
4. Zoom のスピーカーは BlackHole 16ch に向いているため、相手の原音・訳音はどちらも拡張経由でイヤホンから聞こえます

### 操作一覧

- **接続先** … 前面タブ（Meet / Zoom ブラウザ版）か Zoom アプリ（仮想デバイス）を選択。動作中は変更不可
- **開始（双方向）** … 受信（EN→JA）と送信（JA→EN）をまとめて起動
- **すべて停止** … 両方向を停止（出力遮断 → 接続解放 → キャプチャ終了）
- **送信だけ停止 / 送信を再開（緊急）** … 通常は使わない。送信だけ切りたいとき用
- **原音を聞く** … 原音 100% / 訳音 0% の一時切替

### Zoom アプリの音声経路

```
Zoom スピーカー ──▶ BlackHole 16ch ──▶ 拡張（原音 + EN→JA 訳）──▶ イヤホン
物理マイク ──▶ 拡張（JA→EN 訳）──▶ BlackHole 2ch ──▶ Zoom マイク
```

16ch と 2ch は必ず別デバイスにしてください。同じ BlackHole を Zoom のスピーカーとマイクの両方に使うと Zoom の出力がそのままマイクへ戻りループします。setup と開始時にこの組み合わせは拒否されます。

## セキュリティ

- Worker は Bearer 接続コードの SHA-256 照合が必須
- CORS は固定した `chrome-extension://<ID>` のみ
- 標準 OpenAI API キーは Worker シークレットのみ
- 短期トークンはメモリ上で使い捨て、永続化しない
- 音声・字幕・会議 URL・SDP・資格情報はログに出さない

## 本番稼働

シークレットの配備から受入・運用・ロールバックまでの手順は [docs/release.md](docs/release.md) にまとめています。CI（GitHub Actions）はテスト・型検査・拡張ビルド・Worker ドライランを毎回実行し、リポジトリ変数 `BROKER_BASE_URL` があれば配布用 zip をアーティファクトとして出力します。

## 開発

```bash
npm run build          # 拡張を extension/dist へ
npm run package        # extension/dist を dist/*.zip に固定（要 BROKER_BASE_URL 付きビルド）
npm run build:worker   # Worker のドライランビルド
npm run deploy:worker  # Worker をデプロイ（wrangler login 済みが前提）
npm run typecheck      # TypeScript
npm test               # 単体 / 契約テスト
npm run gen:pairing    # 接続コード生成
```

安定した拡張 ID が必要な場合は、PEM を `EXTENSION_KEY` に渡してビルドします。

```bash
EXTENSION_KEY="$(cat extension.pem)" BROKER_BASE_URL=https://....workers.dev npm run build
```

## 制限（V1）

- 話者分離なし（tabCapture / 仮想デバイスは混合音声）
- 送信切断後の自動再開なし（緊急ボタンで手動再開）
- 暫定 45 分更新案内 / 50 分計画停止
- 概算費用の警告・停止は端末側の目安（請求確定値ではない）
- Windows は VB-CABLE 等への置換と再試験が必要
- Zoom アプリモードでは、Zoom 側で自分の声のエコーキャンセルが働かないため、必ずイヤホンを使うこと
- Zoom アプリのタブ閉鎖・再読込に相当する検知はない（会議終了後は手動で **すべて停止**。無活動 10 分で自動停止）

## 実機試験が必要な項目

自動テストでは会議タブ音声・仮想デバイス経路・WebRTC 実接続までは検証できません。設計書 T01–T15 の受入は本人環境で実施してください。Zoom 追加分の受入項目は [docs/zoom.md](docs/zoom.md) を参照してください。
