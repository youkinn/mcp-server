/**
 * FEAT-A030 重排延迟归因矩阵（本地 ONNX 推理计时；零 LLM 调用）。
 *
 * 目的：区分「模型固有延迟」与「当前配置下延迟」——把 batch / 截断 / 线程 / graph opt / 窗口逐项做单变量对照，
 * 看 CPU 基准上重排阶段 P95 能否压到预算内（负责人 2026-09-28 拍板：阶段 P95 ≤ 1000ms / P50 ≤ 600ms）。
 *
 * 口径（与 scripts/verify-rerank.mjs 一致，便于对照 4134ms 基线）：
 * - 阶段延迟 stageMs = 有重排检索耗时 − 无重排检索耗时（同进程交替采样，检索侧噪声在同一样本内对消）；
 * - 推理耗时 scorerMs = 直接包住 scorer 调用的计时（rerankWindow 每次检索只调一次 scorer）；
 * - 单次推理均耗 = ΣscorerMs / Σpassages（passages = 实际进重排的窗口内候选数，已扣掉保证区钉子）；
 * - 首调 firstCallMs 含分词器 + ORT session 创建（266MB int8 权重）。
 *
 * 档位按单变量对照设计（一次只动一个变量），末档为组合候选；不做全交叉（4×4×3×2×2 组合不可跑完）。
 * 每档默认 20 次采样；极慢档（如 intra=1）以 CONFIG_BUDGET_MS 提前截止（≥ MIN_SAMPLES），在结果里标 budgetHit。
 *
 * 用法：
 *   node scripts/perf-rerank-matrix.mjs                                   # 父：顺序跑全档位并合并落盘
 *   node scripts/perf-rerank-matrix.mjs --phase=high-performance --only=baseline,combined
 *   node scripts/perf-rerank-matrix.mjs --worker '<configJson>'           # 子：单档位，stdout 一行 PERF_RESULT
 * 前置：npm run build；data/models/bge-reranker-base 权重与 BGE-M3 权重齐备（缺权重如实报错，不做 mock）。
 * 落盘：dev-docs/test/standard-set/results/feat-A030-rerank-latency-attribution.json（终端只报行数 / 字节数）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const OUT_FILE = process.env.PERF_OUT_FILE ?? 'D:\\workplace\\dev-docs\\test\\standard-set\\results\\feat-A030-rerank-latency-attribution.json';
const BENCH_FILE = process.env.SANGO_BENCHMARK_FILE ?? 'D:\\workplace\\dev-docs\\docs\\sango-rag-regression-benchmark_v0.1.md';
const SAMPLES_PER_CONFIG = 20;
const MIN_SAMPLES = 5;
const CONFIG_BUDGET_MS = 180_000;
const LIMIT = 10;

/** 采样题：与 verify-rerank 同一批定点（华雄 / 刘备），保证与 4134ms 基线可对照。 */
const FIXPOINTS = [
  { group: '华雄', id: '典故#1' },
  { group: '华雄', id: '拒答#5' },
  { group: '刘备', id: '问法归一#4' },
  { group: '刘备', id: '事件关系#10' },
];

/** 单变量对照矩阵：未写的字段 = 历史默认（ORT 默认线程 / graph default / 截断 512 / batch 1 / 窗口 50）。 */
const MATRIX = [
  { id: 'baseline', label: '基线（当前生产配置）', maxTokens: 512, batch: 1, window: 50 },
  { id: 'intra1', label: '线程 intra=1', intraThreads: 1 },
  { id: 'intra4', label: '线程 intra=4', intraThreads: 4 },
  { id: 'intra8', label: '线程 intra=8', intraThreads: 8 },
  { id: 'intra16', label: '线程 intra=16', intraThreads: 16 },
  { id: 'inter8', label: '线程 inter=8（intra 默认）', interThreads: 8 },
  { id: 'graph-all', label: 'graph opt = ENABLE_ALL（显式）', graphOpt: 'all' },
  { id: 'tok256', label: '截断 256', maxTokens: 256 },
  { id: 'tok128', label: '截断 128', maxTokens: 128 },
  { id: 'batch4', label: 'batch=4（桶内对齐）', batch: 4 },
  { id: 'batch8', label: 'batch=8（桶内对齐）', batch: 8 },
  { id: 'batch16', label: 'batch=16（桶内对齐）', batch: 16 },
  { id: 'window20', label: '窗口 20（候选减半）', window: 20 },
  { id: 'combined', label: '组合候选：intra=8 + 截断 256 + batch=8 + 窗口 50', intraThreads: 8, maxTokens: 256, batch: 8, window: 50 },
  { id: 'combined-max', label: '组合激进：intra=8 + 截断 128 + batch=16 + 窗口 20', intraThreads: 8, maxTokens: 128, batch: 16, window: 20 },
];

