#!/usr/bin/env node

/**
 * 自動ブリーフィング — データ収集 → 事前フィルタ → Claude API要約 → enriched_data保存 → HTML生成
 *
 * 曜日分散:
 *   月曜・木曜: 制度アラート重点日（厚労省をAPI要約）
 *   水曜: テック・AI重点日（arXiv取得 + HNをAPI要約）
 *   金曜: 論文ダイジェスト日（PubMed全カテゴリ取得 → API要約）
 *   火・土・日: ニュース上位20件のみAPI送信
 *
 * 週次キャッシュ:
 *   output/weekly_papers.json  — 金曜に保存
 *   output/weekly_tech.json    — 水曜に保存
 *   output/weekly_alerts.json  — 月・木に保存
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const WEEKLY_PAPERS_PATH = path.join(OUTPUT_DIR, 'weekly_papers.json');
const WEEKLY_TECH_PATH = path.join(OUTPUT_DIR, 'weekly_tech.json');
const WEEKLY_ALERTS_PATH = path.join(OUTPUT_DIR, 'weekly_alerts.json');
const NODE_BIN = process.execPath;
const GLOBAL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

// --- Day-of-week schedule ---

function getDaySchedule() {
  const dayOfWeek = new Date().getDay(); // 0=日, 1=月, ..., 6=土
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  return {
    dayOfWeek,
    dayName: dayNames[dayOfWeek],
    isAlertDay: dayOfWeek === 1 || dayOfWeek === 4,  // 月・木
    isTechDay: dayOfWeek === 3,                       // 水
    isPaperDay: dayOfWeek === 5,                      // 金
  };
}

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
  article.priority = article.priority || (hasHighKeyword || hasMidKeyword ? '要注視' : '参考');
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
      a.priority = a.priority || (catData.priority === 'high' ? '要注視' : '参考');
      a.summary_ja = a.summary_ja || (a.abstract || '').substring(0, 200);
      a.impact = a.impact || '';
      a.memo = a.memo || '';
      fallbackArticles.push(a);
    }
  }

  return { apiArticles, fallbackArticles };
}

// --- Helpers ---

function loadJSON(filepath) {
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) { /* ignore */ }
  return null;
}

function saveJSON(filepath, data) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

function writeSummarizedBack(rawData, key, summarizedArticles) {
  if (!rawData[key]) return;
  const map = new Map(rawData[key].map((a, i) => [a.title, i]));
  for (const s of summarizedArticles) {
    if (map.has(s.title)) {
      const idx = map.get(s.title);
      rawData[key][idx] = { ...rawData[key][idx], priority: s.priority, summary_ja: s.summary_ja, impact: s.impact, memo: s.memo };
    }
  }
}

function writePubmedBack(rawData, summarizedArticles) {
  for (const s of summarizedArticles) {
    if (s._pubmedKey && rawData.pubmed && rawData.pubmed[s._pubmedKey]) {
      const articles = rawData.pubmed[s._pubmedKey].articles;
      const idx = articles.findIndex(a => a.pmid === s.pmid || a.title === s.title);
      if (idx >= 0) articles[idx] = { ...articles[idx], priority: s.priority, summary_ja: s.summary_ja, impact: s.impact, memo: s.memo };
    }
  }
}

// --- Main ---

