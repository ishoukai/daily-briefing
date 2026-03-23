#!/usr/bin/env node

/**
 * Daily Intelligence Briefing — メイン収集スクリプト
 * 
 * 使い方:
 *   node src/collect.js              # 全ソースから収集
 *   node src/collect.js --pubmed     # PubMedのみ
 *   node src/collect.js --no-summary # Claude APIを使わない（テスト用）
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pubmed = require('./sources/pubmed');
const mhlw = require('./sources/mhlw');
const hackernews = require('./sources/hackernews');
const arxiv = require('./sources/arxiv');
const medscape = require('./sources/medscape');
const fierce = require('./sources/fierce');
const carenet = require('./sources/carenet');
const nikkei = require('./sources/nikkei');
const m3 = require('./sources/m3');
const medicalTribune = require('./sources/medical-tribune');
const ft = require('./sources/ft');
const { summarizeArticles } = require('./summarize');
const { generateHTML, saveHTML } = require('./render');

// Parse CLI args
const args = process.argv.slice(2);
const onlyPubmed = args.includes('--pubmed');
const onlyMhlw = args.includes('--mhlw');
const noSummary = args.includes('--no-summary');
const isWeekly = args.includes('--weekly');

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Daily Intelligence Briefing — 収集開始');
  console.log(`  ${new Date().toLocaleString('ja-JP')}`);
  console.log('═══════════════════════════════════════════════');

  // Load config
  const configPath = path.join(__dirname, '..', 'config', 'settings.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const sourceCounts = {};
  let allArticles = [];
  let pubmedResults = {};
  let mhlwResults = [];
  let hnResults = [];
  let arxivResults = [];
  let medscapeResults = [];
  let fierceResults = [];
  let carenetResults = [];
  let nikkeiResults = [];
  let ftResults = [];
  let m3Results = [];
  let mtResults = [];

  // ===== 1. PubMed =====
  if (!onlyMhlw) {
    pubmedResults = await pubmed.collectAll(config);
    let pubmedCount = 0;
    for (const [key, data] of Object.entries(pubmedResults)) {
      pubmedCount += data.articles.length;
      for (const article of data.articles) {
        article.source = `PubMed`;
        article.specialty = data.label;
        article.sourcePriority = data.priority;
        article.category = 'paper';
      }
    }
    sourceCounts['PubMed'] = pubmedCount;
  }

  // ===== 2. 厚労省 =====
  if (!onlyPubmed) {
    mhlwResults = await mhlw.collectAll(config);
    sourceCounts['厚労省'] = mhlwResults.length;
  }

  // ===== 3. Hacker News =====
  if (!onlyPubmed && !onlyMhlw) {
    hnResults = await hackernews.collectAll(config);
    sourceCounts['HackerNews'] = hnResults.length;
  }

  // ===== 4. arXiv (weekly only) =====
  if (isWeekly || args.includes('--arxiv')) {
    arxivResults = await arxiv.collectAll(config);
    sourceCounts['arXiv'] = arxivResults.length;
  }

  // ===== 5. Medscape =====
  if (!onlyPubmed && !onlyMhlw) {
    try {
      medscapeResults = await medscape.collectAll(config);
      sourceCounts['Medscape'] = medscapeResults.length;
    } catch (e) {
      console.error(`  [Medscape] Error: ${e.message}`);
    }
  }

  // ===== 6. Fierce Healthcare =====
  if (!onlyPubmed && !onlyMhlw) {
    try {
      fierceResults = await fierce.collectAll(config);
      sourceCounts['Fierce'] = fierceResults.length;
    } catch (e) {
      console.error(`  [Fierce] Error: ${e.message}`);
    }
  }

  // ===== 7. CareNet =====
  if (!onlyPubmed && !onlyMhlw) {
    try {
      carenetResults = await carenet.collectAll(config);
      sourceCounts['CareNet'] = carenetResults.length;
    } catch (e) {
      console.error(`  [CareNet] Error: ${e.message}`);
    }
  }

  // ===== 8. 日経 =====
  if (!onlyPubmed && !onlyMhlw) {
    try {
      nikkeiResults = await nikkei.collectAll(config);
      sourceCounts['日経'] = nikkeiResults.length;
    } catch (e) {
      console.error(`  [日経] Error: ${e.message}`);
    }
  }

  // ===== 9. FT =====
  if (!onlyPubmed && !onlyMhlw) {
    try {
      ftResults = await ft.collectAll(config);
      sourceCounts['FT'] = ftResults.length;
    } catch (e) {
      console.error(`  [FT] Error: ${e.message}`);
    }
  }

  // ===== 10. m3.com =====
  if (!onlyPubmed && !onlyMhlw) {
    try {
      m3Results = await m3.collectAll(config);
      sourceCounts['m3.com'] = m3Results.length;
    } catch (e) {
      console.error(`  [m3.com] Error: ${e.message}`);
    }
  }

  // ===== 11. Medical Tribune =====
  if (!onlyPubmed && !onlyMhlw) {
    try {
      mtResults = await medicalTribune.collectAll(config);
      sourceCounts['Medical Tribune'] = mtResults.length;
    } catch (e) {
      console.error(`  [Medical Tribune] Error: ${e.message}`);
    }
  }

  // ===== Flatten PubMed results =====
  const allPapers = [];
  for (const [key, data] of Object.entries(pubmedResults)) {
    allPapers.push(...data.articles);
  }

  // ===== Merge all non-paper items =====
  const allNews = [...mhlwResults, ...hnResults, ...medscapeResults, ...fierceResults, ...carenetResults, ...nikkeiResults, ...ftResults, ...m3Results, ...mtResults];

  // ===== 5. Claude API で要約・優先度判定 =====
  let summarizedPapers = allPapers;
  let summarizedNews = allNews;

  if (!noSummary && process.env.ANTHROPIC_API_KEY) {
    console.log('\n[Claude API] 要約・優先度判定を実行中...');
    
    if (allPapers.length > 0) {
      summarizedPapers = await summarizeArticles(allPapers, config);
    }
    if (allNews.length > 0) {
      summarizedNews = await summarizeArticles(allNews, config);
    }
  } else {
    if (!noSummary) {
      console.log('\n⚠️  ANTHROPIC_API_KEY が未設定のため、要約をスキップします');
      console.log('   設定方法: export ANTHROPIC_API_KEY="sk-ant-..."');
    }
    // Assign default priorities
    for (const p of summarizedPapers) {
      p.priority = p.priority || (p.sourcePriority === 'high' ? '要注視' : '参考');
      p.summary_ja = p.summary_ja || p.abstract?.substring(0, 200);
      p.memo = p.memo || '';
    }
    for (const n of summarizedNews) {
      n.priority = n.priority || '参考';
      n.summary_ja = n.summary_ja || n.title;
    }
  }

  // ===== Save raw data =====
  const outputDir = path.resolve(path.join(__dirname, '..', config.output.dir));
  fs.mkdirSync(outputDir, { recursive: true });

  const rawData = {
    collected_at: new Date().toISOString(),
    pubmed: pubmedResults,
    mhlw: mhlwResults,
    hackernews: hnResults,
    arxiv: arxivResults,
    medscape: medscapeResults,
    fierce: fierceResults,
    carenet: carenetResults,
    nikkei: nikkeiResults,
    ft: ftResults,
    m3: m3Results,
    medical_tribune: mtResults,
  };
  const rawDataPath = path.join(outputDir, 'raw_data.json');
  fs.writeFileSync(rawDataPath, JSON.stringify(rawData, null, 2), 'utf8');
  console.log(`\n📄 生データを保存しました: ${rawDataPath}`);

  // ===== 6. Categorize for output =====
  const morning = [
    ...summarizedNews.filter(i => i.category === 'regulation'),
    ...summarizedPapers.filter(i => i.priority === '要対応'),
    ...hnResults.filter(i => i.priority === '要注視' || i.priority === '要対応'),
  ];

  const papers = summarizedPapers;

  const alerts = summarizedNews.filter(i => i.category === 'regulation');

  const tech = [
    ...hnResults.map(i => ({ ...i, priority: i.priority || 'テック', section: '医療AI・テック' })),
    ...arxivResults.map(i => ({ ...i, priority: 'テック', section: 'arXiv新着' })),
  ];

  // ===== 7. Generate HTML =====
  console.log('\n[HTML] ブリーフィングを生成中...');

  const today = new Date();
  const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][today.getDay()];
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日（${dayOfWeek}）`;

  const htmlContent = generateHTML({
    morning: morning.length > 0 ? morning : summarizedNews.concat(summarizedPapers.slice(0, 5)),
    papers,
    alerts,
    tech,
    date: dateStr,
    sourceCounts,
  });

  const filepath = saveHTML(htmlContent, outputDir);

  // ===== 8. Open in browser (optional) =====
  if (config.output.open_on_generate) {
    try {
      execSync(`open "${filepath}"`);
      console.log('🌐 ブラウザで開きました');
    } catch (e) {
      // Not on Mac or open command not available
    }
  }

  // ===== Summary =====
  console.log('\n═══════════════════════════════════════════════');
  console.log('  収集完了サマリー');
  console.log('═══════════════════════════════════════════════');
  console.log(`  PubMed論文: ${allPapers.length} 件`);
  console.log(`  厚労省トピックス: ${mhlwResults.length} 件`);
  console.log(`  Hacker News: ${hnResults.length} 件`);
  if (arxivResults.length > 0) console.log(`  arXiv: ${arxivResults.length} 件`);
  console.log(`  Medscape: ${medscapeResults.length} 件`);
  console.log(`  Fierce Healthcare: ${fierceResults.length} 件`);
  console.log(`  CareNet: ${carenetResults.length} 件`);
  console.log(`  日経: ${nikkeiResults.length} 件`);
  console.log(`  FT: ${ftResults.length} 件`);
  console.log(`  m3.com: ${m3Results.length} 件`);
  console.log(`  Medical Tribune: ${mtResults.length} 件`);
  const total = allPapers.length + mhlwResults.length + hnResults.length + arxivResults.length + medscapeResults.length + fierceResults.length + carenetResults.length + nikkeiResults.length + ftResults.length + m3Results.length + mtResults.length;
  console.log(`  合計: ${total} 件`);
  console.log(`\n  出力: ${filepath}`);
  console.log('═══════════════════════════════════════════════\n');
}

main().catch(e => {
  console.error('❌ エラー:', e.message);
  process.exit(1);
});
