#!/usr/bin/env node

/**
 * 自動ブリーフィング — データ収集 → 事前フィルタ → Claude API要約 → enriched_data保存 → HTML生成
 *
 * 最適化:
 *   - キーワードスコアリングで日次ニュースを上位20件に絞り込み
 *   - PubMed論文は高インパクトジャーナル優先で各カテゴリ3件
 *   - API送信は合計30〜35件（109件→大幅削減）
 *   - 全体タイムアウト20分
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const WEEKLY_PAPERS_PATH = path.join(OUTPUT_DIR, 'weekly_papers.json');
const NODE_BIN = process.execPath;
const GLOBAL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

// --- Keyword scoring for news pre-filter ---

const HIGH_KEYWORDS = ['診療報酬', '医療安全', '薬価', '厚労省', '新薬承認', 'ガイドライン', 'GLP-1', 'SGLT2'];
const MID_KEYWORDS = ['医療', '病院', 'クリニック', '製薬', '介護', '感染症', 'ワクチン', '糖尿病', 'がん', 'AI', 'DX'];
const LOW_KEYWORDS = ['健康', '保険', '検診', '予防', '治療', '研究', '臨床'];

function scoreArticle(article) {
  const text = `${article.title || ''} ${article.description || ''}`.toLowerCase();
  let score = 0;
  for (const kw of HIGH_KEYWORDS) { if (text.includes(kw.toLowerCase())) score += 5; }
  for (const kw of MID_KEYWORDS) { if (text.includes(kw.toLowerCase())) score += 3; }
  for (const kw of LOW_KEYWORDS) { if (text.includes(kw.toLowerCase())) score += 1; }
  return score;
}

function assignFallbackPriority(article) {
  const text = `${article.title || ''} ${article.description || ''}`;
  const hasHighKeyword = HIGH_KEYWORDS.some(kw => text.includes(kw));
  const hasMidKeyword = MID_KEYWORDS.some(kw => text.includes(kw));
  article.priority = article.priority || (hasHighKeyword ? '要注視' : hasMidKeyword ? '要注視' : '参考');
  article.summary_ja = article.summary_ja || article.title;
  article.impact = article.impact || '';
  article.memo = article.memo || '';
}

// --- PubMed journal-based filtering ---

const TOP_JOURNALS = [
  'N Engl J Med', 'NEJM', 'Lancet', 'JAMA', 'BMJ', 'Nature Medicine',
  'Nature', 'Science', 'Ann Intern Med', 'Circulation', 'Eur Heart J',
  'Gut', 'Gastroenterology', 'Hepatology', 'Diabetes Care', 'Diabetologia',
  'J Allergy Clin Immunol', 'Pediatrics', 'JAMA Pediatr', 'JAMA Intern Med',
  'JAMA Otolaryngol', 'Otolaryngol Head Neck Surg', 'Laryngoscope',
  'J Clin Oncol', 'Lancet Oncol', 'Ann Surg', 'Br J Surg',
  'NPJ Digit Med', 'Lancet Digit Health',
];

function isTopJournal(article) {
  const journal = (article.journal || article.source || '').toLowerCase();
  return TOP_JOURNALS.some(j => journal.includes(j.toLowerCase()));
}

function filterPubmedForAPI(pubmedData) {
  const apiArticles = [];
  const fallbackArticles = [];

  for (const [key, catData] of Object.entries(pubmedData)) {
    const articles = catData.articles || [];
    // Sort: top journals first
    const sorted = [...articles].sort((a, b) => {
      const aTop = isTopJournal(a) ? 0 : 1;
      const bTop = isTopJournal(b) ? 0 : 1;
      return aTop - bTop;
    });

    const forAPI = sorted.slice(0, 3);
    const rest = sorted.slice(3);

    for (const a of forAPI) {
      a._pubmedKey = key;
      a.source = a.source || 'PubMed';
      a.specialty = a.specialty || catData.label;
      a.category = 'paper';
      apiArticles.push(a);
    }
    for (const a of rest) {
      a._pubmedKey = key;
      a.source = a.source || 'PubMed';
      a.specialty = a.specialty || catData.label;
      a.category = 'paper';
      // Mechanical fallback
      a.priority = a.priority || (catData.priority === 'high' ? '要注視' : '参考');
      a.summary_ja = a.summary_ja || (a.abstract || '').substring(0, 200);
      a.impact = a.impact || '';
      a.memo = a.memo || '';
      fallbackArticles.push(a);
    }
  }

  return { apiArticles, fallbackArticles };
}

// --- Main ---

function isMonday() {
  return new Date().getDay() === 1;
}

async function main() {
  const startTime = Date.now();
  const deadlineMs = startTime + GLOBAL_TIMEOUT_MS;
  const monday = isMonday();
  const modeLabel = monday ? '週次（フル）' : '日次';

  console.log('═══════════════════════════════════════════════');
  console.log('  Auto Briefing — 自動ブリーフィング開始');
  console.log(`  ${new Date().toLocaleString('ja-JP')}  [${modeLabel}]`);
  console.log('═══════════════════════════════════════════════');

  // 1. データ収集
  console.log('\n[1/4] データ収集中...');
  const collectArgs = monday ? '--weekly --no-summary' : '--no-summary';
  try {
    execSync(`"${NODE_BIN}" src/collect.js ${collectArgs}`, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: { ...process.env },
    });
  } catch (e) {
    console.error('データ収集に失敗しました:', e.message);
    process.exit(1);
  }

  // 2. raw_data.json を読み込み
  const rawDataPath = path.join(OUTPUT_DIR, 'raw_data.json');
  if (!fs.existsSync(rawDataPath)) {
    console.error('raw_data.json が見つかりません。');
    process.exit(1);
  }
  const rawData = JSON.parse(fs.readFileSync(rawDataPath, 'utf8'));

  // 月曜以外: PubMed/arXivを前回の週次データで補完
  if (!monday) {
    if (fs.existsSync(WEEKLY_PAPERS_PATH)) {
      console.log('  前回の週次データ (weekly_papers.json) を再利用します');
      const weeklyData = JSON.parse(fs.readFileSync(WEEKLY_PAPERS_PATH, 'utf8'));
      if (weeklyData.pubmed && !rawData.pubmed) rawData.pubmed = weeklyData.pubmed;
      if (weeklyData.arxiv && (!rawData.arxiv || rawData.arxiv.length === 0)) rawData.arxiv = weeklyData.arxiv;
    } else {
      console.log('  weekly_papers.json が見つかりません。PubMed/arXivデータなしで続行します。');
    }
  }

  // 3. Claude APIで要約・優先度判定（事前フィルタ付き）
  console.log('\n[2/4] Claude APIで記事を評価中...');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY が設定されていません。');
    console.log('デフォルト優先度でenriched_dataを生成します。');
    assignDefaultPriorities(rawData);
  } else {
    const configPath = path.join(PROJECT_ROOT, 'config', 'settings.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const { summarizeArticles } = require('./summarize');

    // --- PubMed: journal-based filtering ---
    let pubmedApiArticles = [];
    if (rawData.pubmed) {
      const { apiArticles, fallbackArticles } = filterPubmedForAPI(rawData.pubmed);
      pubmedApiArticles = apiArticles;
      console.log(`  PubMed: ${apiArticles.length} 件をAPI送信, ${fallbackArticles.length} 件はデフォルト優先度`);

      // Write fallback articles back to rawData
      for (const a of fallbackArticles) {
        if (rawData.pubmed[a._pubmedKey]) {
          const articles = rawData.pubmed[a._pubmedKey].articles;
          const idx = articles.findIndex(x => x.pmid === a.pmid || x.title === a.title);
          if (idx >= 0) articles[idx] = { ...articles[idx], priority: a.priority, summary_ja: a.summary_ja, impact: a.impact, memo: a.memo };
        }
      }
    }

    // --- News: keyword scoring + top 20 filter ---
    const allNewsRaw = [];
    const newsSourceKeys = ['mhlw', 'hackernews', 'arxiv', 'medscape', 'fierce', 'carenet', 'nikkei', 'ft', 'm3', 'medical_tribune'];
    const sourceLabels = {
      mhlw: '厚労省', hackernews: 'HackerNews', arxiv: 'arXiv', medscape: 'Medscape',
      fierce: 'Fierce', carenet: 'CareNet', nikkei: '日経', ft: 'FT', m3: 'm3.com', medical_tribune: 'Medical Tribune',
    };

    for (const key of newsSourceKeys) {
      if (rawData[key]) {
        for (const article of rawData[key]) {
          article.source = article.source || sourceLabels[key] || key;
          if (key === 'nikkei' || key === 'ft') article._rssOnly = true;
          article._sourceKey = key;
          allNewsRaw.push(article);
        }
      }
    }

    // Score and sort
    const scored = allNewsRaw.map(a => ({ article: a, score: scoreArticle(a) }));
    scored.sort((a, b) => b.score - a.score);

    const newsForAPI = [];      // score >= 3, top 20
    const newsLowScore = [];    // score 1-2: fallback priority
    const newsExcluded = [];    // score 0: excluded

    for (const { article, score } of scored) {
      if (score === 0) {
        article.priority = '除外';
        article.summary_ja = article.title;
        article.impact = '';
        article.memo = '';
        newsExcluded.push(article);
      } else if (score <= 2) {
        assignFallbackPriority(article);
        newsLowScore.push(article);
      } else if (newsForAPI.length < 20) {
        newsForAPI.push(article);
      } else {
        assignFallbackPriority(article);
        newsLowScore.push(article);
      }
    }

    console.log(`  News: ${newsForAPI.length} 件をAPI送信, ${newsLowScore.length} 件はデフォルト優先度, ${newsExcluded.length} 件は除外`);
    console.log(`  合計API送信: ${pubmedApiArticles.length + newsForAPI.length} 件`);

    // Write fallback/excluded news back to rawData immediately
    for (const a of [...newsLowScore, ...newsExcluded]) {
      const key = a._sourceKey;
      if (rawData[key]) {
        const idx = rawData[key].findIndex(x => x.title === a.title);
        if (idx >= 0) rawData[key][idx] = { ...rawData[key][idx], priority: a.priority, summary_ja: a.summary_ja, impact: a.impact, memo: a.memo };
      }
    }

    // --- Call API for filtered articles ---
    try {
      if (pubmedApiArticles.length > 0) {
        const summarized = await summarizeArticles(pubmedApiArticles, config, { deadlineMs });
        for (const s of summarized) {
          if (s._pubmedKey && rawData.pubmed[s._pubmedKey]) {
            const articles = rawData.pubmed[s._pubmedKey].articles;
            const idx = articles.findIndex(a => a.pmid === s.pmid || a.title === s.title);
            if (idx >= 0) articles[idx] = { ...articles[idx], priority: s.priority, summary_ja: s.summary_ja, impact: s.impact, memo: s.memo };
          }
        }
      }

      if (newsForAPI.length > 0) {
        const summarizedNews = await summarizeArticles(newsForAPI, config, { deadlineMs });

        // Build maps for writing back
        const maps = {};
        for (const key of newsSourceKeys) {
          maps[key] = new Map((rawData[key] || []).map((a, i) => [a.title, i]));
        }

        for (const s of summarizedNews) {
          const key = s._sourceKey;
          if (key && maps[key] && maps[key].has(s.title)) {
            const idx = maps[key].get(s.title);
            const enrichFields = { priority: s.priority, summary_ja: s.summary_ja, impact: s.impact, memo: s.memo };
            rawData[key][idx] = { ...rawData[key][idx], ...enrichFields };
          }
        }
      }
    } catch (e) {
      console.error('Claude API呼び出しに失敗:', e.message);
      console.log('残りの記事にデフォルト優先度を割り当てます。');
      assignDefaultPriorities(rawData);
    }
  }

  // 4. enriched_data.json を保存
  console.log('\n[3/4] enriched_data.json を保存中...');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const enrichedPath = path.join(OUTPUT_DIR, 'enriched_data.json');
  fs.writeFileSync(enrichedPath, JSON.stringify(rawData, null, 2), 'utf8');
  console.log(`保存完了: ${enrichedPath}`);

  // 月曜: PubMed/arXiv データを weekly_papers.json に保存
  if (monday) {
    const weeklyData = {};
    if (rawData.pubmed) weeklyData.pubmed = rawData.pubmed;
    if (rawData.arxiv) weeklyData.arxiv = rawData.arxiv;
    fs.writeFileSync(WEEKLY_PAPERS_PATH, JSON.stringify(weeklyData, null, 2), 'utf8');
    console.log(`週次データ保存: ${WEEKLY_PAPERS_PATH}`);
  }

  // 5. HTML生成
  console.log('\n[4/4] HTML生成中...');
  try {
    execSync(`"${NODE_BIN}" src/render.js ${enrichedPath}`, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: { ...process.env },
    });
  } catch (e) {
    console.error('HTML生成に失敗:', e.message);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  自動ブリーフィング完了 (${elapsed}秒)`);
  console.log(`═══════════════════════════════════════════════\n`);
}

function assignDefaultPriorities(data) {
  if (data.pubmed) {
    for (const [key, catData] of Object.entries(data.pubmed)) {
      for (const article of (catData.articles || [])) {
        if (!article.priority) {
          article.priority = catData.priority === 'high' ? '要注視' : '参考';
          article.summary_ja = article.summary_ja || (article.abstract || '').substring(0, 200);
          article.impact = article.impact || '';
          article.memo = article.memo || '';
        }
      }
    }
  }
  for (const key of ['mhlw', 'hackernews', 'arxiv', 'medscape', 'fierce', 'carenet', 'nikkei', 'ft', 'm3', 'medical_tribune']) {
    if (data[key]) {
      for (const article of data[key]) {
        if (!article.priority) {
          article.priority = '参考';
          article.summary_ja = article.summary_ja || article.title;
          article.impact = article.impact || '';
          article.memo = article.memo || '';
        }
      }
    }
  }
}

main().catch(e => {
  console.error('自動ブリーフィング失敗:', e.message);
  process.exit(1);
});
