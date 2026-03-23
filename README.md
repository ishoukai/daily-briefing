# ニュースまとめくん by 医承会 System

医療法人理事長のための日次インテリジェンスブリーフィング自動生成システム

## 概要

このシステムは以下のソースから情報を自動収集し、優先度付きのHTMLブリーフィングを生成します。

| ソース | 収集方法 | 更新頻度 |
|--------|----------|----------|
| PubMed | E-utilities API（自動） | 毎日 |
| 厚労省 医療トピックス | Webスクレイピング（自動） | 毎日 |
| Hacker News（医療AI関連） | API（自動） | 毎日 |
| arXiv（医療AI論文） | API（自動） | 週次 |
| 日経電子版 | Claude in Chrome（手動トリガー） | 毎日 |
| Financial Times | Claude in Chrome（手動トリガー） | 毎日 |

## セットアップ（Mac）

### 1. 前提条件

```bash
# Node.js（v18以上）がなければインストール
brew install node

# プロジェクトディレクトリへ移動
cd ~/daily-briefing

# 依存パッケージをインストール
npm install
```

### 2. 設定ファイル

`config/settings.json` を自分の環境に合わせて編集してください。
PubMedの検索クエリは診療科に最適化済みです。

### 3. 実行

```bash
# 手動実行（テスト用）
node src/collect.js

# 生成されたブリーフィングを確認
open output/briefing_$(date +%Y-%m-%d).html
```

### 4. 自動実行の設定（launchd）

```bash
# launchdの設定ファイルをコピー
cp config/com.briefing.daily.plist ~/Library/LaunchAgents/

# ロード
launchctl load ~/Library/LaunchAgents/com.briefing.daily.plist
```

毎朝6:00にスクリプトが自動実行されます。

### 5. Claude in Chrome との連携

日経・FTの巡回はClaude in Chromeで行います。
詳細は `docs/CHROME_SETUP.md` を参照してください。

## ディレクトリ構成

```
daily-briefing/
├── src/
│   ├── collect.js          # メインの収集スクリプト
│   ├── sources/
│   │   ├── pubmed.js       # PubMed E-utilities
│   │   ├── mhlw.js         # 厚労省スクレイピング
│   │   ├── hackernews.js   # Hacker News API
│   │   └── arxiv.js        # arXiv API
│   ├── summarize.js        # Claude APIで要約・優先度判定
│   └── render.js           # HTMLブリーフィング生成
├── config/
│   ├── settings.json       # 設定ファイル
│   └── com.briefing.daily.plist  # macOS自動実行設定
├── templates/
│   └── briefing.html       # HTMLテンプレート
├── output/                 # 生成されたブリーフィング
├── package.json
└── README.md
```

## 配信設定（後から追加可能）

配信先が決まったら、以下のいずれかを `src/deliver.js` に追加します：

- **Slack**: Incoming Webhook で HTML を Slack チャンネルに投稿
- **Gmail**: Nodemailer で HTML メールを送信
- **ローカル**: `open` コマンドでブラウザで直接開く（デフォルト）
