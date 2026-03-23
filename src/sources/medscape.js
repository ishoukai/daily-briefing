/**
 * Medscape — 総合医療ニュースRSSフィードから記事を取得
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

function parseRSSItems(xml, maxItems) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemPattern.exec(xml)) !== null && items.length < maxItems) {
    const block = match[1];

    const title = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                   block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>/) ||
                  block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
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
      title: title.trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#039;/g, "'").replace(/&quot;/g, '"'),
      url: link.trim(),
      date,
      source: 'Medscape',
      category: 'medical_news',
    });
  }

  return items;
}

async function collectAll(config) {
  const { url, max_items } = config.medscape;
  const maxItems = max_items || 10;

  console.log('\n[Medscape] RSSフィードを取得中...');

  try {
    const xml = await fetchRSS(url);
    const items = parseRSSItems(xml, maxItems);
    console.log(`  ${items.length} 件の記事を取得`);
    return items;
  } catch (e) {
    console.error(`  Error: ${e.message}`);
    return [];
  }
}

module.exports = { collectAll };
