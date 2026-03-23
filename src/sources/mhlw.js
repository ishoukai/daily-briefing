/**
 * 厚生労働省 医療分野トピックスの新着情報を取得
 */

const https = require('https');

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'DailyBriefingBot/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseTopics(html, keywords) {
  const items = [];
  
  // 厚労省のトピックスページからリンクとテキストを抽出
  // パターン: <a href="...">テキスト</a> の前後に日付がある
  const linkPattern = /<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  const datePattern = /(\d{4})年(\d{1,2})月(\d{1,2})日/;
  
  let match;
  const lines = html.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    while ((match = linkPattern.exec(line)) !== null) {
      const url = match[1];
      const text = match[2].trim();
      
      // キーワードフィルタリング
      const isRelevant = keywords.some(kw => text.includes(kw));
      if (!isRelevant) continue;
      
      // 近接行から日付を探す
      let date = '';
      for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
        const dateMatch = lines[j].match(datePattern);
        if (dateMatch) {
          date = `${dateMatch[1]}.${dateMatch[2].padStart(2, '0')}.${dateMatch[3].padStart(2, '0')}`;
          break;
        }
      }
      
      // 相対URLを絶対URLに変換
      const fullUrl = url.startsWith('http') ? url : `https://www.mhlw.go.jp${url}`;
      
      items.push({
        title: text,
        url: fullUrl,
        date,
        source: '厚生労働省',
        category: 'regulation',
      });
    }
  }
  
  // 重複除去
  const seen = new Set();
  return items.filter(item => {
    const key = item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function collectAll(config) {
  console.log('\n[厚労省] 医療分野トピックスを取得中...');
  
  try {
    const html = await fetchHTML(config.mhlw.url);
    const items = parseTopics(html, config.mhlw.keywords);
    console.log(`  ${items.length} 件の関連トピックスを検出`);
    return items;
  } catch (e) {
    console.error(`  Error: ${e.message}`);
    return [];
  }
}

module.exports = { collectAll };
