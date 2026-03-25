#!/usr/bin/env node

/**
 * 静的サイト生成 — enriched_data.json から docs/ に静的HTMLを生成
 *
 * 生成ファイル:
 *   docs/index.html              → パスワード保護付きリダイレクト
 *   docs/archive/YYYY-MM-DD/index.html → 日別ブリーフィング
 *   docs/archive/index.html      → 日付一覧
 *   docs/search.html             → クライアントサイド検索
 *   docs/data/YYYY-MM-DD.json    → 日別データ
 */

const fs = require('fs');
const path = require('path');

// JST helpers (GitHub Actions runs in UTC)
function getJSTNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function getJSTDateString() {
  return getJSTNow().toISOString().split('T')[0];
}

const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');
const DATA_DIR = path.join(DOCS_DIR, 'data');

// --- Helpers ---

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function priorityClass(priority) {
  switch (priority) {
    case '要対応': return 'p-high';
    case '要注視': return 'p-mid';
    case 'テック': return 'p-tech';
    default: return 'p-info';
  }
}

function stripHtmlTags(str) {
  return String(str || '').replace(/<[^>]+>/g, '').trim();
}

function displayTitle(article) {
  const title = stripHtmlTags(article.title);
  if (title && /^[A-Za-z0-9\s\-:,.'"\(\)\[\]\/]+$/.test(title) && article.summary_ja) {
    return article.summary_ja.split('\u3002')[0] + '\u3002';
  }
  return title;
}

function articleId(article) {
  return article.pmid || article.doi || article.url || article.title;
}

function getAllArticles(data) {
  const articles = [];
  if (data.pubmed) {
    for (const [key, catData] of Object.entries(data.pubmed)) {
      for (const article of (catData.articles || [])) {
        articles.push({ ...article, _source: 'pubmed', _category: key });
      }
    }
  }
  for (const key of ['mhlw', 'hackernews', 'arxiv', 'medscape', 'fierce', 'carenet', 'nikkei', 'ft', 'm3', 'medical_tribune']) {
    if (data[key]) {
      for (const article of data[key]) {
        articles.push({ ...article, _source: key });
      }
    }
  }
  return articles.filter(a => a.priority !== '除外');
}

function loadJSON(filepath) {
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) { /* ignore */ }
  return null;
}

// Load weekly cache from output/ or docs/data/ (GitHub Actions persistence)
function loadWeeklyCache(name) {
  return loadJSON(path.join(OUTPUT_DIR, name)) || loadJSON(path.join(DATA_DIR, name));
}

// Merge weekly cache into daily data for tabs that have no fresh data
function mergeWeeklyCache(data) {
  // Papers: if no pubmed in today's data, use cache
  if (!data.pubmed || Object.keys(data.pubmed).length === 0) {
    const cached = loadWeeklyCache('weekly_papers.json');
    if (cached) {
      if (cached.pubmed) data.pubmed = cached.pubmed;
      if (cached.arxiv && (!data.arxiv || data.arxiv.length === 0)) data.arxiv = cached.arxiv;
      if (cached._meta) {
        data._meta = data._meta || {};
        if (!data._meta.papers_updated && cached._meta.papers_updated) data._meta.papers_updated = cached._meta.papers_updated;
      }
    }
  }

  // Alerts: if mhlw has no summarized articles, use cache
  const mhlwHasSummary = (data.mhlw || []).some(a => a.priority && a.priority !== '参考');
  if (!mhlwHasSummary) {
    const cached = loadWeeklyCache('weekly_alerts.json');
    if (cached && cached.mhlw && cached.mhlw.length > 0) {
      // Only use cache if it has better data (API-summarized)
      const cachedHasSummary = cached.mhlw.some(a => a.priority && a.priority !== '参考');
      if (cachedHasSummary) {
        data.mhlw = cached.mhlw;
        data._meta = data._meta || {};
        if (!data._meta.alerts_updated && cached._meta) data._meta.alerts_updated = cached._meta.alerts_updated;
      }
    }
  }

  // Tech: if hackernews/arxiv have no summarized articles, use cache
  const hnHasSummary = (data.hackernews || []).some(a => a.summary_ja && a.summary_ja !== a.title);
  if (!hnHasSummary) {
    const cached = loadWeeklyCache('weekly_tech.json');
    if (cached) {
      if (cached.hackernews && cached.hackernews.length > 0) data.hackernews = cached.hackernews;
      if (cached.arxiv && cached.arxiv.length > 0 && (!data.arxiv || data.arxiv.length === 0)) data.arxiv = cached.arxiv;
      data._meta = data._meta || {};
      if (!data._meta.tech_updated && cached._meta) data._meta.tech_updated = cached._meta.tech_updated;
    }
  }

  return data;
}

