/**
 * Financial Times — RSSフィードから記事を取得（複数フィード統合・キーワードフィルタ）
 */

const https = require('https');

function fetchRSS(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'DailyBriefingBot/1.0' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRSS(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"');
}

function parseRSSItems(xml) {
  const items = [];
  const itemPattern = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1];

    const title = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                   block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>/) ||
                  block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const description = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                         block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';

    if (!title.trim()) continue;

    let date = '';
    if (pubDate) {
      try {
        date = new Date(pubDate.trim()).toISOString().split('T')[0];
      } catch (e) {
        date = pubDate.trim();
      }
    }

    items.push({
      title: decodeEntities(title.trim()),
      url: link.trim(),
      date,
      description: decodeEntities(description.trim()).replace(/<[^>]+>/g, '').substring(0, 300),
      source: 'FT',
      category: 'news',
    });
  }

  return items;
}

function matchesKeywords(article, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const text = `${article.title} ${article.description}`.toLowerCase();
  return keywords.some(kw => text.includes(kw.toLowerCase()));
}

async function collectAll(config) {
  const settings = config.ft;
  if (!settings) {
    console.log('\n[FT] 設定がありません。スキップします。');
    return [];
  }

  const feeds = settings.feeds || [];
  const maxItems = settings.max_items || 15;
  const keywords = settings.keywords || [];

  console.log(`\n[FT] ${feeds.length} フィードから取得中...`);

  const allItems = [];
  const seenUrls = new Set();

  for (const feedUrl of feeds) {
    try {
      const xml = await fetchRSS(feedUrl);
      const items = parseRSSItems(xml);
      for (const item of items) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          allItems.push(item);
        }
      }
    } catch (e) {
      console.error(`  [FT] フィード取得エラー (${feedUrl}): ${e.message}`);
    }
  }

  // キーワードフィルタリング
  const filtered = keywords.length > 0
    ? allItems.filter(item => matchesKeywords(item, keywords))
    : allItems;

  const result = filtered.slice(0, maxItems);
  console.log(`  ${allItems.length} 件取得 → キーワードフィルタ後 ${filtered.length} 件 → ${result.length} 件を採用`);
  return result;
}

module.exports = { collectAll };
