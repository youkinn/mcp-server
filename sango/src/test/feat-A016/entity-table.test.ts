/**
 * FEAT-A016 活文档：entity-table 归一化模块单测（表加载 / rewriteKeys 替换 / fragmentOnly 边界 /
 * 加载校验剔键 / 加载失败降级）。契约：接口 §1.6 / §2.1 / §6 验证方式；表设计 §7 内存结构 / §8 加载校验。
 * 真实表断言（行为样例与表设计 §8 验证方式）以 data/entity-table.json（合并产物）为锚。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadEntityTable,
  normalize,
  normVersion,
  rewriteKeyCount,
  rowsCount,
  fragmentKeyToCanon,
} from '../../normalize/entity-table.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'feat-A004', 'fixture');
const REAL_DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');

/** 临时目录工厂：写入 entity-table.json 后返回目录（测试结束清理）。 */
function makeTempTable(content: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'a016-et-'));
  writeFileSync(path.join(dir, 'entity-table.json'), JSON.stringify(content), 'utf8');
  return dir;
}

/** 截获 stderr：返回 [输出, 恢复]。 */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  return { lines, restore: () => (console.error = original) };
}

test('① 真实表加载：启动日志行 + rewriteKeyCount / normVersion / rowsCount 可读（接口 §2.1 日志口径）', () => {
  const cap = captureStderr();
  try {
    assert.equal(loadEntityTable(REAL_DATA_DIR), true);
  } finally {
    cap.restore();
  }
  const log = cap.lines.find((l) => l.includes('entity-table loaded'));
  assert.ok(log, '应输出 [sango] entity-table loaded 日志行');
  assert.match(log, /rows=407 keys=702 normVersion=\w{8}/, 'rows / keys / normVersion 齐全（bug-00036 两轮裁决后 keys=702）');
  assert.equal(rowsCount(), 407, 'person 193 + nonPerson 214');
  assert.equal(normVersion().length, 8, 'normVersion 为 8 位内容 hash');
  const table = JSON.parse(readFileSync(path.join(REAL_DATA_DIR, 'entity-table.json'), 'utf8')) as {
    rows: Array<{ rewriteKeys: string[] }>;
  };
  const rawKeyCount = new Set(table.rows.flatMap((r) => r.rewriteKeys)).size;
  assert.equal(rawKeyCount, 704, '原始表键数（锚点，bug-00036 两轮后：移出 13 键 + 出山 + 三结义 + 铜雀/博望/长坂，桃园结义 转键）');
  assert.equal(rewriteKeyCount(), rawKeyCount - 2, '模块生效计数 = 原始键 - 2 条 ambiguityGuard 禁入（晋王 / 舌战）');
});