function listExistingDates() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort()
    .reverse();
}

// --- CSS (shared) ---

const CSS = `*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#FAFAF8;--card:#FFFFFF;--border:#E8E6E0;--text:#1A1A18;--sub:#6B6960;--accent:#1A5F4A;--red:#9B2C2C;--amber:#92600A;--blue:#1A4B8C;--purple:#5B21B6;--tag-red:#FEF2F2;--tag-amber:#FFFBEB;--tag-blue:#EFF6FF;--tag-green:#F0FDF4;--tag-purple:#F5F3FF;--font-sans:'Noto Sans JP',sans-serif;--font-serif:'Noto Serif JP',serif}
body{font-family:var(--font-sans);background:var(--bg);color:var(--text);line-height:1.75;-webkit-font-smoothing:antialiased}
.app-header{background:var(--card);border-bottom:1px solid var(--border);padding:12px 20px;position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.app-header h1{font-family:var(--font-serif);font-size:18px;font-weight:700;letter-spacing:0.02em;white-space:nowrap}
.app-header nav{display:flex;gap:12px;align-items:center;flex:1}
.app-header nav a{font-size:13px;color:var(--sub);text-decoration:none;font-weight:500;padding:4px 10px;border-radius:6px;transition:all .15s}
.app-header nav a:hover,.app-header nav a.active{color:var(--accent);background:var(--tag-green)}
.container{max-width:820px;margin:0 auto;padding:24px 20px 80px}
.date-nav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px}
.date-nav a{font-size:12px;padding:4px 12px;border:1px solid var(--border);border-radius:20px;text-decoration:none;color:var(--sub);background:var(--card);transition:all .15s}
.date-nav a:hover,.date-nav a.current{background:var(--accent);color:#fff;border-color:var(--accent)}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px 20px;margin-bottom:12px;transition:box-shadow .2s}
.card:hover{box-shadow:0 2px 12px rgba(0,0,0,.05)}
.card.read{opacity:0.55}
.card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px}
.card h3{font-size:14.5px;font-weight:700;line-height:1.55}
.priority{font-size:10px;font-weight:700;letter-spacing:.06em;padding:3px 8px;border-radius:4px;white-space:nowrap;flex-shrink:0}
.p-high{background:var(--tag-red);color:var(--red)}
.p-mid{background:var(--tag-amber);color:var(--amber)}
.p-info{background:var(--tag-green);color:var(--accent)}
.p-tech{background:var(--tag-purple);color:var(--purple)}
.card .source-line{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:4px}
.card .source{font-size:11px;color:var(--sub)}
.card .link-btn{font-size:11px;color:var(--accent);text-decoration:none;font-weight:500;display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border:1px solid rgba(26,95,74,.25);border-radius:4px;transition:all .15s}
.card .link-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
.card .body{font-size:13px;color:#3D3D3A;line-height:1.8}
.card .impact{margin-top:10px;padding-top:10px;border-top:1px dashed var(--border);font-size:12.5px;color:var(--accent);font-weight:500;line-height:1.7}
.card .impact::before{content:'-> '}
.card .memo{margin-top:8px;background:#F7F7F5;border-radius:6px;padding:10px 14px;font-size:12.5px;line-height:1.7}
.card .memo strong{color:var(--accent);font-weight:700}
.section-label{font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--sub);margin:28px 0 14px;display:flex;align-items:center;gap:8px}
.section-label::after{content:'';flex:1;height:1px;background:var(--border)}
.archive-list{list-style:none}
.archive-list li{margin-bottom:8px}
.archive-list li a{font-size:14px;color:var(--accent);text-decoration:none;padding:10px 16px;display:block;background:var(--card);border:1px solid var(--border);border-radius:8px;transition:all .15s}
.archive-list li a:hover{box-shadow:0 2px 8px rgba(0,0,0,.05)}
.archive-list li a .count{font-size:12px;color:var(--sub);margin-left:8px}
.empty-state{text-align:center;padding:60px 20px;color:var(--sub);font-size:14px}
.collapsible-section{margin-top:8px}
.collapsible-section>summary{list-style:none}
.collapsible-section>summary::-webkit-details-marker{display:none}
.collapsible-section>summary::after{content:' \\25B6';font-size:10px}
.collapsible-section[open]>summary::after{content:' \\25BC'}
.tabs{display:flex;gap:0;margin-bottom:24px;border-bottom:1px solid var(--border);overflow-x:auto}
.tab{padding:10px 18px;font-size:13.5px;font-weight:500;color:var(--sub);cursor:pointer;border-bottom:2.5px solid transparent;transition:all .2s;white-space:nowrap;user-select:none;text-decoration:none}
.tab:hover{color:var(--text)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.tab .badge{display:inline-block;background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;margin-left:5px;vertical-align:1px}
.panel{display:none}.panel.active{display:block}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:24px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 10px;text-align:center}
.stat .num{font-size:24px;font-weight:700;color:var(--accent)}
.stat .label{font-size:11px;color:var(--sub);margin-top:2px}
.source-pills{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.source-pill{font-size:11px;padding:3px 10px;border-radius:20px;border:1px solid var(--border);color:var(--sub);background:var(--card)}
.source-pill b{color:var(--text);font-weight:700}
.footer-note{margin-top:40px;padding-top:20px;border-top:1px solid var(--border);font-size:12px;color:var(--sub);line-height:1.7;text-align:center}
.search-box{margin-bottom:20px;display:flex;gap:8px}
.search-box input{flex:1;font-size:14px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-family:var(--font-sans);background:var(--card)}
.search-box input:focus{outline:none;border-color:var(--accent)}
.search-results-info{font-size:13px;color:var(--sub);margin-bottom:16px;padding:12px 16px;background:var(--card);border:1px solid var(--border);border-radius:8px}
.search-results-info b{color:var(--text)}
@media(max-width:600px){.stats-row{grid-template-columns:repeat(2,1fr)}.card-head{flex-direction:column;gap:4px}.priority{align-self:flex-start}.app-header{flex-direction:column;align-items:flex-start}}`;

