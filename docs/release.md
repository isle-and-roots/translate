# 本番稼働手順（Runbook）

CI が毎回検証するのは「固定した Sokuji の版から拡張が再現ビルドできること」までです。以下は本人環境で行います。

## 0. 前提

- macOS + Chrome 116+
- OpenAI API キー（Realtime が使えるプロジェクト、月額上限を設定済み）
- Zoom デスクトップアプリを使う場合: 管理者権限（仮想オーディオドライバのインストール）

## 1. 配布物を確定する

```bash
npm run setup
npm run build:extension        # dist/sokuji-extension-0.41.0.zip
npm run check -- --built
```

zip を保管します（別 Mac への展開、ロールバック用）。CI のアーティファクト `sokuji-extension` も同一内容です。

## 2. 拡張を入れる

`chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」→ `dist/extension`。

Chrome Web Store 版（`ppmihnhelgfpjomhjhpecobloelicnak`）でも機能は同じですが、自動更新で版が動くため、本番では **このリポジトリで固定した版を unpacked で入れる** ことを推奨します。

## 3. 初回設定

[docs/setup.md](setup.md) の 3 章どおり: 双方向 / 自分の API キー / OpenAI / 日本語↔英語。

## 4. Zoom デスクトップアプリ（必要な場合）

`Sokuji-0.41.0-<arch>.pkg` をインストール → 初回設定 → 画面収録の許可。

## 5. 受入試験（テスト会議で）

2 台（または 2 アカウント）で会議を開き、相手役の耳・目で確認します。

| ID | 内容 | 期待 |
| --- | --- | --- |
| A01 | Meet: マイク = Sokuji Virtual Microphone で日本語を話す | 相手には英語の合成音声だけが届く（日本語の生声は聞こえない） |
| A02 | Meet: 相手が英語を話す | サイドパネルに日本語字幕が 1〜3 秒以内に出る |
| A03 | Meet: Stop | 相手側の音声が止まる。自分のマイクは Sokuji Virtual Microphone のまま無音 |
| A04 | Zoom ブラウザ版: A01〜A03 | 同じ |
| A05 | Zoom アプリ: A01〜A03 | 同じ。字幕は画面収録の許可後に出る |
| A06 | Meet/Zoom のノイズ抑制 ON のまま長文を話す | 語尾欠けがあれば OFF/低 にして解消することを確認 |
| A07 | 30 分連続で使う | 切断・再接続なしで継続。OpenAI の利用量ダッシュボードで金額を確認 |
| A08 | OpenAI キーを一時的に無効化 | 明確なエラー表示。会議アプリ側に生声が漏れない |
| A09 | イヤホンを外す | エコーによるループが起きないこと（起きる場合はイヤホン必須を運用ルール化） |
| A10 | 拡張を無効化 → 会議アプリのマイク一覧 | Sokuji Virtual Microphone が消え、物理マイクに戻る |

## 6. 運用

- **費用**: OpenAI の月額上限を必ず設定。Realtime は音声の分課金で、両方向を有効にすると入出力の両方に課金される
- **キー漏えい時**: OpenAI 側で失効 → Sokuji の設定で新しいキーに差し替え
- **版の固定**: 拡張は unpacked のため自動更新しない。上げるときは [upgrade.md](upgrade.md)
- **ログ**: Sokuji は analytics を無効にしてビルドしている（`npm run check -- --built` で PostHog キー不在を検査）。会話内容はエクスポートしない限り端末外に残らない（OpenAI への送信は除く）

## ロールバック

- 拡張: 直前の zip を展開して読み込み直す（`chrome://extensions` → 削除 → 読み込み）
- デスクトップ: 直前の pkg を再インストール
- サブモジュール: `git checkout <前のコミット> -- sokuji package.json && git submodule update`
