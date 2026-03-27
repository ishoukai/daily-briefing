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

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const WEEKLY_PAPERS_PATH = path.join(OUTPUT_DIR, 'weekly_papers.json');
const WEEKLY_TECH_PATH = path.join(OUTPUT_DIR, 'weekly_tech.json');
const WEEKLY_ALERTS_PATH = path.join(OUTPUT_DIR, 'weekly_alerts.json');
const NODE_BIN = process.execPath;
const GLOBAL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// --- JST helpers (GitHub Actions runs in UTC) ---

function getJSTNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function getJSTDateString() {
  return getJSTNow().toISOString().split('T')[0];
}

// --- Day-of-week schedule ---

function getDaySchedule() {
  const dayOfWeek = getJSTNow().getUTCDay(); // 0=日, 1=月, ..., 6=土 (JST)
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
  if (!article.priority) article.priority = (hasHighKeyword || hasMidKeyword) ? '要注視' : '参考';
  if (!article.summary_ja) article.summary_ja = article.description || article.title || '';
  if (!article.impact && article.impact !== '') article.impact = '';
  if (!article.memo && article.memo !== '') article.memo = '';
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

// --- 未翻訳（Latin文字のみ）検出 ---

function isLatinOnly(str) {
  if (!str || str.trim().length === 0) return false;
  return /^[\x00-\x7F\u00C0-\u024F]+$/.test(str.trim());
}

function collectUntranslatedArticles(data) {
  const untranslated = [];
  if (data.pubmed) {
    for (const [key, catData] of Object.entries(data.pubmed)) {
      for (const article of (catData.articles || [])) {
        if (article.summary_ja && isLatinOnly(article.summary_ja)) {
          untranslated.push({ ...article, _pubmedKey: key });
        }
      }
    }
  }
  for (const key of ['mhlw', 'hackernews', 'arxiv', 'medscape', 'fierce', 'carenet', 'nikkei', 'ft', 'm3', 'medical_tribune']) {
    if (data[key]) {
      for (const article of data[key]) {
        if (article.summary_ja && isLatinOnly(article.summary_ja)) {
          untranslated.push({ ...article, _sourceKey: key });
        }
      }
    }
  }
  return untranslated;
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
  console.log(`  ${getJSTNow().toISOString().replace('T', ' ').substring(0, 19)} JST（${schedule.dayName}）[${modeLabel}]`);
  console.log('═══════════════════════════════════════════════');

  // 1. データ収集（同一プロセス内で実行）
  console.log('\n[1/4] データ収集中...');
  const { collect } = require('./collect');
  try {
    await collect({
      noSummary: true,
      skipPubmed: !schedule.isPaperDay,
      includeArxiv: schedule.isTechDay,
      skipBrowserOpen: true,
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

  // 週次キャッシュの再利用（_cached フラグで区別）
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
        for (const a of cached.hackernews) {
          const existing = (rawData.hackernews || []).find(x => x.title === a.title);
          if (existing && a.priority) {
            Object.assign(existing, { priority: a.priority, summary_ja: a.summary_ja, impact: a.impact, memo: a.memo, _cached: true });
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
          Object.assign(existing, { priority: a.priority, summary_ja: a.summary_ja, impact: a.impact, memo: a.memo, _cached: true });
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

    // --- 医療専門メディアは全件API送信（ソース別上限あり、2-3バッチ分割） ---

    const newsSourceKeys = ['mhlw', 'hackernews', 'arxiv', 'medscape', 'fierce', 'carenet', 'nikkei', 'ft', 'm3', 'medical_tribune'];
    const sourceLabels = {
      mhlw: '厚労省', hackernews: 'HackerNews', arxiv: 'arXiv', medscape: 'Medscape',
      fierce: 'Fierce', carenet: 'CareNet', nikkei: '日経', ft: 'FT', m3: 'm3.com', medical_tribune: 'Medical Tribune',
    };

    // 全ソース全件API送信（曜日制限あり: HN/arXiv=水曜, PubMed=金曜）
    const limits = { mhlw: 99, nikkei: 99, ft: 99, medscape: 99, fierce: 99, carenet: 99 };
    if (schedule.isTechDay) {
      limits.hackernews = 99;
      limits.arxiv = 99;
    }

    // PubMed: 金曜のみ全件API送信
    let pubmedApiArticles = [];
    if (schedule.isPaperDay && rawData.pubmed) {
      const { apiArticles, fallbackArticles } = filterPubmedForAPI(rawData.pubmed);
      pubmedApiArticles = apiArticles; // 全件
      for (const a of fallbackArticles) writePubmedBack(rawData, [a]);
      console.log(`  [金曜] PubMed: ${pubmedApiArticles.length} 件をAPI送信`);
    }

    // ニュース記事を収集しスコアリング
    const allNewsRaw = [];
    const sourceTotals = {};
    for (const key of newsSourceKeys) {
      if (rawData[key]) {
        sourceTotals[key] = rawData[key].length;
        for (const article of rawData[key]) {
          article.source = article.source || sourceLabels[key] || key;
          if (key === 'nikkei' || key === 'ft') article._rssOnly = true;
          article._sourceKey = key;
          article._score = scoreArticle(article);
          allNewsRaw.push(article);
        }
      }
    }

    // デバッグ: 各ソースの記事数
    console.log('  収集記事数:');
    for (const [key, count] of Object.entries(sourceTotals)) {
      const cached = rawData[key].filter(a => a._cached).length;
      console.log(`    ${sourceLabels[key] || key}: ${count} 件${cached > 0 ? ` (うちキャッシュ ${cached} 件)` : ''}`);
    }

    // 各ソースからスコア上位を上限件数まで選択
    const newsForAPI = [];
    const newsRest = [];
    const counters = {};

    // スコア降順でソート
    allNewsRaw.sort((a, b) => b._score - a._score);

    for (const article of allNewsRaw) {
      // _cached フラグが付いているもののみスキップ（週次キャッシュから復元済み）
      if (article._cached) continue;

      const key = article._sourceKey;
      const limit = limits[key] || 0;
      counters[key] = (counters[key] || 0) + 1;

      if (counters[key] <= limit) {
        newsForAPI.push(article);
      } else {
        newsRest.push(article);
      }
    }

    // 残りはフォールバック or 除外
    for (const article of newsRest) {
      if (article._score === 0) {
        article.priority = '除外';
        article.summary_ja = article.title;
        article.impact = '';
        article.memo = '';
      } else {
        assignFallbackPriority(article);
      }
    }

    const allForAPI = [...pubmedApiArticles, ...newsForAPI];
    console.log(`  API送信: ${allForAPI.length} 件（PubMed ${pubmedApiArticles.length} + News ${newsForAPI.length}）`);
    // デバッグ: API送信内訳
    const apiBySource = {};
    for (const a of newsForAPI) {
      apiBySource[a._sourceKey] = (apiBySource[a._sourceKey] || 0) + 1;
    }
    for (const [key, count] of Object.entries(apiBySource)) {
      console.log(`    ${sourceLabels[key] || key}: ${count} 件 (上限 ${limits[key] || 0})`);
    }

    // Write fallback/rest back to rawData
    for (const a of newsRest) {
      const key = a._sourceKey;
      if (rawData[key]) {
        const idx = rawData[key].findIndex(x => x.title === a.title);
        if (idx >= 0) rawData[key][idx] = { ...rawData[key][idx], priority: a.priority, summary_ja: a.summary_ja, impact: a.impact, memo: a.memo };
      }
    }

    // --- 1回のAPI呼び出しで全件処理 ---
    if (allForAPI.length > 0) {
      try {
        const summarized = await summarizeArticles(allForAPI, config, { deadlineMs });

        // Write PubMed results back
        writePubmedBack(rawData, summarized.filter(s => s._pubmedKey));

        // Write news results back
        const maps = {};
        for (const key of newsSourceKeys) {
          maps[key] = new Map((rawData[key] || []).map((a, i) => [a.title, i]));
        }
        for (const s of summarized) {
          const key = s._sourceKey;
          if (key && maps[key] && maps[key].has(s.title)) {
            const idx = maps[key].get(s.title);
            rawData[key][idx] = { ...rawData[key][idx], priority: s.priority, summary_ja: s.summary_ja, impact: s.impact, memo: s.memo };
          }
        }
      } catch (e) {
        console.error('API error:', e.message);
        assignDefaultPriorities(rawData);
      }
    }

    // --- 未翻訳記事の再処理（1回のみ） ---
    const untranslated = collectUntranslatedArticles(rawData);
    if (untranslated.length > 0) {
      console.log(`  未翻訳記事を検出: ${untranslated.length} 件 → 再処理中...`);
      try {
        const retryBatchSize = 5;
        for (let i = 0; i < untranslated.length; i += retryBatchSize) {
          const batch = untranslated.slice(i, i + retryBatchSize);
          const retryConfig = {
            ...config,
            claude_api: {
              ...config.claude_api,
              system_prompt: config.claude_api.system_prompt + '\n\n【再処理指示】この記事は前回英語で返されました。必ず日本語に翻訳してください。英語のまま返すことは絶対に禁止です。summary_ja、impact、memoは全て日本語で記述してください。',
            },
          };
          const retrySummarized = await summarizeArticles(batch, retryConfig, { deadlineMs });

          // Write retry results back
          writePubmedBack(rawData, retrySummarized.filter(s => s._pubmedKey));
          const retryMaps = {};
          for (const key of newsSourceKeys) {
            retryMaps[key] = new Map((rawData[key] || []).map((a, i) => [a.title, i]));
          }
          for (const s of retrySummarized) {
            const key = s._sourceKey;
            if (key && retryMaps[key] && retryMaps[key].has(s.title)) {
              const idx = retryMaps[key].get(s.title);
              rawData[key][idx] = { ...rawData[key][idx], priority: s.priority, summary_ja: s.summary_ja, impact: s.impact, memo: s.memo };
            }
          }

          if (i + retryBatchSize < untranslated.length) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
        console.log(`  再処理完了`);
      } catch (e) {
        console.error('  再処理エラー:', e.message);
      }
    }

    // --- 週次キャッシュの保存（_meta付き） ---
    const todayISO = getJSTDateString();
    if (schedule.isPaperDay) {
      const weeklyData = { _meta: { papers_updated: todayISO } };
      if (rawData.pubmed) weeklyData.pubmed = rawData.pubmed;
      if (rawData.arxiv) weeklyData.arxiv = rawData.arxiv;
      saveJSON(WEEKLY_PAPERS_PATH, weeklyData);
      console.log(`  週次保存: weekly_papers.json`);
    }
    if (schedule.isTechDay) {
      const weeklyData = { _meta: { tech_updated: todayISO } };
      if (rawData.hackernews) weeklyData.hackernews = rawData.hackernews;
      if (rawData.arxiv) weeklyData.arxiv = rawData.arxiv;
      saveJSON(WEEKLY_TECH_PATH, weeklyData);
      console.log(`  週次保存: weekly_tech.json`);
    }
    if (schedule.isAlertDay) {
      const weeklyData = { _meta: { alerts_updated: todayISO } };
      if (rawData.mhlw) weeklyData.mhlw = rawData.mhlw;
      saveJSON(WEEKLY_ALERTS_PATH, weeklyData);
      console.log(`  週次保存: weekly_alerts.json`);
    }
  }

  // 全記事にsummary_ja/impact/memoを保証（未設定の記事を補完）
  assignDefaultPriorities(rawData);

  // 4. enriched_data.json を保存
  console.log('\n[3/4] enriched_data.json を保存中...');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const enrichedPath = path.join(OUTPUT_DIR, 'enriched_data.json');

  // 更新日メタデータを埋め込み
  rawData._meta = rawData._meta || {};
  rawData._meta.generated = getJSTDateString();
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
        if (!article.priority) article.priority = catData.priority === 'high' ? '要注視' : '参考';
        if (!article.summary_ja) article.summary_ja = (article.abstract || article.title || '').substring(0, 200);
        if (article.impact == null) article.impact = '';
        if (article.memo == null) article.memo = '';
      }
    }
  }
  for (const key of ['mhlw', 'hackernews', 'arxiv', 'medscape', 'fierce', 'carenet', 'nikkei', 'ft', 'm3', 'medical_tribune']) {
    if (data[key]) {
      for (const article of data[key]) {
        if (!article.priority) article.priority = '参考';
        if (!article.summary_ja) article.summary_ja = article.description || article.title || '';
        if (article.impact == null) article.impact = '';
        if (article.memo == null) article.memo = '';
      }
    }
  }
}

main().then(() => {
  process.exit(0);
}).catch(e => {
  console.error('自動ブリーフィング失敗:', e.message);
  process.exit(1);
});
