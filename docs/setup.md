# セットアップ手順

対象: macOS + Google Chrome 116+（Meet / Zoom ブラウザ版）、Zoom デスクトップアプリを使う場合は Sokuji デスクトップアプリ。

## 1. OpenAI API キー

1. [platform.openai.com](https://platform.openai.com/) でプロジェクトを作り、API キーを発行
2. **Settings → Limits** で月額上限（例: $20）を設定。Realtime 音声は分課金なので上限は必ず入れる
3. キーは Sokuji の設定画面にだけ入力する。このリポジトリや `.env` には書かない

参考: 上流の [OpenAI セットアップ](https://kizuna-ai-lab.github.io/sokuji/tutorials/openai-setup.html)（日本語切替あり）。

## 2. 拡張のビルドと読み込み

```bash
npm run setup
npm run build:extension
```

`chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」→ `dist/extension`。

zip（`dist/sokuji-extension-0.41.0.zip`）は別の Mac へ持ち運ぶ用です。展開して同じ手順で読み込みます。

## 3. 初回セットアップ（ウィザード）

Meet または Zoom のタブで拡張アイコン → **Open Sokuji**（サイドパネルが開く）。初回はウィザードが出ます。

| 質問 | 選ぶもの |
| --- | --- |
| 何をしたい？ | **オンラインで双方向に会話**（相手は翻訳音声を聞き、自分は相手の字幕を読む） |
| 何を持っている？ | **自分の API キーがある** → **OpenAI** → キーを貼り付けて検証 |
| 言語 | 自分の言語 = **日本語**、相手の言語 = **英語** |

Finish で以下が設定されます: モード = **両方**、音声＋字幕。

推奨の追加設定（Settings）:

- モデル: まず `gpt-realtime-mini`（安い・速い）。品質が足りなければ `gpt-realtime-1.5`
- Turn detection: **Semantic**（文の切れ目で翻訳）
- Noise reduction: ON（near field）
- 音声: 好みの英語ボイス
- 「オリジナル音声パススルー」: OFF（相手には英訳だけ届く）。自分の声も低音量で混ぜたいときだけ ON

## 4. 会議アプリ別の設定

### Google Meet

1. Meet に参加 → 設定 → 音声 → マイク = **Sokuji Virtual Microphone**、スピーカー = イヤホン
2. Meet 側のノイズキャンセルは OFF（合成音声を雑音として消すことがある）
3. Sokuji で Start。「相手」側が ON なら Meet タブの音声がキャプチャされ、字幕が出る

### Zoom ブラウザ版（`app.zoom.us`）

1. 招待リンクを Chrome で開く → デスクトップアプリ起動のダイアログは **キャンセル** → **ブラウザから参加**
2. Zoom の音声設定 → マイク = **Sokuji Virtual Microphone**、スピーカー = イヤホン
3. 背景雑音抑制 = 「ブラウザ内蔵」または「低」
4. Sokuji で Start

注意: Sokuji 拡張は `app.zoom.us` だけを対象にしています。組織 URL（`xxx.zoom.us/j/...`）から入っても、ブラウザ参加を選ぶと `app.zoom.us/wc/...` に遷移するので通常は問題ありません。

### Zoom デスクトップアプリ（Sokuji デスクトップアプリ）

拡張はネイティブアプリに仮想マイクを注入できないため、デスクトップアプリを使います。

1. [Sokuji v0.41.0 リリース](https://github.com/kizuna-ai-lab/sokuji/releases/tag/v0.41.0) から `Sokuji-0.41.0-arm64.pkg`（Apple Silicon）または `-x64.pkg` を入れる。インストーラが **Sokuji Virtual Audio** ドライバを `/Library/Audio/Plug-Ins/HAL` に入れる
2. 初回起動でウィザード（内容は拡張と同じ）
3. Zoom の設定 → オーディオ: マイク = **Sokuji Virtual Microphone**、スピーカー = イヤホン
4. Zoom の「オリジナルサウンド」ON、背景雑音抑制 = 低、マイク音量自動調整 OFF
5. 「相手」側を ON にすると **画面収録の許可** を求められる（macOS のシステム音声取り込みの仕様）。システム設定 → プライバシーとセキュリティ → 画面収録 で Sokuji を許可
6. Sokuji で Start

固定した版から自分でビルドしたい場合（macOS のみ・未署名）:

```bash
npm run setup:desktop
npm run build:desktop     # dist/Sokuji-0.41.0-<arch>.pkg
```

## 5. 使い方（毎回）

1. 会議に入り、マイクが Sokuji Virtual Microphone になっているか確認
2. Sokuji のサイドパネル（またはアプリ）で **Start**
3. 日本語で話す → 相手には英語の合成音声。相手の英語 → サイドパネルに日本語字幕（原文/訳文の表示は切替可）
4. 字幕を大きく見たい場合は字幕オーバーレイ（Settings → Subtitle）
5. 終了時は **Stop**

## 6. トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| マイク一覧に Sokuji Virtual Microphone が出ない | 会議ページを再読み込み。拡張にマイク権限があるか確認（`permission.html` が開く） |
| 相手に日本語の生声が届く | 会議アプリのマイクが物理マイクのまま。Sokuji Virtual Microphone に変更 |
| 相手の字幕が出ない | モードが「自分」になっている → 「両方」に。Zoom アプリでは画面収録の許可 |
| 英訳の語尾が欠ける | 会議アプリのノイズ抑制を弱める／OFF |
| 401 / キー無効 | OpenAI キーを再検証。プロジェクトに Realtime の権限があるか |
| 費用が想定より高い | `gpt-realtime-mini` に変更、OpenAI 側の月額上限を確認 |
