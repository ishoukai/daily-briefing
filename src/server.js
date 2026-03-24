#!/usr/bin/env node

/**
 * 管理くんニュース — ローカルWebサーバー
 * Express ベース、ポート3000
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');
const READ_STATUS_PATH = path.join(OUTPUT_DIR, 'read_status.json');
const MANUAL_ARTICLES_PATH = path.join(OUTPUT_DIR, 'manual_articles.json');

app.use(express.json());

// --- Helpers ---

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadReadStatus() {
  try {
    return JSON.parse(fs.readFileSync(READ_STATUS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveReadStatus(status) {
  fs.writeFileSync(READ_STATUS_PATH, JSON.stringify(status, null, 2), 'utf8');
}

function loadManualArticles() {
  try {
    return JSON.parse(fs.readFileSync(MANUAL_ARTICLES_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveManualArticles(data) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(MANUAL_ARTICLES_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function getManualArticlesForDate(date) {
  const all = loadManualArticles();
  return all[date] || [];
}

function listBriefingDates() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs.readdirSync(OUTPUT_DIR)
    .filter(f => /^briefing_\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .map(f => f.match(/briefing_(\d{4}-\d{2}-\d{2})\.html/)[1])
    .sort()
    .reverse();
}

function getLatestDate() {
  const dates = listBriefingDates();
  return dates.length > 0 ? dates[0] : null;
}

function loadEnrichedData(date) {
  // Try date-specific file first, then generic
  const datePath = path.join(OUTPUT_DIR, `enriched_data_${date}.json`);
  if (fs.existsSync(datePath)) {
    return JSON.parse(fs.readFileSync(datePath, 'utf8'));
  }
  const genericPath = path.join(OUTPUT_DIR, 'enriched_data.json');
  if (fs.existsSync(genericPath)) {
    return JSON.parse(fs.readFileSync(genericPath, 'utf8'));
  }
  return null;
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
  if (data.mhlw) {
    for (const article of data.mhlw) {
      articles.push({ ...article, _source: 'mhlw' });
    }
  }
  if (data.hackernews) {
    for (const article of data.hackernews) {
      articles.push({ ...article, _source: 'hackernews' });
    }
  }
  if (data.arxiv) {
    for (const article of data.arxiv) {
      articles.push({ ...article, _source: 'arxiv' });
    }
  }
  if (data.medscape) {
    for (const article of data.medscape) {
      articles.push({ ...article, _source: 'medscape' });
    }
  }
  if (data.fierce) {
    for (const article of data.fierce) {
      articles.push({ ...article, _source: 'fierce' });
    }
  }
  if (data.carenet) {
    for (const article of data.carenet) {
      articles.push({ ...article, _source: 'carenet' });
    }
  }
  if (data.nikkei) {
    for (const article of data.nikkei) {
      articles.push({ ...article, _source: 'nikkei' });
    }
  }
  if (data.ft) {
    for (const article of data.ft) {
      articles.push({ ...article, _source: 'ft' });
    }
  }
  if (data.m3) {
    for (const article of data.m3) {
      articles.push({ ...article, _source: 'm3' });
    }
  }
  if (data.medical_tribune) {
    for (const article of data.medical_tribune) {
      articles.push({ ...article, _source: 'medical_tribune' });
    }
  }
  return articles;
}

function articleId(article) {
  return article.pmid || article.doi || article.url || article.title;
}

// --- Layout HTML ---

function layoutHead(title) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&family=Noto+Serif+JP:wght@400;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#FAFAF8;--card:#FFFFFF;--border:#E8E6E0;--text:#1A1A18;--sub:#6B6960;--accent:#1A5F4A;--red:#9B2C2C;--amber:#92600A;--blue:#1A4B8C;--purple:#5B21B6;--tag-red:#FEF2F2;--tag-amber:#FFFBEB;--tag-blue:#EFF6FF;--tag-green:#F0FDF4;--tag-purple:#F5F3FF;--font-sans:'Noto Sans JP',sans-serif;--font-serif:'Noto Serif JP',serif}
body{font-family:var(--font-sans);background:var(--bg);color:var(--text);line-height:1.75;-webkit-font-smoothing:antialiased}
.app-header{background:var(--card);border-bottom:1px solid var(--border);padding:12px 20px;position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.app-header h1{font-family:var(--font-serif);font-size:18px;font-weight:700;letter-spacing:0.02em;white-space:nowrap}
.app-header nav{display:flex;gap:12px;align-items:center;flex:1}
.app-header nav a{font-size:13px;color:var(--sub);text-decoration:none;font-weight:500;padding:4px 10px;border-radius:6px;transition:all .15s}
.app-header nav a:hover,.app-header nav a.active{color:var(--accent);background:var(--tag-green)}
.search-form{display:flex;gap:6px;margin-left:auto}
.search-form input{font-size:13px;padding:6px 12px;border:1px solid var(--border);border-radius:6px;width:200px;font-family:var(--font-sans);background:var(--bg)}
.search-form input:focus{outline:none;border-color:var(--accent)}
.search-form button{font-size:12px;padding:6px 14px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500}
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
.checkbox-row{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
.checkbox-row label{font-size:12px;color:var(--sub);cursor:pointer;display:flex;align-items:center;gap:6px}
.checkbox-row input[type="checkbox"]{width:16px;height:16px;accent-color:var(--accent);cursor:pointer}
.section-label{font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--sub);margin:28px 0 14px;display:flex;align-items:center;gap:8px}
.section-label::after{content:'';flex:1;height:1px;background:var(--border)}
.search-results-info{font-size:13px;color:var(--sub);margin-bottom:16px;padding:12px 16px;background:var(--card);border:1px solid var(--border);border-radius:8px}
.search-results-info b{color:var(--text)}
.search-highlight{background:#FEF08A;padding:1px 2px;border-radius:2px}
.archive-list{list-style:none}
.archive-list li{margin-bottom:8px}
.archive-list li a{font-size:14px;color:var(--accent);text-decoration:none;padding:10px 16px;display:block;background:var(--card);border:1px solid var(--border);border-radius:8px;transition:all .15s}
.archive-list li a:hover{box-shadow:0 2px 8px rgba(0,0,0,.05)}
.archive-list li a .count{font-size:12px;color:var(--sub);margin-left:8px}
.empty-state{text-align:center;padding:60px 20px;color:var(--sub);font-size:14px}
.collapsible-section{margin-top:8px}
.collapsible-section>summary{list-style:none}
.collapsible-section>summary::-webkit-details-marker{display:none}
.collapsible-section>summary::after{content:' ▶';font-size:10px}
.collapsible-section[open]>summary::after{content:' ▼'}
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
@media(max-width:600px){.stats-row{grid-template-columns:repeat(2,1fr)}.card-head{flex-direction:column;gap:4px}.priority{align-self:flex-start}.app-header{flex-direction:column;align-items:flex-start}.search-form{margin-left:0;width:100%}.search-form input{flex:1}}
</style>
</head>`;
}

function layoutHeader(currentPage) {
  const nav = (page, label) =>
    `<a href="${page}"${currentPage === page ? ' class="active"' : ''}>${label}</a>`;
  return `<div class="app-header">
  <h1><img src="/kanri-kun.png" alt="管理くん" style="height:36px;vertical-align:middle;margin-right:8px">管理くんニュース</h1>
  <nav>
    ${nav('/', 'Latest')}
    ${nav('/archive', 'Archive')}
    ${nav('/bookmarklet', '+ 記事追加')}
  </nav>
  <form class="search-form" action="/search" method="get">
    <input type="text" name="q" placeholder="Search..." autocomplete="off">
    <button type="submit">Search</button>
  </form>
</div>`;
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
  // 英語タイトルの場合はsummary_jaを見出しに使用
  if (title && /^[A-Za-z0-9\s\-:,.'"\(\)\[\]\/]+$/.test(title) && article.summary_ja) {
    return article.summary_ja.split('。')[0] + '。';
  }
  return title;
}

function renderCardHTML(article) {
  const impact = article.impact
    ? `<div class="impact">${escapeHtml(article.impact)}</div>` : '';
  const memo = article.memo
    ? `<div class="memo"><strong>理事長メモ:</strong> ${escapeHtml(article.memo)}</div>` : '';
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

function clientScript() {
  return `<script>
function showTab(el, id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  el.classList.add('active');
}
</script>`;
}

// --- Routes ---

// Latest briefing
app.get('/', (req, res) => {
  const date = getLatestDate();
  if (!date) {
    return res.send(layoutHead('管理くんニュース') + '<body>' + layoutHeader('/') +
      '<div class="container"><div class="empty-state">ブリーフィングがまだありません。<br><code>npm run auto</code> で生成してください。</div></div></body></html>');
  }
  res.redirect(`/archive/${date}`);
});

// Archive list
app.get('/archive', (req, res) => {
  const dates = listBriefingDates();
  const listHTML = dates.map(d => {
    const data = loadEnrichedData(d);
    const articles = data ? getAllArticles(data) : [];
    return `<li><a href="/archive/${d}">${d}<span class="count">${articles.length} articles</span></a></li>`;
  }).join('\n');

  res.send(`${layoutHead('Archive — 管理くんニュース')}
<body>
${layoutHeader('/archive')}
<div class="container">
  <h2 style="font-size:18px;margin-bottom:20px;">Archive</h2>
  ${dates.length > 0
    ? `<ul class="archive-list">${listHTML}</ul>`
    : '<div class="empty-state">アーカイブがまだありません。</div>'}
</div>
</body></html>`);
});

// Specific date briefing
app.get('/archive/:date', (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).send('Invalid date format');
  }

  // Serve the pre-rendered HTML if it exists, but wrap with app header
  const htmlPath = path.join(OUTPUT_DIR, `briefing_${date}.html`);
  const data = loadEnrichedData(date);

  if (!fs.existsSync(htmlPath) && !data) {
    return res.status(404).send(layoutHead('Not Found') + '<body>' + layoutHeader('') +
      '<div class="container"><div class="empty-state">この日付のブリーフィングは見つかりません。</div></div></body></html>');
  }

  const readStatus = loadReadStatus();
  const dates = listBriefingDates();
  const autoArticles = data ? getAllArticles(data) : [];

  // Merge manual articles for this date
  const manualArticles = getManualArticlesForDate(date).map(a => ({ ...a, _source: 'manual', _manualSource: a.source }));
  // 「除外」記事を全タブから非表示
  const articles = [...autoArticles, ...manualArticles].filter(a => a.priority !== '除外');

  // Group articles
  const byPriority = { '要対応': [], '要注視': [], '参考': [], 'テック': [], 'その他': [] };
  const bySource = {};
  for (const a of articles) {
    const p = byPriority[a.priority] ? a.priority : 'その他';
    byPriority[p].push(a);
    const src = a._source || 'other';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(a);
  }

  const pubmedArticles = bySource['pubmed'] || [];
  const mhlwArticles = bySource['mhlw'] || [];
  const hnArticles = bySource['hackernews'] || [];
  const arxivArticles = bySource['arxiv'] || [];

  const nHigh = byPriority['要対応'].length;
  const nMid = byPriority['要注視'].length;
  const nInfo = byPriority['参考'].length;

  // Load settings for category labels
  const settingsPath = path.join(__dirname, '..', 'config', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const categoryLabelMap = {};
  if (settings.pubmed && settings.pubmed.queries) {
    for (const [key, q] of Object.entries(settings.pubmed.queries)) {
      categoryLabelMap[key] = q.label;
    }
  }

  // Priority sort helper
  const priorityOrder = { '要対応': 0, '要注視': 1, '参考': 2 };
  const sortByPriority = (items) => [...items].sort((a, b) =>
    (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3)
  );

  // Morning briefing: PubMed/arXiv/厚労省は除外（専用タブのみ）
  // 要対応=全件、要注視=最大10件、参考=最大5件（折りたたみ）、合計20件上限
  const morningExcludeSources = new Set(['pubmed', 'arxiv', 'mhlw']);
  const morningArticles = articles.filter(a => !morningExcludeSources.has(a._source));
  const allMorning = sortByPriority(morningArticles);
  const morningHigh = allMorning.filter(a => a.priority === '要対応');
  const morningMid = allMorning.filter(a => a.priority === '要注視').slice(0, 10);
  const remainingSlots = Math.max(0, 20 - morningHigh.length - morningMid.length);
  const morningInfo = allMorning.filter(a => a.priority === '参考').slice(0, Math.min(5, remainingSlots));
  const morningCount = morningHigh.length + morningMid.length + morningInfo.length;

  const renderCards = (items) => items.map(a => renderCardHTML(a)).join('\n');

  const dateNav = dates.slice(0, 10).map(d =>
    `<a href="/archive/${d}"${d === date ? ' class="current"' : ''}>${d}</a>`
  ).join('\n');

  const medscapeArticles = bySource['medscape'] || [];
  const fierceArticles = bySource['fierce'] || [];
  const carenetArticles = bySource['carenet'] || [];
  const manualSrcArticles = bySource['manual'] || [];

  const sourceCounts = {};
  if (pubmedArticles.length) sourceCounts['PubMed'] = pubmedArticles.length;
  if (mhlwArticles.length) sourceCounts['厚労省'] = mhlwArticles.length;
  if (hnArticles.length) sourceCounts['HackerNews'] = hnArticles.length;
  if (arxivArticles.length) sourceCounts['arXiv'] = arxivArticles.length;
  if (medscapeArticles.length) sourceCounts['Medscape'] = medscapeArticles.length;
  if (fierceArticles.length) sourceCounts['Fierce'] = fierceArticles.length;
  if (carenetArticles.length) sourceCounts['CareNet'] = carenetArticles.length;
  const nikkeiArticles = bySource['nikkei'] || [];
  const ftArticles = bySource['ft'] || [];
  if (nikkeiArticles.length) sourceCounts['日経'] = nikkeiArticles.length;
  if (ftArticles.length) sourceCounts['FT'] = ftArticles.length;
  const m3Articles = bySource['m3'] || [];
  const mtArticles = bySource['medical_tribune'] || [];
  if (m3Articles.length) sourceCounts['m3.com'] = m3Articles.length;
  if (mtArticles.length) sourceCounts['Medical Tribune'] = mtArticles.length;
  // Group manual articles by their original source name (e.g. 日経, FT)
  for (const a of manualSrcArticles) {
    const name = a._manualSource || 'Manual';
    sourceCounts[name] = (sourceCounts[name] || 0) + 1;
  }

  const pillsHTML = Object.entries(sourceCounts).map(([name, count]) =>
    `<span class="source-pill">${escapeHtml(name)} <b>${count}</b></span>`
  ).join('\n');

  // Morning content grouped by priority (参考 is collapsible)
  const morningHTML = [
    morningHigh.length > 0 ? `<div class="section-label">要対応 — 経営判断に直結</div>\n${renderCards(morningHigh)}` : '',
    morningMid.length > 0 ? `<div class="section-label">要注視 — 中期的に影響</div>\n${renderCards(morningMid)}` : '',
    morningInfo.length > 0 ? `<details class="collapsible-section"><summary class="section-label" style="cursor:pointer">参考情報（${morningInfo.length}件）</summary>\n${renderCards(morningInfo)}</details>` : '',
  ].filter(Boolean).join('\n');

  // Papers grouped by specialty (PubMed only, max 5 per category, priority sorted)
  // Exclude medical_ai category (shown in Tech tab)
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

  // Papers tab count (excluding medical_ai)
  const papersCount = Object.values(specialtyMap).reduce((sum, items) => sum + Math.min(items.length, 5), 0);

  // Alerts (MHLW only, all items)
  const alertsHTML = mhlwArticles.length > 0
    ? `<div class="section-label">厚労省トピックス</div>\n${renderCards(mhlwArticles)}`
    : '<div class="empty-state">制度アラートはありません。</div>';

  // Tech: HackerNews + PubMed medical_ai category, max 10
  const medicalAiArticles = pubmedArticles.filter(p => p._category === 'medical_ai');
  const techItems = sortByPriority([...hnArticles, ...medicalAiArticles]).slice(0, 10);
  const techHTML = techItems.length > 0
    ? renderCards(techItems)
    : '<div class="empty-state">テック記事はありません。</div>';

  res.send(`${layoutHead(`Briefing ${date}`)}
<body>
${layoutHeader('')}
<div class="container">
  <div class="date-nav">${dateNav}</div>
  <div class="source-pills">${pillsHTML}</div>
  <div class="tabs">
    <div class="tab active" onclick="showTab(this,'morning')">朝ブリーフィング<span class="badge">${morningCount}</span></div>
    <div class="tab" onclick="showTab(this,'pubmed')">論文ダイジェスト<span class="badge">${papersCount}</span></div>
    <div class="tab" onclick="showTab(this,'alert')">制度アラート<span class="badge">${mhlwArticles.length}</span></div>
    <div class="tab" onclick="showTab(this,'tech')">テック・AI<span class="badge">${techItems.length}</span></div>
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
    自動生成: Claude Code + PubMed + 厚労省 + HN + Medscape + Fierce + CareNet + 手動追加
  </div>
</div>
${clientScript()}
</body></html>`);
});

// Search
app.get('/search', (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    return res.redirect('/');
  }

  const dates = listBriefingDates();
  const readStatus = loadReadStatus();
  const results = [];
  const queryLower = query.toLowerCase();

  for (const date of dates) {
    const data = loadEnrichedData(date);
    if (!data) continue;
    const articles = getAllArticles(data);
    for (const article of articles) {
      const searchText = [
        article.title, article.summary_ja, article.abstract,
        article.memo, article.impact, article.source, article.journal
      ].filter(Boolean).join(' ').toLowerCase();
      if (searchText.includes(queryLower)) {
        results.push({ ...article, _date: date });
      }
    }
  }

  const cardsHTML = results.map(a => {
    const dateLabel = `<div style="font-size:11px;color:var(--sub);margin-bottom:4px">${escapeHtml(a._date)}</div>`;
    return dateLabel + renderCardHTML(a);
  }).join('\n');

  res.send(`${layoutHead(`Search: ${query}`)}
<body>
${layoutHeader('/search')}
<div class="container">
  <div class="search-results-info">
    <b>"${escapeHtml(query)}"</b> の検索結果: ${results.length} 件（${dates.length} 日分を検索）
  </div>
  ${results.length > 0 ? cardsHTML : '<div class="empty-state">該当する記事が見つかりませんでした。</div>'}
</div>
${clientScript()}
</body></html>`);
});

// API: Toggle read status
app.post('/api/read-status', (req, res) => {
  const { id, read } = req.body;
  if (!id || typeof read !== 'boolean') {
    return res.status(400).json({ error: 'id and read (boolean) required' });
  }
  const status = loadReadStatus();
  if (read) {
    status[id] = true;
  } else {
    delete status[id];
  }
  saveReadStatus(status);
  res.json({ ok: true });
});

// API: Add articles (from Claude in Chrome etc.)
app.post('/api/add-articles', (req, res) => {
  let articles = req.body;
  if (!Array.isArray(articles)) {
    if (articles && Array.isArray(articles.articles)) {
      articles = articles.articles;
    } else {
      return res.status(400).json({ error: 'Request body must be a JSON array of articles' });
    }
  }

  const manual = loadManualArticles();
  let count = 0;

  for (const article of articles) {
    if (!article.title) continue;
    const date = article.date || new Date().toISOString().split('T')[0];
    if (!manual[date]) manual[date] = [];

    // Deduplicate by URL or title
    const isDuplicate = manual[date].some(a =>
      (a.url && a.url === article.url) || a.title === article.title
    );
    if (isDuplicate) continue;

    manual[date].push({
      title: article.title,
      url: article.url || '',
      source: article.source || 'Manual',
      date,
      summary_ja: article.summary_ja || '',
      priority: article.priority || '参考',
      impact: article.impact || '',
      memo: article.memo || '',
      category: article.category || 'news',
    });
    count++;
  }

  saveManualArticles(manual);
  res.json({ success: true, count });
});

// API: Debug form for manual article addition
app.get('/api/add-articles', (req, res) => {
  res.send(`${layoutHead('Add Articles — Debug')}
<body>
${layoutHeader('')}
<div class="container">
  <h2 style="font-size:16px;margin-bottom:16px;">Debug: Add Articles (JSON)</h2>
  <textarea id="json-input" style="width:100%;height:300px;font-family:monospace;font-size:13px;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:12px;" placeholder='[{"title":"...","url":"...","source":"日経","date":"2026-03-22","summary_ja":"...","priority":"要注視","impact":"...","memo":"...","category":"news"}]'></textarea>
  <button onclick="submitArticles()" style="padding:10px 24px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;font-weight:500;">送信</button>
  <div id="result" style="margin-top:16px;font-size:14px;"></div>
</div>
<script>
function submitArticles() {
  const text = document.getElementById('json-input').value.trim();
  let data;
  try { data = JSON.parse(text); } catch(e) { document.getElementById('result').textContent = 'JSON parse error: ' + e.message; return; }
  fetch('/api/add-articles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).then(r => r.json()).then(d => {
    document.getElementById('result').innerHTML = d.success
      ? '<span style="color:var(--accent)">OK: ' + d.count + ' articles added</span>'
      : '<span style="color:var(--red)">Error: ' + (d.error || 'unknown') + '</span>';
  }).catch(e => {
    document.getElementById('result').textContent = 'Network error: ' + e.message;
  });
}
</script>
</body></html>`);
});

// Bookmarklet page: Claude in Chrome prompts + paste form
app.get('/bookmarklet', (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const nikkeiPrompt = `このページから、以下の診療科に関連するニュースをピックアップしてください：
- 内科（糖尿病・循環器・一般）
- 耳鼻咽喉科
- 小児科
- 消化器内科・外科
- 医療経営・制度
- テクノロジー・AI
- 経済・金融（医療セクターに影響するもの）

以下のJSON形式で出力してください。必ずJSON配列のみを出力し、他のテキストは含めないでください：
[
  {
    "title": "記事タイトル",
    "url": "記事URL",
    "source": "日経",
    "date": "${today}",
    "summary_ja": "日本語要約（2文以内）",
    "priority": "要注視",
    "impact": "理事長として取るべきアクション",
    "memo": "理事長メモ",
    "category": "news"
  }
]`;

  const ftPrompt = nikkeiPrompt.replace(/"source": "日経"/g, '"source": "FT"');

  res.send(`${layoutHead('記事追加 — Claude in Chrome')}
<body>
${layoutHeader('/bookmarklet')}
<div class="container">
  <h2 style="font-size:18px;margin-bottom:8px;">Claude in Chrome で記事を収集</h2>
  <p style="font-size:13px;color:var(--sub);margin-bottom:24px;line-height:1.7;">日経・FTなどのニュースサイトで Claude in Chrome を開き、以下のプロンプトを貼り付けて実行。出力されたJSONを下のフォームに貼り付けて送信します。</p>

  <div style="display:grid;gap:16px;margin-bottom:32px;">
    <div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px 20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span style="font-size:14px;font-weight:700;">日経新聞</span>
        <button onclick="copyPrompt('nikkei')" style="font-size:12px;padding:5px 14px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;">コピー</button>
      </div>
      <pre id="nikkei-prompt" style="font-size:11.5px;line-height:1.6;white-space:pre-wrap;background:var(--bg);padding:14px;border-radius:8px;border:1px solid var(--border);max-height:200px;overflow-y:auto;">${escapeHtml(nikkeiPrompt)}</pre>
    </div>

    <div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px 20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span style="font-size:14px;font-weight:700;">Financial Times</span>
        <button onclick="copyPrompt('ft')" style="font-size:12px;padding:5px 14px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:500;">コピー</button>
      </div>
      <pre id="ft-prompt" style="font-size:11.5px;line-height:1.6;white-space:pre-wrap;background:var(--bg);padding:14px;border-radius:8px;border:1px solid var(--border);max-height:200px;overflow-y:auto;">${escapeHtml(ftPrompt)}</pre>
    </div>
  </div>

  <h3 style="font-size:15px;margin-bottom:12px;">JSON貼り付け & 送信</h3>
  <textarea id="json-input" style="width:100%;height:250px;font-family:monospace;font-size:12.5px;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--card);resize:vertical;line-height:1.6;" placeholder="Claude in Chrome の出力をここに貼り付けてください..."></textarea>
  <div style="display:flex;align-items:center;gap:12px;margin-top:12px;">
    <button onclick="submitArticles()" style="padding:10px 28px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;font-weight:600;">ブリーフィングに追加</button>
    <span id="result" style="font-size:13px;"></span>
  </div>
</div>
<script>
function copyPrompt(type) {
  const el = document.getElementById(type + '-prompt');
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = el.parentElement.querySelector('button');
    btn.textContent = 'コピーしました';
    setTimeout(() => btn.textContent = 'コピー', 2000);
  });
}
function submitArticles() {
  const text = document.getElementById('json-input').value.trim();
  if (!text) return;

  // Try to extract JSON array from text (handle markdown code blocks)
  let jsonText = text;
  // Strip markdown code blocks if present
  jsonText = jsonText.replace(/^\u0060\u0060\u0060(?:json)?\\s*/, '').replace(/\\s*\u0060\u0060\u0060\\s*$/, '');

  let data;
  try { data = JSON.parse(jsonText); } catch(e) {
    document.getElementById('result').innerHTML = '<span style="color:var(--red);">JSON解析エラー: ' + e.message + '</span>';
    return;
  }

  fetch('/api/add-articles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).then(r => r.json()).then(d => {
    if (d.success) {
      document.getElementById('result').innerHTML =
        '<span style="color:var(--accent);">OK ' + d.count + '件追加しました。<a href="/" style="color:var(--accent);font-weight:600;margin-left:8px;">ブリーフィングを確認 &rarr;</a></span>';
      document.getElementById('json-input').value = '';
    } else {
      document.getElementById('result').innerHTML = '<span style="color:var(--red);">エラー: ' + (d.error || 'unknown') + '</span>';
    }
  }).catch(e => {
    document.getElementById('result').innerHTML = '<span style="color:var(--red);">通信エラー: ' + e.message + '</span>';
  });
}
</script>
</body></html>`);
});

// Start server
app.listen(PORT, () => {
  console.log(`\n管理くんニュース Server`);
  console.log(`http://localhost:${PORT}`);
  console.log(`\nPress Ctrl+C to stop.\n`);
});