test('② 行为样例（接口 §6 / 表设计 §8 验证方式）：rewriteKeys 替换、fragmentOnly 不替换、禁入词恒等', () => {
  loadEntityTable(REAL_DATA_DIR);
  assert.equal(normalize('五关斩六将'), '过五关斩六将', '换说法 → 规范形（验收 5 双侧替换的 query 侧）');
  assert.equal(normalize('千里走单骑'), '过五关斩六将', '第二改写键同目标');
  assert.equal(normalize('云长'), '关羽', '人物字号 → 规范形');
  assert.equal(normalize('右目'), '右眼', '身体方位 → 规范形（验收 3 夏侯惇样例）');
  assert.equal(normalize('天子'), '天子', '官职类 fragmentOnly 不参与 query 改写（K2 禁入）');
  assert.equal(normalize('关公'), '关公', '人物 fragmentOnly（跨主条目终审禁入）不做替换');
  assert.equal(normalize('甘露元年'), '甘露元年', '同串跨行键弃用后恒等（K3：魏/吴双目标不做改写）');
  assert.equal(normalize('子明'), '子明', 'bug-00031 冲突词出表后恒等（不进任何可替换集）');
  assert.equal(normalize('文帝'), '文帝', '跨主条目（同串跨人组）不替换（共享标签多挂，原文直配）');
  // bug-00036：邻接延伸检查（机制层）——长词 canonical 不因真子串键二次扩张
  assert.equal(normalize('长坂坡'), '长坂坡', '长坂 移出改写键后 canonical 恒等');
  assert.equal(normalize('长坂坡 赵云救阿斗'), '长坂坡 赵云救刘禅', '延伸检查不阻塞其他键改写（阿斗 → 刘禅）');
  assert.equal(normalize('博望之战'), '博望之战', '博望 移出改写键后恒等（不再改写成 博望坡之战）');
  assert.equal(normalize('铜雀台'), '铜雀台', '铜雀 移出改写键后 canonical 恒等');
  // bug-00036 第二轮（全表审计，2026-09-26）：变体专名不被插词污染——延伸检查兜不住
  // 铜雀宫 / 博望城·博望山 / 长坂桥·长坂城·长坂围（长坂桥 为第 42 回回目专名），三者随键转出而恒等
  assert.equal(normalize('铜雀宫'), '铜雀宫', '「铜雀宫」不再被 铜雀 键污染为 铜雀台宫');
  assert.equal(normalize('博望城'), '博望城', '「博望城」不再被 博望 键污染为 博望坡城');
  assert.equal(normalize('长坂桥'), '长坂桥', '「长坂桥」不再被 长坂 键污染为 长坂坡桥');
  // 提测 test-1921（2026-09-26）：桃园三结义 规范为 canonical，三写法同口径归一化——
  // 桃园三结义 恒等（不再被 三结义 键损坏为 桃园桃园结义）、桃园结义 / 桃园之盟 → 桃园三结义
  assert.equal(normalize('桃园三结义'), '桃园三结义', 'canonical 恒等，不再损坏为 桃园桃园结义');
  assert.equal(normalize('桃园结义'), '桃园三结义', '别名 → 规范形（提测 trace 96bbe8ae / 4f04f5f3）');
  assert.equal(normalize('桃园之盟'), '桃园三结义', '别名 → 规范形');
  // bug-00036 判据：三结义 ⊂ 桃园三结义 且非独立指称，移出改写键（负责人 2026-09-26 质疑确认）——
  // 延伸检查只覆盖「桃园三结义」完整对齐，覆盖不了「宴桃园豪杰三结义 / X 三结义」类上下文
  assert.equal(normalize('三结义'), '三结义', '三结义 移出改写键后恒等，不作替换');
  assert.equal(normalize('宴桃园豪杰三结义'), '宴桃园豪杰三结义', '回目「宴桃园豪杰三结义」不被插词污染');
  // bug-00036：数据层裁决——不合规子串键移出改写键（可转 fragmentOnly），原文恒等
  assert.equal(normalize('赤兔马'), '赤兔马', '赤兔 不在 rewriteKeys，canonical 原文不扩张');
  assert.equal(normalize('赤兔'), '赤兔', '赤兔 移入 fragmentOnly（query 侧不改写）');
  assert.equal(normalize('木牛流马'), '木牛流马', '木牛 / 流马 移出后长词不扩张');
  assert.equal(normalize('传国玉玺'), '传国玉玺', '玉玺 移出后长词不扩张');
  assert.equal(normalize('就会就计'), '就会就计', '就计 移出后不改写');
  assert.equal(normalize('遁甲'), '遁甲', '遁甲 跨行真子串（⊂奇门遁甲/遁甲天书）移出，恒等');
  // bug-00036：登场行或式 canonical 规范为 出山
  assert.equal(normalize('出仕'), '出山', '或式 canonical 规范后 出仕 → 出山');
  assert.equal(normalize('入仕'), '出山', '入仕 → 出山');
  assert.equal(normalize('出山'), '出山', '出山 为 canonical，恒等');
});

test('③ fragmentOnly 双写素材（表设计 §6 消费矩阵）：fragmentKeyToCanon 覆盖禁入词 → 规范形', () => {
  loadEntityTable(REAL_DATA_DIR);
  const fk = fragmentKeyToCanon();
  assert.equal(fk.get('天子'), '皇帝', '官职行 fragmentOnly → 规范形（索引侧双写扩展用）');
  assert.equal(fk.get('关公'), '关羽', '人物行 fragmentOnly → 规范形');
  assert.equal(fk.get('自刎'), '死亡', '死亡类多字短语 → 规范形（query「死亡」可词法命中含自刎片段）');
  assert.equal(fk.get('阿瞒'), undefined, '真实表无 阿瞒（草稿无该别名），夹具表才有');
  assert.equal(fk.get('赤兔'), '赤兔马', 'bug-00036：赤兔 移入 fragmentOnly（索引侧双写扩展）');
  assert.equal(fk.get('玉玺'), '传国玉玺', 'bug-00036：玉玺 移入 fragmentOnly');
  assert.equal(fk.get('木牛'), '木牛流马', 'bug-00036：木牛 移入 fragmentOnly');
  assert.equal(fk.get('就计'), '将计就计', 'bug-00036：就计 移入 fragmentOnly');
});