function argValue(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function statsOf(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return {
    count: finite.length,
    mean: + (finite.reduce((a, b) => a + b, 0) / finite.length).toFixed(1),
    p50: +percentile(finite, 50).toFixed(1),
    p95: +percentile(finite, 95).toFixed(1),
    min: +Math.min(...finite).toFixed(1),
    max: +Math.max(...finite).toFixed(1),
  };
}

// ---------------------------------------------------------------- 子：单档位实测

async function runWorker(cfg) {
  // 重排窗口由 sango-index 运行时读环境变量（评测期换档，不改库层默认）
  process.env.SANGO_RERANKER_WINDOW = String(cfg.window ?? 50);
  const { DEFAULT_DATA_DIR, SangoIndex } = await import('../dist/search/sango-index.js');
  const { createCrossEncoderScorer, resolveRerankModelFile } = await import('../dist/search/reranker.js');
  const { parseBenchmark } = await import('../dist/benchmark/parser.js');

  const items = parseBenchmark(BENCH_FILE);
  const picked = FIXPOINTS.map((fp) => {
    const item = items.find((x) => x.id === fp.id);
    if (!item) throw new Error(`评测集缺少定点题：${fp.id}（${BENCH_FILE}）`);
    return { ...fp, item };
  });

  const modelDir = process.env.SANGO_RERANKER_DIR ?? path.join(DEFAULT_DATA_DIR, 'models', 'bge-reranker-base');
  if (!resolveRerankModelFile(modelDir)) throw new Error(`重排权重缺失：${modelDir}（如实退出，不 mock）`);

  const tuning = {
    maxTokens: cfg.maxTokens ?? 512,
    batch: cfg.batch ?? 1,
    intraOpThreads: cfg.intraThreads,
    interOpThreads: cfg.interThreads,
    graphOptimizationLevel: cfg.graphOpt ?? 'default',
  };

  const realScorer = createCrossEncoderScorer(modelDir, tuning);
  let activeScorer = realScorer;
  let lastScorerMs = null;
  let lastPassages = 0;
  /** 代理打分器：生产路径原样传递，仅旁路计时（不改出参、不改语义）。 */
  const timingScorer = async (query, passages) => {
    lastScorerMs = null;
    lastPassages = 0;
    const t0 = performance.now();
    const out = await activeScorer(query, passages);
    lastScorerMs = performance.now() - t0;
    lastPassages = passages.length;
    return out;
  };

  const withRerank = new SangoIndex(DEFAULT_DATA_DIR, { rerankScorer: timingScorer });
  const plain = new SangoIndex(DEFAULT_DATA_DIR, { rerankScorer: null });
  withRerank.load();
  plain.load();

  // 首调：含分词器 + session 创建（266MB int8）+ 首次推理
  const firstT0 = performance.now();
  await withRerank.search(picked[0].item.question, LIMIT);
  const firstCallMs = +(performance.now() - firstT0).toFixed(1);
  if (lastPassages === 0) throw new Error('首调未触发重排打分（rerankScorer 未被调用）');
  const firstCallScorerMs = +(lastScorerMs ?? 0).toFixed(1);

  await plain.search(picked[0].item.question, LIMIT);

  const samples = [];
  let budgetHit = false;
  const startedAt = Date.now();
  for (let i = 0; i < SAMPLES_PER_CONFIG; i++) {
    const pick = picked[i % picked.length];
    const t0 = performance.now();
    await withRerank.search(pick.item.question, LIMIT);
    const rerankMs = performance.now() - t0;
    const scorerMs = lastScorerMs;
    const passages = lastPassages;
    const t1 = performance.now();
    await plain.search(pick.item.question, LIMIT);
    const plainMs = performance.now() - t1;
    if (!Number.isFinite(scorerMs)) throw new Error('采样期未观测到 scorer 计时（重排链路未走通）');
    samples.push({
      group: pick.group,
      id: pick.id,
      rerankMs: +rerankMs.toFixed(1),
      plainMs: +plainMs.toFixed(1),
      stageMs: +(rerankMs - plainMs).toFixed(1),
      scorerMs: +scorerMs.toFixed(1),
      passages,
    });
    if (samples.length >= MIN_SAMPLES && Date.now() - startedAt > CONFIG_BUDGET_MS) {
      budgetHit = true;
      break;
    }
  }

  const stageStats = statsOf(samples.map((s) => s.stageMs));
  const scorerStats = statsOf(samples.map((s) => s.scorerMs));
  const passageTotal = samples.reduce((a, s) => a + s.passages, 0);
  const scorerTotal = samples.reduce((a, s) => a + s.scorerMs, 0);

  const result = {
    id: cfg.id,
    label: cfg.label,
    tuning: { ...tuning, window: cfg.window ?? 50 },
    samples: samples.length,
    sampleTarget: SAMPLES_PER_CONFIG,
    budgetHit,
    firstCallMs,
    firstCallScorerMs,
    loadApproxMs: +Math.max(0, firstCallScorerMs - (scorerStats?.p50 ?? 0)).toFixed(1),
    stage: stageStats,
    scorer: scorerStats,
    perInferenceMeanMs: passageTotal > 0 ? +(scorerTotal / passageTotal).toFixed(1) : null,
    passages: { mean: +(passageTotal / samples.length).toFixed(1), min: Math.min(...samples.map((s) => s.passages)), max: Math.max(...samples.map((s) => s.passages)) },
    raw: samples,
  };
  process.stdout.write(`PERF_RESULT ${JSON.stringify(result)}\n`);
}

// ---------------------------------------------------------------- 父：顺序跑档位 + 合并落盘

function machineFacts() {
  const cpus = os.cpus();
  let ortNode = null;
  try {
    ortNode = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'node_modules', 'onnxruntime-node', 'package.json'), 'utf8')).version;
  } catch {
    ortNode = null;
  }
  return {
    cpu: cpus[0]?.model ?? null,
    logicalCores: cpus.length,
    totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    onnxruntimeNode: ortNode,
    powerPlan: process.env.PERF_POWER_PLAN ?? null,
    cpuClockMhz: process.env.PERF_CPU_CLOCK_MHZ ?? null,
  };
}

