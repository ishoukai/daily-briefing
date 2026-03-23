/**
 * HTMLブリーフィングを生成
 */

const fs = require('fs');
const path = require('path');

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

function displayTitle(item) {
  const title = stripHtmlTags(item.title);
  if (title && /^[A-Za-z0-9\s\-:,.'"\(\)\[\]\/]+$/.test(title) && item.summary_ja) {
    return item.summary_ja.split('。')[0] + '。';
  }
  return title;
}

function renderCard(item) {
  const impact = item.impact
    ? `<div class="impact">${escapeHtml(item.impact)}</div>`
    : '';
  return `<div class="card">
  <div class="card-head">
    <h3>${escapeHtml(displayTitle(item))}</h3>
    <span class="priority ${priorityClass(item.priority)}">${escapeHtml(item.priority)}</span>
  </div>
  <div class="source-line">
    <span class="source">${escapeHtml(item.source || item.journal || '')} — ${escapeHtml(item.date || '')}</span>
    ${item.url ? `<a class="link-btn" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">原文を読む ↗</a>` : ''}
  </div>
  <div class="body">${escapeHtml(item.summary_ja || item.abstract || '')}</div>
  ${impact}
</div>`;
}

function renderPaper(item) {
  const memo = item.memo
    ? `<div class="takeaway"><strong>理事長メモ:</strong> ${escapeHtml(item.memo)}</div>`
    : '';
  return `<div class="paper">
  <div class="journal-line">
    <span class="journal">${escapeHtml(item.journal || item.source || '')}</span>
    ${item.url ? `<a class="link-btn" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">原文 ↗</a>` : ''}
  </div>
  <h3>${escapeHtml(item.title)}</h3>
  <div class="authors">${escapeHtml(item.authors || '')}</div>
  <div class="abstract">${escapeHtml(item.summary_ja || item.abstract || '')}</div>
  ${memo}
</div>`;
}

function renderSection(label) {
  return `<div class="section-label">${escapeHtml(label)}</div>`;
}

function generateHTML(data) {
  const { date, sourceCounts } = data;

  // 「除外」記事を全タブから非表示
  const morning = (data.morning || []).filter(i => i.priority !== '除外');
  const papers = (data.papers || []).filter(i => i.priority !== '除外');
  const alerts = (data.alerts || []).filter(i => i.priority !== '除外');
  const tech = (data.tech || []).filter(i => i.priority !== '除外');

  // Priority sort helper
  const priorityOrder = { '要対応': 0, '要注視': 1, '参考': 2 };
  const sortByPriority = (items) => [...items].sort((a, b) =>
    (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3)
  );

  // Morning: 要対応=全件、要注視=最大10件、参考=最大5件(折りたたみ)、合計20件上限
  const mHigh = morning.filter(i => i.priority === '要対応');
  const mMid = morning.filter(i => i.priority === '要注視').slice(0, 10);
  const remainingSlots = Math.max(0, 20 - mHigh.length - mMid.length);
  const mInfo = morning.filter(i => i.priority === '参考').slice(0, Math.min(5, remainingSlots));

  const nHigh = mHigh.length;
  const nMid = mMid.length;
  const nInfo = mInfo.length;

  const morningHTML = [
    nHigh > 0 ? renderSection('要対応 — 経営判断に直結') + '\n' + mHigh.map(renderCard).join('\n') : '',
    nMid > 0 ? renderSection('要注視 — 中期的に影響') + '\n' + mMid.map(renderCard).join('\n') : '',
    nInfo > 0 ? `<details class="collapsible-section"><summary class="section-label" style="cursor:pointer">${escapeHtml('参考情報（' + nInfo + '件）')}</summary>\n${mInfo.map(renderCard).join('\n')}</details>` : '',
  ].filter(Boolean).join('\n');

  // Papers: grouped by specialty, max 5 per category, priority sorted
  const specialtyMap = {};
  for (const p of papers) {
    const key = p.specialty || p.label || '一般';
    if (!specialtyMap[key]) specialtyMap[key] = [];
    specialtyMap[key].push(p);
  }
  const papersHTML = Object.entries(specialtyMap).map(([label, items]) => {
    const sorted = sortByPriority(items).slice(0, 5);
    return renderSection(label) + '\n' + sorted.map(renderPaper).join('\n');
  }).join('\n');

  // Alerts: all items
  const alertsHTML = alerts.length > 0
    ? renderSection('厚労省トピックス') + '\n' + alerts.map(renderCard).join('\n')
    : '';

  // Tech: max 10 items
  const techSorted = sortByPriority(tech).slice(0, 10);
  const techHTML = techSorted.length > 0
    ? techSorted.map(renderCard).join('\n')
    : '';

  // Source count pills
  const pillsHTML = Object.entries(sourceCounts || {}).map(([name, count]) =>
    `<span class="source-pill">${escapeHtml(name)} <b>${count}</b></span>`
  ).join('\n      ');

  // Read template
  const templatePath = path.join(__dirname, '..', 'templates', 'briefing.html');
  let template = fs.readFileSync(templatePath, 'utf8');

  // Replace placeholders (replaceAll to handle duplicates in template)
  const papersCount = Object.values(specialtyMap).reduce((sum, items) => sum + Math.min(items.length, 5), 0);
  const replacements = {
    '{{DATE}}': date || new Date().toLocaleDateString('ja-JP'),
    '{{SOURCE_PILLS}}': pillsHTML,
    '{{N_MORNING}}': String(nHigh + nMid + nInfo),
    '{{N_PAPERS}}': String(papersCount),
    '{{N_ALERTS}}': String(alerts.length),
    '{{N_TECH}}': String(techSorted.length),
    '{{N_HIGH}}': String(nHigh),
    '{{N_MID}}': String(nMid),
    '{{N_INFO}}': String(nInfo),
    '{{MORNING_CONTENT}}': morningHTML,
    '{{PUBMED_CONTENT}}': papersHTML,
    '{{ALERT_CONTENT}}': alertsHTML,
    '{{TECH_CONTENT}}': techHTML,
  };
  for (const [key, value] of Object.entries(replacements)) {
    template = template.replaceAll(key, value);
  }

  return template;
}

function saveHTML(htmlContent, outputDir) {
  const date = new Date().toISOString().split('T')[0];
  const filename = `briefing_${date}.html`;
  const filepath = path.join(outputDir, filename);
  
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filepath, htmlContent, 'utf8');
  
  console.log(`\n✅ ブリーフィングを生成しました: ${filepath}`);
  return filepath;
}

// CLI mode: node src/render.js output/enriched_data.json
if (require.main === module) {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('使い方: node src/render.js <enriched_data.json>');
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  // Flatten all articles from enriched data
  const allPapers = [];
  const allNews = [];
  const allTech = [];
  const sourceCounts = {};

  // PubMed (medical_ai goes to tech, rest to papers)
  if (data.pubmed) {
    let pubmedCount = 0;
    for (const [key, catData] of Object.entries(data.pubmed)) {
      for (const article of (catData.articles || [])) {
        article.source = article.source || 'PubMed';
        article.specialty = article.specialty || catData.label;
        article.category = article.category || 'paper';
        if (key === 'medical_ai') {
          allTech.push(article);
        } else {
          allPapers.push(article);
        }
      }
      pubmedCount += (catData.articles || []).length;
    }
    sourceCounts['PubMed'] = pubmedCount;
  }

  // MHLW
  if (data.mhlw && data.mhlw.length > 0) {
    allNews.push(...data.mhlw.map(i => ({ ...i, source: i.source || '厚労省' })));
    sourceCounts['厚労省'] = data.mhlw.length;
  }

  // Medscape
  if (data.medscape && data.medscape.length > 0) {
    allNews.push(...data.medscape.map(i => ({ ...i, source: i.source || 'Medscape' })));
    sourceCounts['Medscape'] = data.medscape.length;
  }

  // Fierce Healthcare
  if (data.fierce && data.fierce.length > 0) {
    allNews.push(...data.fierce.map(i => ({ ...i, source: i.source || 'Fierce' })));
    sourceCounts['Fierce'] = data.fierce.length;
  }

  // CareNet
  if (data.carenet && data.carenet.length > 0) {
    allNews.push(...data.carenet.map(i => ({ ...i, source: i.source || 'CareNet' })));
    sourceCounts['CareNet'] = data.carenet.length;
  }

  // Nikkei
  if (data.nikkei && data.nikkei.length > 0) {
    const techKeywords = /AI|人工知能|テク|DX|デジタル|ロボ|半導体|クラウド|サイバー|IT|IoT|ブロックチェーン/i;
    for (const item of data.nikkei) {
      const enriched = { ...item, source: item.source || '日経' };
      if (techKeywords.test(item.title || '') || techKeywords.test(item.description || '')) {
        allTech.push(enriched);
      } else {
        allNews.push(enriched);
      }
    }
    sourceCounts['日経'] = data.nikkei.length;
  }

  // FT
  if (data.ft && data.ft.length > 0) {
    const techKeywords = /AI|artificial intelligence|tech|robot|chip|semiconductor|cyber|digital|cloud|OpenAI|Anthropic|Google DeepMind|Meta AI/i;
    for (const item of data.ft) {
      const enriched = { ...item, source: item.source || 'FT' };
      if (techKeywords.test(item.title || '') || techKeywords.test(item.description || '')) {
        allTech.push(enriched);
      } else {
        allNews.push(enriched);
      }
    }
    sourceCounts['FT'] = data.ft.length;
  }

  // m3.com
  if (data.m3 && data.m3.length > 0) {
    allNews.push(...data.m3.map(i => ({ ...i, source: i.source || 'm3.com' })));
    sourceCounts['m3.com'] = data.m3.length;
  }

  // Medical Tribune
  if (data.medical_tribune && data.medical_tribune.length > 0) {
    allNews.push(...data.medical_tribune.map(i => ({ ...i, source: i.source || 'Medical Tribune' })));
    sourceCounts['Medical Tribune'] = data.medical_tribune.length;
  }

  // HackerNews
  if (data.hackernews && data.hackernews.length > 0) {
    allTech.push(...data.hackernews.map(i => ({ ...i, priority: i.priority || 'テック', section: '医療AI・テック' })));
    sourceCounts['HackerNews'] = data.hackernews.length;
  }

  // arXiv
  if (data.arxiv && data.arxiv.length > 0) {
    allTech.push(...data.arxiv.map(i => ({ ...i, priority: i.priority || 'テック', section: 'arXiv新着' })));
    sourceCounts['arXiv'] = data.arxiv.length;
  }

  // Categorize
  // Morning: ニュース系のみ（PubMed/arXiv/厚労省は専用タブのみ）
  const allItems = [...allNews, ...allPapers, ...allTech];
  const morning = [...allNews.filter(i => !(i.source || '').includes('厚労省')), ...allTech];

  // Alerts: MHLW only
  const alerts = allNews.filter(i => (i.source || '').includes('厚労省'));

  const today = new Date();
  const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][today.getDay()];
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日（${dayOfWeek}）`;

  const htmlContent = generateHTML({
    morning: morning.length > 0 ? morning : allNews.concat(allPapers.slice(0, 5)),
    papers: allPapers,
    alerts,
    tech: allTech,
    date: dateStr,
    sourceCounts,
  });

  const configPath = path.join(__dirname, '..', 'config', 'settings.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const outputDir = path.resolve(path.join(__dirname, '..', config.output.dir));
  const filepath = saveHTML(htmlContent, outputDir);
  console.log(filepath);
}

module.exports = { generateHTML, saveHTML };