test('④ 加载失败降级（接口 §1.6）：文件缺失 / JSON 损坏 / schemaVersion 非法 / 有效行数 0 → normalize 恒等', () => {
  const cap = captureStderr();
  try {
    // 文件缺失
    const empty = mkdtempSync(path.join(tmpdir(), 'a016-nofile-'));
    try {
      assert.equal(loadEntityTable(empty), false);
      assert.equal(normalize('云长'), '云长', '缺表 → 恒等归一化');
      assert.equal(rewriteKeyCount(), 0);
      assert.equal(normVersion(), '');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    // JSON 损坏
    const badJson = makeTempTable('{oops');
    try {
      assert.equal(loadEntityTable(badJson), false);
      assert.equal(normalize('五关斩六将'), '五关斩六将');
    } finally {
      rmSync(badJson, { recursive: true, force: true });
    }
    // schemaVersion != 1
    const badSchema = makeTempTable({
      meta: { schemaVersion: 2, normVersion: 'xxxxxxxx', generatedAt: '' },
      rows: [],
      policy: { bannedRewriteKeys: [], ambiguityGuard: [] },
    });
    try {
      assert.equal(loadEntityTable(badSchema), false, 'schemaVersion=2 → 降级');
    } finally {
      rmSync(badSchema, { recursive: true, force: true });
    }
    // 有效行数 0（rows 存在但全被校验剔除）
    const emptyRows = makeTempTable({
      meta: { schemaVersion: 1, normVersion: 'xxxxxxxx', generatedAt: '' },
      rows: [{ type: '人物', id: null, canonical: '路人甲', aliases: [], rewriteKeys: [], fragmentOnly: [], organGuard: null }],
      policy: { bannedRewriteKeys: [], ambiguityGuard: [] },
    });
    try {
      assert.equal(loadEntityTable(emptyRows), false, '有效行数 0 → 降级');
    } finally {
      rmSync(emptyRows, { recursive: true, force: true });
    }
    const degraded = cap.lines.filter((l) => l.includes('entity-table 加载失败'));
    assert.equal(degraded.length, 4, '四条降级告警（缺文件 / 坏 JSON / schema / 有效行 0）');
    assert.ok(
      degraded.some((l) => l.includes('JSON 解析失败')) &&
        degraded.some((l) => l.includes('结构非法')) &&
        degraded.some((l) => l.includes('有效行数 0')),
      '缺文件 / 坏 JSON / schema / 有效行 0 四类原因齐备',
    );
  } finally {
    cap.restore();
  }
});

test('⑤ 加载校验八条（表设计 §8）：违规 = 告警 + 剔键 / 剔行，不拒全表不崩', () => {
  const cap = captureStderr();
  try {
    const dir = makeTempTable({
      meta: { schemaVersion: 1, normVersion: 'ffffffff', generatedAt: '' },
      rows: [
        { type: '人物', id: 'P001', canonical: '刘备', aliases: ['玄德'], rewriteKeys: ['玄德'], fragmentOnly: [], organGuard: null },
        { type: '人物', id: 'P002', canonical: '关羽', aliases: ['云长', '目'], rewriteKeys: ['云长', '目'], fragmentOnly: [], organGuard: null },
        { type: '人物', id: 'P003', canonical: '司马昭', aliases: ['文帝', '晋王'], rewriteKeys: ['文帝', '晋王'], fragmentOnly: [], organGuard: null },
        { type: '人物', id: 'P004', canonical: '关羽', aliases: ['关公'], rewriteKeys: ['关公'], fragmentOnly: [], organGuard: null },
        { type: '人物', id: 'P005', canonical: '曹操', aliases: ['曹操'], rewriteKeys: ['孟德'], fragmentOnly: [], organGuard: null },
        { type: '人物', id: null, canonical: '孙权', aliases: ['仲谋'], rewriteKeys: ['仲谋'], fragmentOnly: [], organGuard: null },
        { type: '人物', id: 'P006', canonical: '赵云', aliases: ['玄德', '子龙'], rewriteKeys: ['玄德', '子龙'], fragmentOnly: [], organGuard: null },
        { type: '人物', id: 'P007', canonical: '庞统', aliases: ['凤雏', '庞统'], rewriteKeys: ['凤雏', '庞统'], fragmentOnly: [], organGuard: null },
      ],
      policy: { bannedRewriteKeys: ['文帝'], ambiguityGuard: [] },
    });
    try {
      assert.equal(loadEntityTable(dir), true, '违规存在仍成功加载（不拒全表）');
      assert.equal(normalize('玄德'), '玄德', '跨行重复键（刘备 / 赵云两行）整体弃用（§8 #6）');
      assert.equal(normalize('子龙'), '赵云', '不重复键照常生效');
      assert.equal(normalize('云长'), '关羽', '单字键所在行其余键照常生效');
      assert.equal(normalize('目'), '目', '单字键被剔除（K1）');
      assert.equal(normalize('文帝'), '文帝', 'banned 键被剔除（K2）');
      assert.equal(normalize('晋王'), '司马昭', '同一行其余键照常生效');
      assert.equal(normalize('孟德'), '孟德', 'rewriteKeys ⊄ aliases 的键被剔除');
      assert.equal(normalize('仲谋'), '仲谋', 'id 缺行整行剔除（键不生效）');
      assert.equal(normalize('凤雏'), '庞统', 'canonical 自指键（庞统）被剔除后其余键照常');
      const warnings = cap.lines.filter((l) => l.includes('entity-table 校验'));
      assert.ok(warnings.length >= 7, `八条校验逐类告警（实际 ${warnings.length} 条）`);
      assert.ok(warnings.some((l) => l.includes('单字')), '单字键告警');
      assert.ok(warnings.some((l) => l.includes('bannedRewriteKeys')), 'banned 键告警');
      assert.ok(warnings.some((l) => l.includes('canonical 在 type')), 'canonical 重复告警');
      assert.ok(warnings.some((l) => l.includes('跨行重复')), '跨行键告警');
      assert.ok(warnings.some((l) => l.includes('不在 aliases')), '⊄ aliases 告警');
      assert.ok(warnings.some((l) => l.includes('id 缺失')), 'id 缺失告警');
      assert.ok(warnings.some((l) => l.includes('canonical 出现在本行 rewriteKeys')), 'canonical 自指键告警（§8 #8）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cap.restore();
  }
});

test('⑥ 夹具表（feat-A004 同源）：rewriteKeyCount / 替换 / fragmentOnly 边界', () => {
  assert.equal(loadEntityTable(FIXTURE_DIR), true);
  assert.equal(rowsCount(), 2);
  assert.equal(rewriteKeyCount(), 2, '孟德 + 云长（阿瞒 / 关公 为 fragmentOnly，不计入）');
  assert.equal(normVersion(), '5f0a1c2d');
  assert.equal(normalize('孟德'), '曹操');
  assert.equal(normalize('云长'), '关羽');
  assert.equal(normalize('阿瞒'), '阿瞒', 'fragmentOnly 不参与 query 改写');
  assert.equal(normalize('关公'), '关公', 'fragmentOnly（banned 词）不参与 query 改写');
});

test('⑦ 键排斥规则 + 邻接延伸检查（bug-00036）：跨行 canonical 真子串剔键；本行子串短式保留且不扩张长词', () => {
  const cap = captureStderr();
  try {
    const dir = makeTempTable({
      meta: { schemaVersion: 1, normVersion: 'ffffffff', generatedAt: '' },
      rows: [
        // 本行 canonical 子串短式（保留，依赖邻接延伸检查兜底）
        { type: '地名', id: null, canonical: '博望坡', aliases: ['博望', '长坂桥'], rewriteKeys: ['博望'], fragmentOnly: [], organGuard: null, note: 'bug-00036：裁决保留' },
        { type: '地名', id: null, canonical: '长坂坡', aliases: ['长坂'], rewriteKeys: ['长坂'], fragmentOnly: [], organGuard: null, note: 'bug-00036：裁决保留' },
        // 跨行 canonical 真子串键（K4：告警 + 剔键）
        { type: '典故', id: null, canonical: '奇门遁甲', aliases: ['遁甲'], rewriteKeys: ['遁甲'], fragmentOnly: [], organGuard: null },
        { type: '器物', id: null, canonical: '遁甲天书', aliases: ['天书三卷'], rewriteKeys: ['天书三卷'], fragmentOnly: [], organGuard: null },
      ],
      policy: { bannedRewriteKeys: [], ambiguityGuard: [] },
    });
    try {
      assert.equal(loadEntityTable(dir), true, '存在违规键仍成功加载（不拒全表）');
      assert.equal(normalize('博望之战'), '博望坡之战', '独立语境 博望 → 博望坡 照常改写');
      assert.equal(normalize('博望坡'), '博望坡', '长词 canonical 不因 博望 键二次扩张');
      assert.equal(normalize('长坂坡'), '长坂坡', '长坂 命中处延伸为 长坂坡 → 不替换');
      assert.equal(normalize('长坂桥'), '长坂桥', '延伸检查覆盖 aliases（长坂桥 为表内已知词）');
      assert.equal(normalize('遁甲'), '遁甲', '跨行 canonical 真子串键被剔（K4），恒等');
      assert.equal(normalize('遁甲天书'), '遁甲天书', '他行 longer canonical 不受影响');
      const warnings = cap.lines.filter((l) => l.includes('entity-table 校验'));
      assert.ok(
        warnings.some((l) => l.includes('真子串') && l.includes('K4')),
        '跨行 canonical 真子串键告警（K4）',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cap.restore();
  }
});
