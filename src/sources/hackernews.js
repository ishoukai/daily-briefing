/**
 * Hacker News API — 医療AI・ヘルスケア関連記事をフィルタリング
 */

const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function collectAll(config) {
  const { api_url, keywords, min_score, max_items } = config.hackernews;
  
  console.log('\n[HackerNews] Top stories を取得中...');
  
  try {
    // Get top story IDs
    const topIds = await fetchJSON(`${api_url}/topstories.json`);
    const checkIds = topIds.slice(0, max_items || 30);
    
    const relevantItems = [];
    
    for (const id of checkIds) {
      try {
        const item = await fetchJSON(`${api_url}/item/${id}.json`);
        if (!item || item.type !== 'story') continue;
        
        const text = `${item.title || ''} ${item.url || ''}`.toLowerCase();
        const score = item.score || 0;
        
        // キーワードマッチ + スコアフィルタ
        const matchedKeyword = keywords.find(kw => text.includes(kw.toLowerCase()));
        if (matchedKeyword && score >= (min_score || 50)) {
          relevantItems.push({
            title: item.title,
            url: item.url || `https://news.ycombinator.com/item?id=${id}`,
            hn_url: `https://news.ycombinator.com/item?id=${id}`,
            score,
            comments: item.descendants || 0,
            date: new Date(item.time * 1000).toISOString().split('T')[0],
            source: 'Hacker News',
            category: 'tech',
            matched_keyword: matchedKeyword,
          });
        }
        
        // Rate limit
        await sleep(100);
      } catch (e) {
        // Skip individual item errors
      }
    }
    
    // Sort by score
    relevantItems.sort((a, b) => b.score - a.score);
    
    console.log(`  ${relevantItems.length} 件の関連記事を検出（${checkIds.length} 件中）`);
    return relevantItems;
    
  } catch (e) {
    console.error(`  Error: ${e.message}`);
    return [];
  }
}

module.exports = { collectAll };
