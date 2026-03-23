#!/usr/bin/env node

/**
 * 自動ブリーフィング — データ収集 → Claude API要約 → enriched_data保存 → HTML生成
 *
 * 日次/週次の分離:
 *   月曜: PubMed + arXiv + 日次ソース（フル実行）→ weekly_papers.json に保存
 *   火〜日: 日次ソースのみ → weekly_papers.json を再利用
 *
 * ANTHROPIC_API_KEY 環境変数が必要。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const WEEKLY_PAPERS_PATH = path.join(OUTPUT_DIR, 'weekly_papers.json');

// Use 'node' from PATH (works on both macOS and GitHub Actions)
const NODE_BIN = process.execPath;

function isMonday() {
  return new Date().getDay() === 1;
}

async function main() {
  const startTime = Date.now();
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
    console.error('raw_data.json が見つかりません。collect.js が正しく実行されたか確認してください。');
    process.exit(1);
  }
  const rawData = JSON.parse(fs.readFileSync(rawDataPath, 'utf8'));

  // 月曜以外: PubMed/arXivを前回の週次データで補完
  if (!monday) {
    if (fs.existsSync(WEEKLY_PAPERS_PATH)) {
      console.log('  前回の週次データ (weekly_papers.json) を再利用します');
      const weeklyData = JSON.parse(fs.readFileSync(WEEKLY_PAPERS_PATH, 'utf8'));
      if (weeklyData.pubmed && !rawData.pubmed) {
        rawData.pubmed = weeklyData.pubmed;
      }
      if (weeklyData.arxiv && (!rawData.arxiv || rawData.arxiv.length === 0)) {
        rawData.arxiv = weeklyData.arxiv;
      }
    } else {
      console.log('  weekly_papers.json が見つかりません。PubMed/arXivデータなしで続行します。');
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

    // Collect all articles for summarization
    const allArticles = [];

    if (rawData.pubmed) {
      for (const [key, catData] of Object.entries(rawData.pubmed)) {
        for (const article of (catData.articles || [])) {
          article.source = article.source || 'PubMed';
          article.specialty = article.specialty || catData.label;
          article.category = 'paper';
          article._pubmedKey = key;
          allArticles.push(article);
        }
      }
    }

    const newsArticles = [];
    if (rawData.mhlw) {
      for (const article of rawData.mhlw) {
        article.source = article.source || '厚労省';
        newsArticles.push(article);
      }
    }
    if (rawData.hackernews) {
      for (const article of rawData.hackernews) {
        article.source = article.source || 'HackerNews';
        newsArticles.push(article);
      }
    }
    if (rawData.arxiv) {
      for (const article of rawData.arxiv) {
        article.source = article.source || 'arXiv';
        newsArticles.push(article);
      }
    }
    if (rawData.medscape) {
      for (const article of rawData.medscape) {
        article.source = article.source || 'Medscape';
        newsArticles.push(article);
      }
    }
    if (rawData.fierce) {
      for (const article of rawData.fierce) {
        article.source = article.source || 'Fierce';
        newsArticles.push(article);
      }
    }
    if (rawData.carenet) {
      for (const article of rawData.carenet) {
        article.source = article.source || 'CareNet';
        newsArticles.push(article);
      }
    }
    if (rawData.nikkei) {
      for (const article of rawData.nikkei) {
        article.source = article.source || '日経';
        article._rssOnly = true;
        newsArticles.push(article);
      }
    }
    if (rawData.ft) {
      for (const article of rawData.ft) {
        article.source = article.source || 'FT';
        article._rssOnly = true;
        newsArticles.push(article);
      }
    }

    try {
      if (allArticles.length > 0) {
        const summarized = await summarizeArticles(allArticles, config);
        for (const s of summarized) {
          if (s._pubmedKey && rawData.pubmed[s._pubmedKey]) {
            const articles = rawData.pubmed[s._pubmedKey].articles;
            const idx = articles.findIndex(a => a.pmid === s.pmid || a.title === s.title);
            if (idx >= 0) {
              articles[idx] = { ...articles[idx], priority: s.priority, summary_ja: s.summary_ja, impact: s.impact, memo: s.memo };
            }
          }
        }
      }

      if (newsArticles.length > 0) {
        const summarizedNews = await summarizeArticles(newsArticles, config);
        const mhlwMap = new Map((rawData.mhlw || []).map((a, i) => [a.title, i]));
        const hnMap = new Map((rawData.hackernews || []).map((a, i) => [a.title, i]));
        const arxivMap = new Map((rawData.arxiv || []).map((a, i) => [a.title, i]));
        const medscapeMap = new Map((rawData.medscape || []).map((a, i) => [a.title, i]));
        const fierceMap = new Map((rawData.fierce || []).map((a, i) => [a.title, i]));
        const carenetMap = new Map((rawData.carenet || []).map((a, i) => [a.title, i]));
        const nikkeiMap = new Map((rawData.nikkei || []).map((a, i) => [a.title, i]));
        const ftMap = new Map((rawData.ft || []).map((a, i) => [a.title, i]));

        for (const s of summarizedNews) {
          const enrichFields = { priority: s.priority, summary_ja: s.summary_ja, impact: s.impact, memo: s.memo };
          if (s.source === '厚労省' && mhlwMap.has(s.title)) {
            const idx = mhlwMap.get(s.title);
            rawData.mhlw[idx] = { ...rawData.mhlw[idx], ...enrichFields };
          } else if (s.source === 'HackerNews' && hnMap.has(s.title)) {
            const idx = hnMap.get(s.title);
            rawData.hackernews[idx] = { ...rawData.hackernews[idx], ...enrichFields };
          } else if (s.source === 'arXiv' && arxivMap.has(s.title)) {
            const idx = arxivMap.get(s.title);
            rawData.arxiv[idx] = { ...rawData.arxiv[idx], ...enrichFields };
          } else if (s.source === 'Medscape' && medscapeMap.has(s.title)) {
            const idx = medscapeMap.get(s.title);
            rawData.medscape[idx] = { ...rawData.medscape[idx], ...enrichFields };
          } else if (s.source === 'Fierce' && fierceMap.has(s.title)) {
            const idx = fierceMap.get(s.title);
            rawData.fierce[idx] = { ...rawData.fierce[idx], ...enrichFields };
          } else if (s.source === 'CareNet' && carenetMap.has(s.title)) {
            const idx = carenetMap.get(s.title);
            rawData.carenet[idx] = { ...rawData.carenet[idx], ...enrichFields };
          } else if (s.source === '日経' && nikkeiMap.has(s.title)) {
            const idx = nikkeiMap.get(s.title);
            rawData.nikkei[idx] = { ...rawData.nikkei[idx], ...enrichFields };
          } else if (s.source === 'FT' && ftMap.has(s.title)) {
            const idx = ftMap.get(s.title);
            rawData.ft[idx] = { ...rawData.ft[idx], ...enrichFields };
          }
        }
      }
    } catch (e) {
      console.error('Claude API呼び出しに失敗:', e.message);
      console.log('デフォルト優先度で続行します。');
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
        article.priority = article.priority || (catData.priority === 'high' ? '要注視' : '参考');
        article.summary_ja = article.summary_ja || (article.abstract || '').substring(0, 200);
        article.impact = article.impact || '';
        article.memo = article.memo || '';
      }
    }
  }
  for (const key of ['mhlw', 'hackernews', 'arxiv', 'medscape', 'fierce', 'carenet', 'nikkei', 'ft']) {
    if (data[key]) {
      for (const article of data[key]) {
        article.priority = article.priority || '参考';
        article.summary_ja = article.summary_ja || article.title;
        article.impact = article.impact || '';
        article.memo = article.memo || '';
      }
    }
  }
}

main().catch(e => {
  console.error('自動ブリーフィング失敗:', e.message);
  process.exit(1);
});