async function main() {
  const startTime = Date.now();
  const deadlineMs = startTime + GLOBAL_TIMEOUT_MS;
  const schedule = getDaySchedule();

  const focusLabels = [];
  if (schedule.isAlertDay) focusLabels.push('制度アラート');
  if (schedule.isTechDay) focusLabels.push('テック・AI');
  if (schedule.isPaperDay) focusLabels.push('論文ダイジェスト');
  const modeLabel = focusLabels.length > 0 ? focusLabels.join('+') : '日次';

  console.log('═══════════════════════════════════════════════');
  console.log('  Auto Briefing — 自動ブリーフィング開始');
  console.log(`  ${new Date().toLocaleString('ja-JP')}（${schedule.dayName}）[${modeLabel}]`);
  console.log('═══════════════════════════════════════════════');

  // 1. データ収集
  console.log('\n[1/4] データ収集中...');
  const collectFlags = ['--no-summary'];
  if (!schedule.isPaperDay) collectFlags.push('--skip-pubmed');
  if (schedule.isTechDay) collectFlags.push('--arxiv');

  try {
    execSync(`"${NODE_BIN}" src/collect.js ${collectFlags.join(' ')}`, {
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

  // 週次キャッシュの再利用
  if (!schedule.isPaperDay) {
    const cached = loadJSON(WEEKLY_PAPERS_PATH);
    if (cached) {
      console.log('  論文データ (weekly_papers.json) を再利用');
      if (cached.pubmed) rawData.pubmed = cached.pubmed;
      if (cached.arxiv && (!rawData.arxiv || rawData.arxiv.length === 0)) rawData.arxiv = cached.arxiv;
    }
  }
  if (!schedule.isTechDay) {
    const cached = loadJSON(WEEKLY_TECH_PATH);
    if (cached) {
      console.log('  テックデータ (weekly_tech.json) を再利用');
      if (cached.hackernews) {
        // Merge cached HN summaries into rawData
        for (const a of cached.hackernews) {
          const existing = (rawData.hackernews || []).find(x => x.title === a.title);
          if (existing && a.priority) {
            Object.assign(existing, { priority: a.priority, summary_ja: a.summary_ja, impact: a.impact, memo: a.memo });
          }
        }
      }
      if (cached.arxiv && (!rawData.arxiv || rawData.arxiv.length === 0)) rawData.arxiv = cached.arxiv;
    }
  }
  if (!schedule.isAlertDay) {
    const cached = loadJSON(WEEKLY_ALERTS_PATH);
    if (cached && cached.mhlw) {
      console.log('  制度アラートデータ (weekly_alerts.json) を再利用');
      for (const a of cached.mhlw) {
        const existing = (rawData.mhlw || []).find(x => x.title === a.title);
        if (existing && a.priority) {
          Object.assign(existing, { priority: a.priority, summary_ja: a.summary_ja, impact: a.impact, memo: a.memo });
        }
      }
    }
  }

  // 3. Claude APIで要約・優先度判定
  console.log('\n[2/4] Claude APIで記事を評価中...');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY が設定されていません。');
    console.log('デフォルト優先度でenriched_dataを生成します。');
    assignDefaultPriorities(rawData);
  } else {
    const configPath = path.join(PROJECT_ROOT, 'config', 'settings.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const { summarizeArticles } = require('./summarize');

    // --- PubMed: 金曜のみAPI要約 ---
    if (schedule.isPaperDay && rawData.pubmed) {
      const { apiArticles, fallbackArticles } = filterPubmedForAPI(rawData.pubmed);
      console.log(`  [金曜] PubMed: ${apiArticles.length} 件をAPI送信, ${fallbackArticles.length} 件はデフォルト`);

      for (const a of fallbackArticles) {
        writePubmedBack(rawData, [a]);
      }

      if (apiArticles.length > 0) {
        try {
          const summarized = await summarizeArticles(apiArticles, config, { deadlineMs });
          writePubmedBack(rawData, summarized);
        } catch (e) {
          console.error('  PubMed API error:', e.message);
        }
      }
    }

    // --- ニュース: キーワードスコアリング ---
    const allNewsRaw = [];
    const newsSourceKeys = ['mhlw', 'hackernews', 'arxiv', 'medscape', 'fierce', 'carenet', 'nikkei', 'ft', 'm3', 'medical_tribune'];
    const sourceLabels = {
      mhlw: '厚労省', hackernews: 'HackerNews', arxiv: 'arXiv', medscape: 'Medscape',
      fierce: 'Fierce', carenet: 'CareNet', nikkei: '日経', ft: 'FT', m3: 'm3.com', medical_tribune: 'Medical Tribune',
    };

    // 曜日別のAPI対象ソース
    const extraAPISources = new Set();
    if (schedule.isAlertDay) extraAPISources.add('mhlw');
    if (schedule.isTechDay) { extraAPISources.add('hackernews'); extraAPISources.add('arxiv'); }

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

    const newsForAPI = [];
    const newsLowScore = [];
    const newsExcluded = [];

    for (const { article, score } of scored) {
      // Skip articles that already have priority from cache
      if (article.priority) {
        continue;
      }

      const isExtraSource = extraAPISources.has(article._sourceKey);

      if (score === 0 && !isExtraSource) {
        article.priority = '除外';
        article.summary_ja = article.title;
        article.impact = '';
        article.memo = '';
        newsExcluded.push(article);
      } else if (isExtraSource) {
        // 重点日のソースは必ずAPI送信
        newsForAPI.push(article);
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

    console.log(`  News: ${newsForAPI.length} 件をAPI送信, ${newsLowScore.length} 件はデフォルト, ${newsExcluded.length} 件は除外`);
    const totalAPI = (schedule.isPaperDay && rawData.pubmed ? Object.values(rawData.pubmed).reduce((n, c) => n + Math.min((c.articles||[]).length, 3), 0) : 0) + newsForAPI.length;
    console.log(`  合計API送信: 約${totalAPI} 件`);

    // Write fallback/excluded back
    for (const a of [...newsLowScore, ...newsExcluded]) {
      const key = a._sourceKey;
      if (rawData[key]) {
        const idx = rawData[key].findIndex(x => x.title === a.title);
        if (idx >= 0) rawData[key][idx] = { ...rawData[key][idx], priority: a.priority, summary_ja: a.summary_ja, impact: a.impact, memo: a.memo };
      }
    }

    // --- Call API for news ---
    if (newsForAPI.length > 0) {
      try {
        const summarizedNews = await summarizeArticles(newsForAPI, config, { deadlineMs });

        const maps = {};
        for (const key of newsSourceKeys) {
          maps[key] = new Map((rawData[key] || []).map((a, i) => [a.title, i]));
        }

        for (const s of summarizedNews) {
          const key = s._sourceKey;
          if (key && maps[key] && maps[key].has(s.title)) {
            const idx = maps[key].get(s.title);
            rawData[key][idx] = { ...rawData[key][idx], priority: s.priority, summary_ja: s.summary_ja, impact: s.impact, memo: s.memo };
          }
        }
      } catch (e) {
        console.error('News API error:', e.message);
        assignDefaultPriorities(rawData);
      }
    }

    // --- 週次キャッシュの保存 ---
    if (schedule.isPaperDay) {
      const weeklyData = {};
      if (rawData.pubmed) weeklyData.pubmed = rawData.pubmed;
      if (rawData.arxiv) weeklyData.arxiv = rawData.arxiv;
      saveJSON(WEEKLY_PAPERS_PATH, weeklyData);
      console.log(`  週次保存: weekly_papers.json`);
    }
    if (schedule.isTechDay) {
      const weeklyData = {};
      if (rawData.hackernews) weeklyData.hackernews = rawData.hackernews;
      if (rawData.arxiv) weeklyData.arxiv = rawData.arxiv;
      saveJSON(WEEKLY_TECH_PATH, weeklyData);
      console.log(`  週次保存: weekly_tech.json`);
    }
    if (schedule.isAlertDay) {
      const weeklyData = {};
      if (rawData.mhlw) weeklyData.mhlw = rawData.mhlw;
      saveJSON(WEEKLY_ALERTS_PATH, weeklyData);
      console.log(`  週次保存: weekly_alerts.json`);
    }
  }

  // 4. enriched_data.json を保存
  console.log('\n[3/4] enriched_data.json を保存中...');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const enrichedPath = path.join(OUTPUT_DIR, 'enriched_data.json');

  // 更新日メタデータを埋め込み
  rawData._meta = rawData._meta || {};
  rawData._meta.generated = new Date().toISOString().split('T')[0];
  if (schedule.isPaperDay) rawData._meta.papers_updated = rawData._meta.generated;
  if (schedule.isTechDay) rawData._meta.tech_updated = rawData._meta.generated;
  if (schedule.isAlertDay) rawData._meta.alerts_updated = rawData._meta.generated;

  // 前回のメタデータを引き継ぎ
  const prevEnriched = loadJSON(enrichedPath);
  if (prevEnriched && prevEnriched._meta) {
    if (!schedule.isPaperDay && prevEnriched._meta.papers_updated) rawData._meta.papers_updated = prevEnriched._meta.papers_updated;
    if (!schedule.isTechDay && prevEnriched._meta.tech_updated) rawData._meta.tech_updated = prevEnriched._meta.tech_updated;
    if (!schedule.isAlertDay && prevEnriched._meta.alerts_updated) rawData._meta.alerts_updated = prevEnriched._meta.alerts_updated;
  }

  fs.writeFileSync(enrichedPath, JSON.stringify(rawData, null, 2), 'utf8');
  console.log(`保存完了: ${enrichedPath}`);

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
