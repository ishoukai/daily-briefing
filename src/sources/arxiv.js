/**
 * arXiv API — 医療AI関連論文を取得
 */

const http = require('http');
const https = require('https');

function fetchXML(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'gs');
  const matches = [];
  let m;
  while ((m = regex.exec(xml)) !== null) {
    matches.push(m[1].trim());
  }
  return matches;
}

function parseEntries(xml) {
  const entries = [];
  const entryBlocks = xml.split('<entry>').slice(1);
  
  for (const block of entryBlocks) {
    try {
      const title = (extractTag(block, 'title')[0] || '').replace(/\s+/g, ' ').trim();
      const summary = (extractTag(block, 'summary')[0] || '').replace(/\s+/g, ' ').trim();
      const published = extractTag(block, 'published')[0] || '';
      
      // Authors
      const names = extractTag(block, 'name');
      const authorStr = names.slice(0, 4).join(', ') + (names.length > 4 ? ' et al.' : '');
      
      // URL - get the abs link
      const urlMatch = block.match(/href="(https:\/\/arxiv\.org\/abs\/[^"]+)"/);
      const url = urlMatch ? urlMatch[1] : '';
      
      // Categories
      const catMatch = block.match(/term="([^"]+)"/g) || [];
      const categories = catMatch.map(c => c.replace(/term="|"/g, ''));
      
      entries.push({
        title,
        abstract: summary.substring(0, 500) + (summary.length > 500 ? '...' : ''),
        authors: authorStr,
        url,
        date: published.split('T')[0],
        categories: categories.slice(0, 3),
        source: 'arXiv',
        category: 'tech',
      });
    } catch (e) {
      // Skip parse errors
    }
  }
  return entries;
}

async function collectAll(config) {
  const { api_url, queries, max_results } = config.arxiv;
  const allEntries = [];
  
  console.log('\n[arXiv] 医療AI関連論文を取得中...');
  
  for (const query of queries) {
    try {
      const url = `${api_url}?search_query=${encodeURIComponent(query)}&start=0&max_results=${max_results}&sortBy=submittedDate&sortOrder=descending`;
      const xml = await fetchXML(url);
      const entries = parseEntries(xml);
      allEntries.push(...entries);
      console.log(`  "${query.substring(0, 50)}..." → ${entries.length} 件`);
    } catch (e) {
      console.error(`  Error for query "${query}": ${e.message}`);
    }
  }
  
  // Deduplicate by title
  const seen = new Set();
  const unique = allEntries.filter(e => {
    const key = e.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  console.log(`  合計: ${unique.length} 件（重複除去後）`);
  return unique;
}

module.exports = { collectAll };
