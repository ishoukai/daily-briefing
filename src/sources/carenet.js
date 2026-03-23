/**
 * CareNet — 日本語医療ニュースサイトからスクレイピング
 */

const https = require('https');

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'DailyBriefingBot/1.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // CareNetはUTF-8だがエンコーディングを確認
        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('Shift_JIS') || contentType.includes('shift_jis')) {
          try {
            const { TextDecoder } = require('util');
            const decoder = new TextDecoder('shift_jis');
            resolve(decoder.decode(buf));
          } catch (e) {
            resolve(buf.toString('utf8'));
          }
        } else if (contentType.includes('EUC-JP') || contentType.includes('euc-jp')) {
          try {
            const { TextDecoder } = require('util');
            const decoder = new TextDecoder('euc-jp');
            resolve(decoder.decode(buf));
          } catch (e) {
            resolve(buf.toString('utf8'));
          }
        } else {
          resolve(buf.toString('utf8'));
        }
      });
    }).on('error', reject);
  });
}

function parseArticles(html, maxItems) {
  const items = [];

  // CareNetニュースアーカイブページの記事リンクを抽出
  // 一般的なパターン: <a href="/news/..." >タイトル</a> と日付
  const articlePattern = /<a\s+[^>]*href="(\/news\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const datePattern = /(\d{4}[\/.]\d{1,2}[\/.]\d{1,2})/;

  const lines = html.split('\n');
  const seen = new Set();

  for (let i = 0; i < lines.length && items.length < maxItems; i++) {
    const line = lines[i];
    let match;
    articlePattern.lastIndex = 0;

    while ((match = articlePattern.exec(line)) !== null && items.length < maxItems) {
      const path = match[1];
      const rawTitle = match[2].replace(/<[^>]+>/g, '').trim();

      if (!rawTitle || rawTitle.length < 5) continue;
      if (seen.has(path)) continue;
      seen.add(path);

      // 近接行から日付を探す
      let date = '';
      for (let j = Math.max(0, i - 5); j <= Math.min(lines.length - 1, i + 5); j++) {
        const dateMatch = lines[j].match(datePattern);
        if (dateMatch) {
          date = dateMatch[1].replace(/\//g, '-');
          break;
        }
      }

      items.push({
        title: rawTitle,
        url: `https://www.carenet.com${path}`,
        date,
        source: 'CareNet',
        category: 'medical_news',
      });
    }
  }

  return items;
}

async function collectAll(config) {
  const { url, max_items } = config.carenet;
  const maxItems = max_items || 10;

  console.log('\n[CareNet] ニュースページを取得中...');

  try {
    const html = await fetchHTML(url);
    const items = parseArticles(html, maxItems);
    console.log(`  ${items.length} 件の記事を取得`);
    return items;
  } catch (e) {
    console.error(`  Error: ${e.message}`);
    return [];
  }
}

module.exports = { collectAll };
