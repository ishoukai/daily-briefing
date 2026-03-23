/**
 * m3.com — 医療ニュースサイトからヘッドライン取得
 *
 * 注意: m3.comはログイン必須のため、公開ページからの取得は制限あり。
 * open.m3.com（公開記事）をフォールバックとして使用。
 */

const https = require('https');

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
      }
    }, (res) => {
      // m3.com/news redirects to login — don't follow login redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (res.headers.location.includes('login')) {
          resolve('');
          return;
        }
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://www.m3.com${res.headers.location}`;
        return fetchHTML(redirectUrl).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function parseArticles(html, maxItems) {
  const items = [];
  const seen = new Set();

  // open.m3.com の記事リンクパターン
  const linkPattern = /<a[^>]+href="((?:https?:\/\/[^"]*m3\.com)?\/(?:news|open\/[^"]+)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null && items.length < maxItems) {
    let url = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    if (!title || title.length < 8) continue;
    // Skip navigation links
    if (/一覧|ログイン|新規登録|トップ/.test(title)) continue;
    if (!url.startsWith('http')) url = `https://www.m3.com${url}`;
    if (seen.has(url)) continue;
    seen.add(url);

    items.push({
      title,
      url,
      date: new Date().toISOString().split('T')[0],
      source: 'm3.com',
      category: 'medical_news',
    });
  }

  return items;
}

async function collectAll(config) {
  const settings = config.m3 || {};
  const urls = settings.urls || [
    'https://www.m3.com/news',
    'https://open.m3.com/',
  ];
  const maxItems = settings.max_items || 10;

  console.log('\n[m3.com] ニュースページを取得中...');

  const allItems = [];
  const seenUrls = new Set();

  for (const url of urls) {
    try {
      const html = await fetchHTML(url);
      if (!html) continue;
      const items = parseArticles(html, maxItems);
      for (const item of items) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          allItems.push(item);
        }
      }
    } catch (e) {
      // Silently skip failed URLs
    }
  }

  const result = allItems.slice(0, maxItems);
  console.log(`  ${result.length} 件の記事を取得`);
  if (result.length === 0) {
    console.log('  (m3.comはログイン必須のため、公開記事のみ取得可能です)');
  }
  return result;
}

module.exports = { collectAll };