// --- Auth script (SHA-256 check via SubtleCrypto) ---

// --- Tabs script ---

const CLIENT_SCRIPT = `<script>
function showTab(el,id){
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});
  document.querySelectorAll('.panel').forEach(function(p){p.classList.remove('active')});
  document.getElementById(id).classList.add('active');
  el.classList.add('active');
}
</script>`;

// --- HTML generators ---

function layoutHead(title) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&family=Noto+Serif+JP:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>`;
}

function layoutHeader(currentPage, basePath) {
  const bp = basePath || '.';
  const nav = (page, label) => {
    const href = page === '/' ? `${bp}/index.html` : page === '/archive' ? `${bp}/archive/index.html` : page === '/search' ? `${bp}/search.html` : page;
    return `<a href="${href}"${currentPage === page ? ' class="active"' : ''}>${label}</a>`;
  };
  return `<div class="app-header">
  <h1><img src="${bp}/kanri-kun.png" alt="管理くん" style="height:36px;vertical-align:middle;margin-right:8px">管理くんニュース</h1>
  <nav>
    ${nav('/', 'Latest')}
    ${nav('/archive', 'Archive')}
    ${nav('/search', 'Search')}
  </nav>
</div>`;
}

function renderCardHTML(article) {
  const impact = article.impact
    ? `<div class="impact">${escapeHtml(article.impact)}</div>` : '';
  const memo = article.memo
    ? `<div class="memo"><strong>管理くんメモ:</strong> ${escapeHtml(article.memo)}</div>` : '';
  return `<div class="card">
  <div class="card-head">
    <h3>${escapeHtml(displayTitle(article))}</h3>
    <span class="priority ${priorityClass(article.priority)}">${escapeHtml(article.priority || '')}</span>
  </div>
  <div class="source-line">
    <span class="source">${escapeHtml(article.source || article.journal || '')} ${article.date ? '— ' + escapeHtml(article.date) : ''}</span>
    ${article.url ? `<a class="link-btn" href="${escapeHtml(article.url)}" target="_blank" rel="noopener">原文 ↗</a>` : ''}
  </div>
  <div class="body">${escapeHtml(article.summary_ja || article.abstract || '')}</div>
  ${impact}
  ${memo}
