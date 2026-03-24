# 管理くんニュース

医療法人理事長（内科[一般・糖尿病・循環器]、耳鼻咽喉科、小児科、消化器内科/外科を経営）のための日次インテリジェンスブリーフィング。

## コマンド

### 「ブリーフィング」「briefing」「今日のブリーフィング」
以下を順に実行：

1. node src/collect.js --no-summary を実行してデータ収集（PubMed 8カテゴリ、厚労省、HackerNews）
2. output/raw_data.json を読み込む
3. 全記事を評価して以下を生成：
   - summary_ja: 日本語要約（2-3文、150字以内）
   - priority: "要対応" | "要注視" | "参考"
   - impact: 理事長として取るべきアクション（1文、80字以内。"参考"は空文字可）
   - memo: 理事長メモ（クリニック経営との接点を1-2文で）
4. 優先度の基準：
   - 要対応: 直接的な経営判断・制度対応が必要（診療報酬改定、算定要件変更、開業規制、届出期限等）
   - 要注視: 中期的に経営や診療に影響する可能性（新薬承認、ガイドライン変更、テック動向、海外制度変更等）
   - 参考: 知っておくべきだが即座の対応不要（基礎研究、統計報告、海外ニュース等）
5. 結果を output/enriched_data.json として保存（構造は raw_data.json と同じだが各articleに summary_ja, priority, impact, memo フィールドが追加される）
6. node src/render.js output/enriched_data.json を実行してHTMLを生成
7. open で生成されたHTMLをブラウザで開く

### 「週次ブリーフィング」「weekly briefing」
上記に加えて collect.js に --weekly フラグを付けてarXivも収集する。

### 重要な注意
- PubMedの論文は英語だが、要約は必ず日本語で書く
- 優先度判定は「日本の医療法人理事長」の視点で行う。米国の制度変更は直接影響がないため基本「参考」だが、日本への波及が予想される場合は「要注視」
- 論文の理事長メモでは、必ず経営する診療科（内科・耳鼻咽喉科・小児科・消化器）との接点を明記する
- 1回の実行で処理する記事は最大50件程度。それを超える場合は重要度の高いものを優先

### 「サーバー起動」
npm run server を実行（localhost:3000でWebサーバー起動）

### 「自動ブリーフィング」
npm run auto を実行（データ収集 → Claude API要約 → enriched_data保存 → HTML生成を一括実行）

## ファイル構成
- src/collect.js: データ収集（PubMed, 厚労省, HN, arXiv）
- src/sources/: 各ソースのモジュール
- src/server.js: Express Webサーバー（ポート3000）
- src/auto-briefing.js: 自動ブリーフィング（収集→要約→HTML生成）
- src/render.js: HTML生成
- config/settings.json: PubMedクエリ等の設定
- templates/briefing.html: HTMLテンプレート
- output/raw_data.json: 収集生データ
- output/enriched_data.json: 要約済みデータ
- output/briefing_YYYY-MM-DD.html: 最終出力
