/**
 * Claude API を使って記事を要約し、優先度を判定する
 *
 * 注意: ANTHROPIC_API_KEY 環境変数が必要です
 * export ANTHROPIC_API_KEY="sk-ant-..."
 */

const https = require('https');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function callClaude(messages, systemPrompt, model = 'claude-sonnet-4-20250514', timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      reject(new Error('ANTHROPIC_API_KEY 環境変数が設定されていません。'));
      return;
    }

    const body = JSON.stringify({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages,
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      reject(new Error('API call timed out after ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);

    const req = https.request(options, (res) => {
      res.setEncoding('utf8');
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        if (timedOut) return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            // Return status code info for rate limit handling
            const err = new Error(`Claude API Error: ${parsed.error.message}`);
            err.statusCode = res.statusCode;
            reject(err);
          } else {
            const text = parsed.content?.map(c => c.text || '').join('') || '';
            resolve(text);
          }
        } catch (e) {
          reject(new Error(`Response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => {
      clearTimeout(timer);
      if (!timedOut) reject(e);
    });
    req.write(body);
    req.end();
  });
}

/**
 * 収集した記事群をClaudeに送り、要約・優先度判定・「管理くんメモ」を生成
 * options.deadlineMs: この時刻(Date.now())を過ぎたら残りバッチをスキップ
 */
async function summarizeArticles(articles, config, options = {}) {
  const systemPrompt = config.claude_api.system_prompt;
  const deadlineMs = options.deadlineMs || Infinity;

  // バッチ処理: 1回のAPI呼び出しで最大20記事を処理
  const batchSize = 20;
  const results = [];

  for (let i = 0; i < articles.length; i += batchSize) {
    // グローバルタイムアウトチェック
    if (Date.now() > deadlineMs) {
      console.log(`  タイムアウト: 残り${articles.length - i}件をスキップ（デフォルト優先度を割当）`);
      for (let j = i; j < articles.length; j++) {
        results.push({
          ...articles[j],
          priority: '参考',
          summary_ja: articles[j].abstract?.substring(0, 150) || articles[j].title,
          impact: '',
          memo: '',
        });
      }
      break;
    }

    const batch = articles.slice(i, i + batchSize);

    const articlesText = batch.map((a, idx) => {
      const rssNote = a._rssOnly ? '\n※ この記事はRSSの見出しと概要のみから判定しています。本文は含まれていないため、見出しから推測できる範囲で評価してください。' : '';
      return `--- 記事 ${idx + 1} ---
タイトル: ${a.title}
ソース: ${a.source || a.journal || 'Unknown'}
URL: ${a.url || ''}
内容: ${(a.abstract || a.body || a.description || a.title).substring(0, 800)}${rssNote}
`;
    }).join('\n');

    const userMessage = `以下の ${batch.length} 件の記事を評価してください。

各記事について以下をJSON配列で返してください：
- index: 記事番号（0始まり）
- priority: "要対応" | "要注視" | "参考" | "除外"
- summary_ja: 日本語での要約（2-3文、150字以内）
- impact: 理事長として取るべきアクション（1文、80字以内）。"参考"の場合は空文字可。
- memo: 管理くんメモ（クリニック経営との接点、2文以内）

JSONのみを返してください。マークダウンのコードブロックは不要です。

${articlesText}`;

    const batchLabel = `batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(articles.length / batchSize)}`;

    let success = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) console.log(`  Retrying ${batchLabel}...`);
        else console.log(`  Summarizing ${batchLabel} (${batch.length} articles)...`);

        const response = await callClaude(
          [{ role: 'user', content: userMessage }],
          systemPrompt,
          config.claude_api.model,
          120000
        );

        // Parse JSON response
        const cleaned = response.replace(/```json\n?|```/g, '').trim();
        const parsed = JSON.parse(cleaned);

        // Merge results back with original articles
        for (const item of parsed) {
          const original = batch[item.index];
          if (original) {
            results.push({
              ...original,
              priority: item.priority,
              summary_ja: item.summary_ja,
              impact: item.impact,
              memo: item.memo,
            });
          }
        }
        success = true;
        break;
      } catch (e) {
        if (e.statusCode === 429 && attempt === 0) {
          console.log(`  Rate limited. Waiting 30s before retry...`);
          await sleep(30000);
          continue;
        }
        console.error(`  ${batchLabel} error: ${e.message}`);
        break;
      }
    }

    if (!success) {
      // Fallback: add articles with default priorities
      for (const article of batch) {
        results.push({
          ...article,
          priority: '参考',
          summary_ja: article.abstract?.substring(0, 150) || article.title,
          impact: '',
          memo: '',
        });
      }
    }

    // Wait between API calls to avoid rate limits
    if (i + batchSize < articles.length) {
      await sleep(2000);
    }
  }

  return results;
}

module.exports = { summarizeArticles, callClaude };