</div>`;
}

function renderCards(items) {
  return items.map(renderCardHTML).join('\n');
}

// --- Build functions ---

function buildBriefingPage(data, date, allDates, basePath) {
  const articles = getAllArticles(data);

  // Load settings for category labels
  const settingsPath = path.join(PROJECT_ROOT, 'config', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const categoryLabelMap = {};
  if (settings.pubmed && settings.pubmed.queries) {
    for (const [key, q] of Object.entries(settings.pubmed.queries)) {
      categoryLabelMap[key] = q.label;
    }
  }

  // Group by source/priority
  const bySource = {};
  for (const a of articles) {
    const src = a._source || 'other';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(a);
  }

  const pubmedArticles = bySource['pubmed'] || [];
  const mhlwArticles = bySource['mhlw'] || [];
  const hnArticles = bySource['hackernews'] || [];

  const nHigh = articles.filter(a => a.priority === '要対応').length;
  const nMid = articles.filter(a => a.priority === '要注視').length;
  const nInfo = articles.filter(a => a.priority === '参考').length;

  const priorityOrder = { '要対応': 0, '要注視': 1, '参考': 2 };
  const sortByPriority = (items) => [...items].sort((a, b) =>
    (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3)
  );

  // Morning tab — PubMed/arXiv/厚労省は除外（専用タブのみ）
  const morningExcludeSources = new Set(['pubmed', 'arxiv', 'mhlw']);
  const morningArticles = articles.filter(a => !morningExcludeSources.has(a._source));
  const allMorning = sortByPriority(morningArticles);
  const morningHigh = allMorning.filter(a => a.priority === '要対応');
  const morningMid = allMorning.filter(a => a.priority === '要注視').slice(0, 10);
  const remainingSlots = Math.max(0, 20 - morningHigh.length - morningMid.length);
  const morningInfo = allMorning.filter(a => a.priority === '参考').slice(0, Math.min(5, remainingSlots));
  const morningCount = morningHigh.length + morningMid.length + morningInfo.length;

  const morningHTML = [
    morningHigh.length > 0 ? `<div class="section-label">要対応 — 経営判断に直結</div>\n${renderCards(morningHigh)}` : '',
    morningMid.length > 0 ? `<div class="section-label">要注視 — 中期的に影響</div>\n${renderCards(morningMid)}` : '',
    morningInfo.length > 0 ? `<details class="collapsible-section"><summary class="section-label" style="cursor:pointer">参考情報（${morningInfo.length}件）</summary>\n${renderCards(morningInfo)}</details>` : '',
  ].filter(Boolean).join('\n');

  // Papers tab
  const specialtyMap = {};
  for (const p of pubmedArticles) {
    if (p._category === 'medical_ai') continue;
    const key = p._category || '一般';
    if (!specialtyMap[key]) specialtyMap[key] = [];
    specialtyMap[key].push(p);
  }
  const papersHTML = Object.entries(specialtyMap).map(([key, items]) => {
    const label = categoryLabelMap[key] || key;
    const sorted = sortByPriority(items).slice(0, 5);
    return `<div class="section-label">${escapeHtml(label)}</div>\n${renderCards(sorted)}`;
  }).join('\n');
  const papersCount = Object.values(specialtyMap).reduce((sum, items) => sum + Math.min(items.length, 5), 0);

  // Alerts tab
  const alertsHTML = mhlwArticles.length > 0
    ? `<div class="section-label">厚労省トピックス</div>\n${renderCards(mhlwArticles)}`
    : '<div class="empty-state">制度アラートはありません。</div>';

  // Tech tab
  const medicalAiArticles = pubmedArticles.filter(p => p._category === 'medical_ai');
  const techItems = sortByPriority([...hnArticles, ...medicalAiArticles]).slice(0, 10);
  const techHTML = techItems.length > 0
    ? renderCards(techItems)
    : '<div class="empty-state">テック記事はありません。</div>';

  // Update dates from _meta
  const meta = data._meta || {};
  function formatUpdateDate(isoDate) {
    if (!isoDate) return '';
    const d2 = new Date(isoDate + 'T00:00:00');
    const dow = ['日', '月', '火', '水', '木', '金', '土'][d2.getDay()];
    return `${d2.getMonth() + 1}/${d2.getDate()}（${dow}）`;
  }
  const papersUpdated = formatUpdateDate(meta.papers_updated);
  const alertsUpdated = formatUpdateDate(meta.alerts_updated);
  const techUpdated = formatUpdateDate(meta.tech_updated);

  // Source counts
  const sourceCounts = {};
  for (const [src, items] of Object.entries(bySource)) {
    const name = { pubmed: 'PubMed', mhlw: '厚労省', hackernews: 'HackerNews', arxiv: 'arXiv', medscape: 'Medscape', fierce: 'Fierce', carenet: 'CareNet', nikkei: '日経', ft: 'FT', m3: 'm3.com', medical_tribune: 'Medical Tribune' }[src] || src;
    sourceCounts[name] = items.length;
  }
  const pillsHTML = Object.entries(sourceCounts).map(([name, count]) =>
    `<span class="source-pill">${escapeHtml(name)} <b>${count}</b></span>`
  ).join('\n');

  // Date nav
  const dateNav = allDates.slice(0, 10).map(d =>
    `<a href="${basePath}/archive/${d}/index.html"${d === date ? ' class="current"' : ''}>${d}</a>`
  ).join('\n');

  // Date display
  const d = new Date(date + 'T00:00:00');
  const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  const dateStr = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${dayOfWeek}）`;

  return `${layoutHead('Briefing ' + date)}
<body>
${layoutHeader('', basePath)}
<div class="container">
  <div style="font-family:var(--font-serif);font-size:15px;color:var(--sub);margin-bottom:16px">${dateStr}</div>
  <div class="date-nav">${dateNav}</div>
  <div class="source-pills">${pillsHTML}</div>
  <div class="tabs">
    <div class="tab active" onclick="showTab(this,'morning')">朝ブリーフィング<span class="badge">${morningCount}</span></div>
    <div class="tab" onclick="showTab(this,'pubmed')">論文ダイジェスト${papersUpdated ? '<span style="font-size:10px;color:var(--sub);margin-left:4px">'+papersUpdated+'</span>' : ''}<span class="badge">${papersCount}</span></div>
    <div class="tab" onclick="showTab(this,'alert')">制度アラート${alertsUpdated ? '<span style="font-size:10px;color:var(--sub);margin-left:4px">'+alertsUpdated+'</span>' : ''}<span class="badge">${mhlwArticles.length}</span></div>
    <div class="tab" onclick="showTab(this,'tech')">テック・AI${techUpdated ? '<span style="font-size:10px;color:var(--sub);margin-left:4px">'+techUpdated+'</span>' : ''}<span class="badge">${techItems.length}</span></div>
  </div>
  <div class="panel active" id="morning">
    <div class="stats-row">
      <div class="stat"><div class="num">${nHigh}</div><div class="label">要対応</div></div>
      <div class="stat"><div class="num">${nMid}</div><div class="label">要注視</div></div>
      <div class="stat"><div class="num">${nInfo}</div><div class="label">参考情報</div></div>
      <div class="stat"><div class="num">${pubmedArticles.length}</div><div class="label">新着論文</div></div>
    </div>
    ${morningHTML || '<div class="empty-state">記事がありません。</div>'}
  </div>
  <div class="panel" id="pubmed">${papersHTML || '<div class="empty-state">論文がありません。</div>'}</div>
  <div class="panel" id="alert">${alertsHTML}</div>
  <div class="panel" id="tech">${techHTML}</div>
  <div class="footer-note">
    自動生成: GitHub Actions + Claude API + PubMed + 厚労省 + HN + Medscape + Fierce + CareNet + 日経 + FT
  </div>
</div>
${CLIENT_SCRIPT}</body></html>`;
}

