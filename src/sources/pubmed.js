/**
 * PubMed E-utilities API からの論文収集
 * https://www.ncbi.nlm.nih.gov/books/NBK25501/
 */

const https = require('https');
const { URL } = require('url');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : require('http');
    mod.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

function fetchXML(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : require('http');
    mod.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Simple XML text extractor (no external dependency)
function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'gs');
  const matches = [];
  let m;
  while ((m = regex.exec(xml)) !== null) {
    matches.push(m[1].trim());
  }
  return matches;
}

function extractArticles(xml) {
  const articles = [];
  const articleBlocks = xml.split('<PubmedArticle>').slice(1);

  for (const block of articleBlocks) {
    try {
      const pmid = extractTag(block, 'PMID')[0] || '';
      const title = extractTag(block, 'ArticleTitle')[0] || 'No title';
      const abstractTexts = extractTag(block, 'AbstractText');
      const abstract = abstractTexts.join(' ') || 'No abstract available';
      
      // Authors
      const lastNames = extractTag(block, 'LastName');
      const foreNames = extractTag(block, 'ForeName');
      const authors = lastNames.map((ln, i) => `${ln} ${foreNames[i] || ''}`).slice(0, 5);
      const authorStr = authors.join(', ') + (lastNames.length > 5 ? ' et al.' : '');

      // Journal
      const journal = extractTag(block, 'Title')[0] || extractTag(block, 'ISOAbbreviation')[0] || '';
      
      // Date
      const year = extractTag(block, 'Year')[0] || '';
      const month = extractTag(block, 'Month')[0] || '';

      // DOI
      const doiMatch = block.match(/doi:\s*([^\s<]+)/i) || block.match(/<ArticleId IdType="doi">([^<]+)/);
      const doi = doiMatch ? doiMatch[1] : '';

      articles.push({
        pmid,
        title: title.replace(/<[^>]+>/g, ''), // strip HTML tags
        abstract: abstract.replace(/<[^>]+>/g, ''),
        authors: authorStr,
        journal,
        date: `${year} ${month}`.trim(),
        doi,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      });
    } catch (e) {
      console.error('Error parsing article:', e.message);
    }
  }
  return articles;
}

async function searchPubMed(query, maxResults = 10) {
  const baseUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  
  // Step 1: ESearch - get PMIDs
  const searchUrl = `${baseUrl}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&sort=date&retmode=json`;
  
  console.log(`  Searching PubMed: ${query.substring(0, 80)}...`);
  const searchResult = await fetchJSON(searchUrl);
  
  const idList = searchResult?.esearchresult?.idlist || [];
  if (idList.length === 0) {
    console.log('  No results found');
    return [];
  }
  
  console.log(`  Found ${idList.length} articles`);
  
  // Rate limit: NCBI requires 3 requests/sec max without API key
  await sleep(400);
  
  // Step 2: EFetch - get article details
  const fetchUrl = `${baseUrl}/efetch.fcgi?db=pubmed&id=${idList.join(',')}&retmode=xml`;
  const xml = await fetchXML(fetchUrl);
  
  return extractArticles(xml);
}

async function collectAll(config) {
  const results = {};
  const queries = config.pubmed.queries;
  
  for (const [key, queryConfig] of Object.entries(queries)) {
    console.log(`\n[PubMed] ${queryConfig.label}:`);
    
    // Replace relative date with computed date
    const daysBack = config.pubmed.days_back || 7;
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - daysBack);
    const dateStr = fromDate.toISOString().split('T')[0].replace(/-/g, '/');
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '/');
    
    let query = queryConfig.query.replace(
      /AND "last \d+ days"\[dp\]/,
      `AND ("${dateStr}"[dp] : "${today}"[dp])`
    );
    
    try {
      const articles = await searchPubMed(query, config.pubmed.max_results_per_query);
      results[key] = {
        label: queryConfig.label,
        priority: queryConfig.priority,
        articles,
      };
      // Rate limit between queries
      await sleep(500);
    } catch (e) {
      console.error(`  Error: ${e.message}`);
      results[key] = { label: queryConfig.label, priority: queryConfig.priority, articles: [] };
    }
  }
  
  return results;
}

module.exports = { collectAll, searchPubMed };
