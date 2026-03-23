/**
 * Medical Tribune — 医療ニュースサイトからRSSフィードで取得
 *
 * Medical Tribuneのメインサイトは動的レンダリングのため、
 * RSSフィードからの取得をメインとし、HTMLフォールバックも試みる。
 */

const https = require('https');

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://medical-tribune.co.jp${res.headers.location}`;
        return fetchURL(redirectUrl).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function parseRSS(xml, maxItems) {
  const items = [];
  const itemPattern = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemPattern.exec(xml)) !== null && items.length < maxItems) {
    const block = match[1];
    const title = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                   block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>/) ||
                  block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) ||
                     block.match(/<dc:date>([\s\S]*?)<\/dc:date>/) || [])[1] || '';

    if (!title.trim()) continue;

    let date = '';
    if (pubDate) {
      try { date = new Date(pubDate.trim()).toISOString().split('T')[0]; }
      catch (e) { date = pubDate.trim(); }
    }

    items.push({
      title: title.trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
      url: link.trim(),
      date,
      source: 'Medical Tribune',
      category: 'medical_news',
    });
  }

  return items;
}

function parseHTML(html, maxItems) {
  const items = [];
  const seen = new Set();

  // 記事リンクパターン: href with date-like path segments
  const linkPattern = /<a[^>]+href="((?:https?:\/\/medical-tribune\.co\.jp)?\/\d{4}\/\d{2}\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null && items.length < maxItems) {
    let url = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    if (!title || title.length < 8) continue;
    if (/一覧|ログイン|トップ/.test(title)) continue;
    if (!url.startsWith('http')) url = `https://medical-tribune.co.jp${url}`;
    if (seen.has(url)) continue;
    seen.add(url);

    items.push({
      title,
      url,
      date: new Date().toISOString().split('T')[0],
      source: 'Medical Tribune',
      category: 'medical_news',
    });
  }

  return items;
}

async function collectAll(config) {
  const settings = config.medical_tribune || {};
  const rssUrl = settings.rss_url || 'https://medical-tribune.co.jp/rss/';
  const pageUrl = settings.url || 'https://medical-tribune.co.jp/';
  const maxItems = settings.max_items || 10;

  console.log('\n[Medical Tribune] ニュースを取得中...');

  let items = [];

  // Try RSS first
  try {
    const xml = await fetchURL(rssUrl);
    if (xml.includes('<item')) {
      items = parseRSS(xml, maxItems);
    }
  } catch (e) {
    // RSS failed, try HTML
  }

  // Fallback to HTML if RSS didn't work
  if (items.length === 0) {
    try {
      const html = await fetchURL(pageUrl);
      items = parseHTML(html, maxItems);
    } catch (e) {
      // Both failed
    }
  }

  console.log(`  ${items.length} 件の記事を取得`);
  if (items.length === 0) {
    console.log('  (Medical Tribuneは動的レンダリングのため取得が制限される場合があります)');
  }
  return items;
}

module.exports = { collectAll };