function buildIndexPage(latestDate) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="0;url=archive/${latestDate}/index.html">
<title>管理くんニュース</title>
</head>
<body>
<p>Redirecting to <a href="archive/${latestDate}/index.html">latest briefing</a>...</p>
</body></html>`;
}

function buildArchiveListPage(allDates, dateCounts) {
  const listHTML = allDates.map(d => {
    const count = dateCounts[d] || 0;
    return `<li><a href="${d}/index.html">${d}<span class="count">${count} articles</span></a></li>`;
  }).join('\n');

  return `${layoutHead('Archive — 管理くんニュース')}
<body>
${layoutHeader('/archive', '..')}
<div class="container">
  <h2 style="font-size:18px;margin-bottom:20px;">Archive</h2>
  ${allDates.length > 0
    ? `<ul class="archive-list">${listHTML}</ul>`
    : '<div class="empty-state">アーカイブがまだありません。</div>'}
</div></body></html>`;
}

function buildSearchPage(allDates) {
  // Collect all articles across all dates for search
  const allSearchData = [];
  for (const date of allDates) {
    const dataPath = path.join(DATA_DIR, `${date}.json`);
    if (!fs.existsSync(dataPath)) continue;
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const articles = getAllArticles(data);
    for (const a of articles) {
      allSearchData.push({
        t: a.title || '',
        s: a.summary_ja || a.abstract || '',
        m: a.memo || '',
        i: a.impact || '',
        src: a.source || a.journal || '',
        p: a.priority || '',
        u: a.url || '',
        d: date,
      });
    }
  }

  return `${layoutHead('Search — 管理くんニュース')}