function runParent() {
  const phase = argValue('--phase') ?? 'balanced';
  const only = argValue('--only');
  const wanted = only ? new Set(only.split(',')) : null;
  const configs = MATRIX.filter((c) => !wanted || wanted.has(c.id));
  if (configs.length === 0) throw new Error(`--only=${only} 未匹配任何档位`);

  console.log(`[perf-rerank] phase=${phase} 档位数=${configs.length}（顺序执行，单档最多 ${SAMPLES_PER_CONFIG} 次采样）`);
  const results = [];
  for (const cfg of configs) {
    const t0 = Date.now();
    const run = spawnSync(process.execPath, [__filename, '--worker', JSON.stringify(cfg)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) {
      const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split(/\r?\n/).slice(-6).join(' | ');
      results.push({ id: cfg.id, label: cfg.label, error: tail || `exit ${run.status}` });
      console.log(`  - ${cfg.id}: 失败（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      continue;
    }
    const line = (run.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('PERF_RESULT '));
    if (!line) {
      results.push({ id: cfg.id, label: cfg.label, error: '子进程未输出 PERF_RESULT' });
      console.log(`  - ${cfg.id}: 无结果`);
      continue;
    }
    const parsed = JSON.parse(line.slice('PERF_RESULT '.length));
    results.push(parsed);
    console.log(`  - ${cfg.id}: 完成（${((Date.now() - t0) / 1000).toFixed(1)}s，采样 ${parsed.samples}${parsed.budgetHit ? '（预算截断）' : ''}）`);
  }

  const existing = existsSync(OUT_FILE) ? JSON.parse(readFileSync(OUT_FILE, 'utf8')) : {};
  const report = {
    tool: 'perf-rerank-matrix',
    feature: 'feat-A030',
    updatedAt: new Date().toISOString(),
    model: 'bge-reranker-base（XLM-R seq-cls，onnx/model_quantized.onnx int8）',
    budget: { stageP95Ms: 1000, stageP50Ms: 600, decidedBy: '负责人 2026-09-28 拍板' },
    method: {
      stage: 'stageMs = 有重排检索耗时 − 无重排检索耗时（与 scripts/verify-rerank.mjs 同口径，可与 4134ms 基线对照）',
      scorer: 'scorerMs = 直接包住 scorer 调用的计时；rerankWindow 每次检索只调一次 scorer',
      perInference: 'perInferenceMeanMs = ΣscorerMs / Σpassages（passages = 实际进重排的窗口候选数，已扣保证区钉子）',
      firstCall: 'firstCallMs 含分词器 + ORT session 创建（266MB int8 权重）与首次推理',
      samples: `每档目标 ${SAMPLES_PER_CONFIG} 次、交替采样（有重排 / 无重排）；极慢档以 ${CONFIG_BUDGET_MS / 1000}s 预算提前截止（≥${MIN_SAMPLES} 次，标 budgetHit）`,
      questions: FIXPOINTS.map((f) => `${f.group} ${f.id}`),
      variantDesign: '单变量对照（一次只动一个变量）+ 组合候选；未做全交叉（4×4×3×2×2 组合不可跑完）',
      llmCalls: 0,
    },
    machine: machineFacts(),
    phases: existing.phases ?? {},
  };
  report.phases[phase] = { phase, ranAt: new Date().toISOString(), machine: machineFacts(), configs: results };
  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(report, null, 2), 'utf8');

  const bytes = statSync(OUT_FILE).size;
  const lines = readFileSync(OUT_FILE, 'utf8').split(/\r?\n/).length;
  console.log(`[perf-rerank] 落盘：${OUT_FILE}`);
  console.log(`[perf-rerank] phase=${phase} 档位=${results.filter((r) => !r.error).length}/${configs.length} 文件行数=${lines} 字节=${bytes}`);
}

const workerIndex = process.argv.indexOf('--worker');
if (workerIndex >= 0) {
  await runWorker(JSON.parse(process.argv[workerIndex + 1]));
} else {
  runParent();
}
