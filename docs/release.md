# 本番稼働手順（Runbook）

自動化できる範囲（テスト・型検査・ビルド・パッケージ）は CI（`.github/workflows/ci.yml`）で毎回検証されます。以下は **本人環境と各サービスのシークレットが必要** なため手動で行う工程です。上から順に実施してください。

## 0. 前提

- macOS + Chrome 116+
- BlackHole 2ch（全構成）／ BlackHole 16ch（Zoom デスクトップアプリを使う場合）
- OpenAI API キー（`gpt-realtime-translate` が使えるプロジェクト）
- Cloudflare アカウントで `wrangler login` 済み

## 1. 接続コードの発行

```bash
npm ci
npm run gen:pairing
```

出力される **接続コード**（拡張の setup に入力）と **SHA-256**（Worker のシークレット）を控えます。接続コードは本人以外に渡しません。

## 2. Worker を先にデプロイして URL を確定

```bash
cd worker
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put PAIRING_TOKEN_SHA256   # 手順1の SHA-256
npx wrangler deploy
cd ..
```

デプロイ出力の `https://meet-interpreter-broker.<subdomain>.workers.dev` を **Broker URL** として控えます。`curl https://.../healthz` が `{"ok":true,"enabled":true}` を返せば稼働しています。この時点では `ALLOWED_EXTENSION_ORIGIN` がプレースホルダのため、拡張からの呼び出しは 403 になります（想定どおり）。

## 3. 拡張をビルドして読み込み、拡張 ID を確定

```bash
BROKER_BASE_URL=https://meet-interpreter-broker.<subdomain>.workers.dev npm run build
```

1. `chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」→ `extension/dist`
2. 表示される **拡張 ID** を控える

拡張 ID を固定したい場合（再読み込みで CORS 設定を壊さないため推奨）:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out extension.pem   # 初回のみ・git 管理外
EXTENSION_KEY="$(cat extension.pem)" BROKER_BASE_URL=https://... npm run build
```

## 4. Worker の CORS を拡張 ID に固定して再デプロイ

`worker/wrangler.toml`:

```toml
ALLOWED_EXTENSION_ORIGIN = "chrome-extension://<手順3の拡張ID>"
```

```bash
npm run deploy:worker
```

疎通確認（401 が返れば認証と CORS が効いています）:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST https://meet-interpreter-broker.<subdomain>.workers.dev/api/translation-token \
  -H "Origin: chrome-extension://<拡張ID>" -H "Content-Type: application/json" \
  -H "Authorization: Bearer wrong" -d '{"direction":"rx"}'
```

## 5. 拡張の初期設定

拡張の「設定」（setup）で:

1. マイク権限を許可
2. 物理マイク / イヤホン出力 / 仮想マイク出力（BlackHole 2ch）
3. Zoom アプリを使う場合: 「2b」で会議音声入力 = BlackHole 16ch
4. Broker URL と接続コード（手順1）を保存

## 6. 会議アプリ側の設定

| | マイク | スピーカー | 備考 |
| --- | --- | --- | --- |
| Google Meet | BlackHole 2ch | イヤホン | |
| Zoom ブラウザ版 | BlackHole 2ch | イヤホン | 「ブラウザから参加」（URL に `/wc/`） |
| Zoom デスクトップアプリ | BlackHole 2ch | BlackHole 16ch | オリジナルサウンド ON、雑音抑制「低」、マイク自動調整 OFF |

## 7. 受入試験

- 設計書 T01–T15（Meet）
- `docs/zoom.md` Z01–Z12（Zoom ブラウザ版 / アプリ）

最低限、本番前に確認するもの:

- [ ] テスト会議で **日本語の原音が相手に届かない**（相手側の耳で確認）
- [ ] 相手の英語が日本語でイヤホンから聞こえる
- [ ] 「すべて停止」で BlackHole 出力が即時無音になる
- [ ] イヤホンを抜くと全停止する（ループ回避）
- [ ] Zoom アプリ: BlackHole 16ch を選ばずに開始するとエラーで止まる

## 8. 配布物の固定（任意）

```bash
BROKER_BASE_URL=https://... EXTENSION_KEY="$(cat extension.pem)" npm run build
npm run package     # dist/meet-interpreter-<version>.zip
```

zip を控えておくと、別マシンでも同じ拡張 ID・同じ Broker URL で復元できます。CI でもリポジトリ変数 `BROKER_BASE_URL` を設定すると同じ zip がアーティファクトとして生成されます（`EXTENSION_KEY` は CI に置かないこと）。

## 9. 運用

- 接続コードは Chrome 再起動ごとに setup で再入力（session 保存のみ）
- 費用: 概算 $5 で警告、$10 で自動停止（請求確定値ではない）。OpenAI 側にも利用上限を設定すること
- 緊急停止: Worker の `ENABLED = "false"` にして `npm run deploy:worker` → 以降のトークン発行を全拒否
- 接続コード漏えい時: `npm run gen:pairing` で再発行し、`PAIRING_TOKEN_SHA256` を差し替えて再デプロイ

## ロールバック

- Worker: `cd worker && npx wrangler rollback`
- 拡張: 直前の zip を展開して `extension/dist` に置き換え、`chrome://extensions` で再読み込み
