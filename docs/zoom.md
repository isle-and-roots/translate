# Zoom 対応メモ

## 判定ロジック

`shared/platform.ts` の `detectTabPlatform(url)` が前面タブを分類します。

| URL | 結果 |
| --- | --- |
| `https://meet.google.com/...` | `meet` |
| `https://(sub.)zoom.us|zoom.com|zoomgov.com/wc/...` | `zoom-web` |
| 上記ホストで `/wc/` 以外（`/j/`, `/s/`, トップ） | 対象外・理由 `zoom_not_web_client`（ブラウザ版へ誘導） |
| その他 | 対象外・理由 `not_meeting` |

Zoom デスクトップアプリはタブではないため URL 判定はなく、ポップアップの「接続先」で `device` モードを明示します。

## キャプチャモード

| モード | 会議アプリ | 取得方法 | タブ閉鎖 / 再読込の検知 |
| --- | --- | --- | --- |
| `tab` | Meet / Zoom ブラウザ版 | `chrome.tabCapture.getMediaStreamId` → `getUserMedia(chromeMediaSource: tab)` | あり（自動停止） |
| `device` | Zoom アプリ | `getUserMedia({ deviceId: remoteCaptureInputId, echoCancellation/noiseSuppression/autoGainControl: false })` | なし（手動停止 / 無活動 10 分で停止） |

どちらのモードでも取得後の処理（原音モニター・EN→JA 受信・JA→EN 送信・ゲイン・停止順序）は共通です。

## デバイス配線（Zoom アプリ）

```
Zoom スピーカー ──▶ BlackHole 16ch ──▶ 拡張 remoteCaptureInput ─┬─▶ 原音（20%）─┐
                                                                └─▶ OpenAI RX ──┴─▶ イヤホン
物理マイク ──▶ 拡張 ──▶ OpenAI TX ──▶ BlackHole 2ch ──▶ Zoom マイク
```

`validateRouting(settings, "device")` は以下を拒否します。

- `remoteCaptureInputId` 未設定（`MISSING_SETTINGS`）
- 会議音声入力 = 物理マイク（`ROUTING_CONFLICT`）
- 会議音声入力のラベル = 仮想マイク出力のラベル（例: 両方 `BlackHole 2ch`）（`ROUTING_CONFLICT`）

検証は setup の保存時と開始時（background と offscreen の両方）で行います。

## デバイス消失

`AudioRouter.checkDevices()` の優先順位: イヤホン → BlackHole 出力 → 会議音声入力（device モードのみ）→ 物理マイク。

- イヤホン消失: 全停止（ループ回避）
- 会議音声入力消失: 全停止（受信源がない）
- BlackHole 出力 / 物理マイク消失: 送信のみ停止（従来どおり）

## Zoom 側の推奨設定

- マイク: BlackHole 2ch
- スピーカー: ブラウザ版はイヤホン、アプリは BlackHole 16ch
- オーディオ > 「オリジナルサウンドを有効化」ON、背景雑音抑制「低」
- 「マイクの音量を自動調整」OFF（英訳音声のレベルを一定に保つ）

## 受入項目（Zoom 追加分）

| ID | 内容 | 期待 |
| --- | --- | --- |
| Z01 | Zoom ブラウザ版（`/wc/`）を前面にして開始 | 会議アプリ = Zoom（ブラウザ）、双方向 ON |
| Z02 | `https://zoom.us/j/...` を前面にして開始 | エラー「ブラウザ版ではありません」、Zoom アプリモードへの誘導 |
| Z03 | Zoom アプリで 16ch 未設定のまま device モードで開始 | `MISSING_SETTINGS`、setup 2b への誘導 |
| Z04 | setup で会議音声入力 = BlackHole 2ch を保存 | 保存拒否（`ROUTING_CONFLICT`、16ch を案内） |
| Z05 | Zoom アプリ（スピーカー = 16ch, マイク = 2ch）で開始 | 相手の英語が日本語でイヤホンへ、自分の日本語が英語で相手へ |
| Z06 | Z05 中に相手側で日本語原音が聞こえないこと | 原音は届かず英訳のみ |
| Z07 | Z05 中に BlackHole 16ch を取り外す（Audio MIDI 設定で削除） | 全停止、メッセージに「会議音声入力が消失」 |
| Z08 | Z05 中にイヤホンを外す | 全停止（ループ回避） |
| Z09 | Zoom ブラウザ版のタブを閉じる | 自動停止（`TAB_CLOSED`） |
| Z10 | Zoom アプリ会議終了後に放置 | 無活動 10 分で自動停止 |
| Z11 | Meet タブと Zoom アプリの両方を用意し、接続先を切り替えて連続起動 | 各回で正しい会議アプリ表示、前回の停止後に開始できる |
| Z12 | Zoom で雑音抑制「自動」のまま英訳を送る | 語尾欠落があれば「低」+ オリジナルサウンドで解消することを確認 |
