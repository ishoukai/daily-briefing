/**
 * 日経新聞 — RSSフィード＋カテゴリページから記事を取得
 */

const https = require('https');
const http = require('http');

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
  // RDF形式 (<item>) と RSS2.0形式 (<item>) の両方に対応
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
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) ||
                     block.match(/<dc:date>([\s\S]*?)<\/dc:date>/) || [])[1] || '';

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
      source: '日経',
      category: 'news',
    });
  }

  return items;
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.5',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://www.nikkei.com${res.headers.location}`;
        return fetchPage(redirectUrl).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function parseCategoryPage(html, maxItems = 20) {
  const articles = [];
  // 記事リンクパターン: /article/DGXZQO... or /article/DGXM... etc.
  const linkPattern = /<a[^>]+href="(\/article\/DGX[A-Z0-9]+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  const seenUrls = new Set();

  while ((match = linkPattern.exec(html)) !== null && articles.length < maxItems) {
    const path = match[1];
    const innerHtml = match[2];
    // タイトルテキストを抽出（HTMLタグを除去）
    const title = innerHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 5) continue;

    const url = `https://www.nikkei.com${path}`;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    articles.push({
      title: decodeEntities(title),
      url,
      date: new Date().toISOString().split('T')[0],
      description: '',
      source: '日経',
      category: 'news',
    });
  }

  return articles;
}

function matchesKeywords(article, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const text = `${article.title} ${article.description}`.toLowerCase();
  return keywords.some(kw => text.includes(kw.toLowerCase()));
}

async function collectAll(config) {
  const settings = config.nikkei;
  if (!settings) {
    console.log('\n[日経] 設定がありません。スキップします。');
    return [];
  }

  const feeds = settings.feeds || [];
  const maxItems = settings.max_items || 20;
  const keywords = settings.keywords || [];

  const categoryPages = settings.category_pages || [];

  console.log(`\n[日経] ${feeds.length} フィード + ${categoryPages.length} カテゴリページから取得中...`);

  const seenUrls = new Set();

  // 1. RSSフィードから取得 → キーワードフィルタ
  const rssItems = [];
  for (const feedUrl of feeds) {
    try {
      const xml = await fetchRSS(feedUrl);
      const items = parseRSSItems(xml);
      for (const item of items) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          rssItems.push(item);
        }
      }
    } catch (e) {
      console.error(`  [日経] フィード取得エラー (${feedUrl}): ${e.message}`);
    }
  }

  const filteredRss = keywords.length > 0
    ? rssItems.filter(item => matchesKeywords(item, keywords))
    : rssItems;

  console.log(`  RSS: ${rssItems.length} 件取得 → キーワードフィルタ後 ${filteredRss.length} 件`);

  // 2. カテゴリページから取得（フィルタ不要）
  const categoryItems = [];
  for (const pageUrl of categoryPages) {
    try {
      const html = await fetchPage(pageUrl);
      const items = parseCategoryPage(html, 20);
      for (const item of items) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          categoryItems.push(item);
        }
      }
      console.log(`  カテゴリ (${pageUrl}): ${items.length} 件取得, 新規 ${categoryItems.length} 件`);
    } catch (e) {
      console.error(`  [日経] カテゴリページ取得エラー (${pageUrl}): ${e.message}`);
    }
  }

  // 3. 統合 → max_items制限
  const allItems = [...filteredRss, ...categoryItems];
  const result = allItems.slice(0, maxItems);
  console.log(`  合計: ${allItems.length} 件 → ${result.length} 件を採用`);
  return result;
}

module.exports = { collectAll };
