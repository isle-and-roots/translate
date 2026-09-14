# Sokuji の版を上げる

`sokuji/` はサブモジュールで、コミット（= リリースタグ）に固定しています。`package.json` の `sokujiVersion` が同じ版を指していないと `npm run check` と各ビルドが失敗します。

```bash
# 1. 新しいタグを確認
git -C sokuji fetch --depth 1 origin tag v0.42.0
git -C sokuji checkout v0.42.0

# 2. pin を更新
npm pkg set sokujiVersion=0.42.0

# 3. 再現ビルドと検査
npm run setup
npm run build:extension        # 内部で check --built も走る

# 4. 1 コミットで両方をコミット
git add sokuji package.json
git commit -m "chore: bump sokuji to v0.42.0"
```

上流の [CHANGELOG](https://github.com/kizuna-ai-lab/sokuji/blob/main/CHANGELOG.md) で以下を確認してから上げます。

- Zoom / Meet のコンテンツスクリプトに変更があるか（`extension/platforms.ts`）
- OpenAI プロバイダのモデル既定値が変わるか（設定の移行が走る）
- 拡張の `manifest.json` の権限追加（読み込み直しで再許可が必要）

デスクトップアプリを使っている場合は同じ版の pkg を入れ直します（拡張とアプリの版は揃えておく）。