<body>
${layoutHeader('/search', '.')}
<div class="container">
  <h2 style="font-size:18px;margin-bottom:20px;">Search</h2>
  <div class="search-box"><input id="search-input" type="text" placeholder="キーワードを入力..." autofocus></div>
  <div id="search-info" class="search-results-info" style="display:none"></div>
  <div id="search-results"></div>
</div><script>
var DATA=${JSON.stringify(allSearchData)};
var input=document.getElementById('search-input');
var info=document.getElementById('search-info');
var results=document.getElementById('search-results');
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function pclass(p){return p==='要対応'?'p-high':p==='要注視'?'p-mid':p==='テック'?'p-tech':'p-info'}
function search(){
  var q=input.value.trim().toLowerCase();
  if(!q){info.style.display='none';results.innerHTML='';return}
  var matches=DATA.filter(function(a){
    return (a.t+' '+a.s+' '+a.m+' '+a.i+' '+a.src).toLowerCase().indexOf(q)>=0;
  });
  info.style.display='block';
  info.innerHTML='<b>'+matches.length+'</b> 件見つかりました';
  results.innerHTML=matches.slice(0,50).map(function(a){
    return '<div class="card"><div class="card-head"><h3>'+esc(a.t)+'</h3><span class="priority '+pclass(a.p)+'">'+esc(a.p)+'</span></div>'
      +'<div class="source-line"><span class="source">'+esc(a.src)+' — '+esc(a.d)+'</span>'
      +(a.u?'<a class="link-btn" href="'+esc(a.u)+'" target="_blank" rel="noopener">原文 ↗</a>':'')
      +'</div><div class="body">'+esc(a.s)+'</div></div>';
  }).join('');
}
input.addEventListener('input',search);
</script>
</body></html>`;
}

// --- Main ---

function main() {
  console.log('Static site build starting...');

  // Ensure dirs
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DOCS_DIR, 'archive'), { recursive: true });

  // Today's date
  const today = getJSTDateString();

  // Copy today's enriched_data to data dir
  const enrichedPath = path.join(OUTPUT_DIR, 'enriched_data.json');
  if (fs.existsSync(enrichedPath)) {
    const todayDataPath = path.join(DATA_DIR, `${today}.json`);
    fs.copyFileSync(enrichedPath, todayDataPath);
    console.log(`  Data: ${todayDataPath}`);
  } else {
    console.error('enriched_data.json not found. Run auto-briefing first.');
    process.exit(1);
  }

  // Collect all dates
  const allDates = listExistingDates();
  const latestDate = allDates[0] || today;

  // Build briefing pages for all dates
  const dateCounts = {};
  for (const date of allDates) {
    const dataPath = path.join(DATA_DIR, `${date}.json`);
    let data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    // For the latest date, merge weekly cache to fill empty tabs
    if (date === latestDate) {
      data = mergeWeeklyCache(data);
    }

    const articles = getAllArticles(data);
    dateCounts[date] = articles.length;

    const dirPath = path.join(DOCS_DIR, 'archive', date);
    fs.mkdirSync(dirPath, { recursive: true });
    const html = buildBriefingPage(data, date, allDates, '../..');
    fs.writeFileSync(path.join(dirPath, 'index.html'), html, 'utf8');
    console.log(`  Archive: ${date} (${articles.length} articles)`);
  }

  // Build index (redirect to latest)
  const indexHTML = buildIndexPage(latestDate);
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), indexHTML, 'utf8');
  console.log(`  Index: -> ${latestDate}`);

  // Build archive list
  const archiveHTML = buildArchiveListPage(allDates, dateCounts);
  fs.writeFileSync(path.join(DOCS_DIR, 'archive', 'index.html'), archiveHTML, 'utf8');
  console.log(`  Archive list: ${allDates.length} dates`);

  // Build search page
  const searchHTML = buildSearchPage(allDates);
  fs.writeFileSync(path.join(DOCS_DIR, 'search.html'), searchHTML, 'utf8');
  console.log(`  Search page built`);

  // .nojekyll for GitHub Pages
  fs.writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '', 'utf8');

  console.log('\nStatic site build complete!');
  console.log(`Output: ${DOCS_DIR}`);
}

main();
