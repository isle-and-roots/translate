# translate — Meet / Zoom 英日双方向通訳（Sokuji ベース）

Google Meet / Zoom で使う英日双方向のリアルタイム通訳環境です。翻訳エンジン・仮想マイク・会議音声の取り込みは [Sokuji](https://github.com/kizuna-ai-lab/sokuji)（Kizuna AI Lab, AGPL-3.0）をそのまま使い、このリポジトリは **版を固定して同じ配布物を再現ビルドし、運用手順をまとめる** ラッパーです。

以前の自作実装（Chrome 拡張 + Cloudflare Worker + BlackHole 手動配線）は Sokuji に置き換えました。経緯と差分は [docs/decision.md](docs/decision.md) を参照してください。

## 構成

| 会議アプリ | 使うもの | 自分の声（JA→EN） | 相手の声（EN→JA） |
| --- | --- | --- | --- |
| Google Meet（Chrome） | Sokuji 拡張 | 「Sokuji Virtual Microphone」を Meet のマイクに選ぶだけ | タブ音声を取り込み、日本語字幕で表示 |
| Zoom ブラウザ版（`app.zoom.us`） | Sokuji 拡張 | 同上 | 同上 |
| Zoom デスクトップアプリ | Sokuji デスクトップアプリ（macOS） | インストーラが仮想マイクドライバを入れる | システム音声を取り込み、日本語字幕で表示 |

- 翻訳は OpenAI Realtime（`gpt-realtime-mini` / `gpt-realtime-1.5`）に **端末から直接** 接続します。API キーは端末内にのみ保存され、中継サーバ（旧 Cloudflare Worker）は不要です。
- 相手の発話は **字幕（テキスト）** として届きます。旧実装のように日本語の合成音声をイヤホンへ流す機能は Sokuji にはありません（[docs/decision.md](docs/decision.md#相手音声の扱い)）。
- BlackHole の手動配線は不要です。

## クイックスタート

```bash
git clone --recurse-submodules https://github.com/isle-and-roots/translate.git
cd translate
npm run setup             # Sokuji v0.41.0 を取得し依存をインストール（Electron は入れない）
npm run build:extension   # dist/extension（unpacked）と dist/sokuji-extension-0.41.0.zip
```

1. `chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」→ `dist/extension`
2. Meet / Zoom のタブで拡張アイコン → 「Open Sokuji」→ 初回セットアップで **「オンラインで双方向に会話」／自分の API キーがある／OpenAI／自分の言語=日本語・相手の言語=英語**
3. 会議アプリのマイクを **Sokuji Virtual Microphone** にして Start

詳細は [docs/setup.md](docs/setup.md)、本番稼働までの手順は [docs/release.md](docs/release.md)。

Zoom デスクトップアプリを使う場合は Sokuji のデスクトップアプリ（[公式リリース](https://github.com/kizuna-ai-lab/sokuji/releases/tag/v0.41.0) の `Sokuji-0.41.0-arm64.pkg` / `-x64.pkg`）を入れます。固定した版のソースから自分でビルドしたい場合は macOS 上で `npm run setup:desktop && npm run build:desktop`。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run setup` | サブモジュール取得 + 拡張ビルドに必要な依存のインストール |
| `npm run setup:desktop` | 上記 + Electron / ネイティブ再ビルド（macOS でデスクトップをビルドする場合） |
| `npm run build:extension` | 拡張を production モードでビルドし `dist/` に unpacked と zip を出力。analytics OFF・Kizuna 管理プロバイダ OFF を明示 |
| `npm run build:desktop` | macOS 用 pkg を未署名でビルド（macOS のみ） |
| `npm run check` | pin の整合（`package.json` の `sokujiVersion` と `sokuji/` の版）を検査。`--built` で成果物も検査 |
| `npm run clean` | `dist/` を削除 |

CI（GitHub Actions）は PR ごとに `setup` → `build:extension` を実行し、zip をアーティファクトとして残します。

## Sokuji の版を上げる

[docs/upgrade.md](docs/upgrade.md) を参照。`sokuji/` のコミットと `package.json` の `sokujiVersion` を同じコミットで更新します。

## ライセンス

`sokuji/` は Kizuna AI Lab の著作物で [AGPL-3.0](https://github.com/kizuna-ai-lab/sokuji/blob/main/LICENSE) です。自分の端末で使う限り追加の義務はありません。ビルドした拡張やアプリを **第三者に配布する／ネットワーク越しに提供する** 場合は AGPL-3.0 に従い、改変を含むソース一式を提供する必要があります。このリポジトリのラッパー部分（`scripts/`, `docs/`, CI）は Sokuji を改変していません。
