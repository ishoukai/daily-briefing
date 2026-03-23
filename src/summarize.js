/**
 * Claude API を使って記事を要約し、優先度を判定する
 * 
 * 注意: ANTHROPIC_API_KEY 環境変数が必要です
 * export ANTHROPIC_API_KEY="sk-ant-..."
 */

const https = require('https');

function callClaude(messages, systemPrompt, model = 'claude-sonnet-4-20250514') {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      reject(new Error('ANTHROPIC_API_KEY 環境変数が設定されていません。\nexport ANTHROPIC_API_KEY="sk-ant-..." を実行してください。'));
      return;
    }

    const body = JSON.stringify({
      model,
      max_tokens: 4096,
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

    const req = https.request(options, (res) => {
      res.setEncoding('utf8');
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Claude API Error: ${parsed.error.message}`));
          } else {
            const text = parsed.content?.map(c => c.text || '').join('') || '';
            resolve(text);
          }
        } catch (e) {
          reject(new Error(`Response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 収集した記事群をClaudeに送り、要約・優先度判定・「理事長メモ」を生成
 */
async function summarizeArticles(articles, config) {
  const systemPrompt = config.claude_api.system_prompt;
  
  // バッチ処理: 1回のAPI呼び出しで最大10記事を処理
  const batchSize = 10;
  const results = [];
  
  for (let i = 0; i < articles.length; i += batchSize) {
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
- memo: 理事長メモ（クリニック経営との接点、2文以内）

JSONのみを返してください。マークダウンのコードブロックは不要です。

${articlesText}`;

    try {
      console.log(`  Summarizing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(articles.length / batchSize)}...`);
      
      const response = await callClaude(
        [{ role: 'user', content: userMessage }],
        systemPrompt,
        config.claude_api.model
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
    } catch (e) {
      console.error(`  Summarization error: ${e.message}`);
      // Fallback: add articles without summary
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
  }
  
  return results;
}

module.exports = { summarizeArticles, callClaude };
