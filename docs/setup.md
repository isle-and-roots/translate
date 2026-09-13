# 運用・配備メモ

## Worker シークレット

| 名前 | 内容 |
| --- | --- |
| `OPENAI_API_KEY` | 標準 API キー（拡張に配布しない） |
| `PAIRING_TOKEN_SHA256` | 接続コードの SHA-256（hex, lower） |

## 変数

| 名前 | 内容 |
| --- | --- |
| `ALLOWED_EXTENSION_ORIGIN` | `chrome-extension://<ID>` |
| `ENABLED` | `true` / `false` |

## エンドポイント

`POST /api/translation-token`

```http
Authorization: Bearer <pairing-token>
Content-Type: application/json

{"direction":"rx"}
```

成功時:

```json
{
  "clientSecret": "ek_...",
  "expiresAt": "2026-09-13T00:00:00.000Z",
  "direction": "rx",
  "targetLanguage": "ja",
  "requestId": "..."
}
```

## 拡張の永続データ

- `storage.local`: デバイス ID、音量、Broker URL、表示名
- `storage.session`: 接続コードのみ
- 会話・字幕・OpenAI 短期トークンは永続化しない
