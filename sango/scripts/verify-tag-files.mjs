#!/usr/bin/env node
/**
 * feat-A014 标签体系数据侧静态校验（零 LLM）。
 *
 * 对 sango/data/corpus/tags/{event,story,duel}.json 做全量静态断言：
 *   - chunkId 必须存在于语料（死键 = 0）
 *   - event.json 只含 人物之生-XX登场 / 人物之死-XX之死 两类，多标签 | 分隔且不重复
 *   - 同一人物只记首次登场（无重复登场标签）
 *   - 登场/之死/单挑人名须用 alias 规范名（alias.json 覆盖到的人，须等于 build_alias.py
 *     PERSONS 表登记的规范名；未覆盖者不校验）
 *   - story.json 典故名无前缀、无解释、无句号/标点（豁免「既生瑜，何生亮」）
 *   - duel.json 格式须为 武将单挑-武将A-武将B，A、B 不同人
 *
 * 只断言数据文件本身，不做检索侧断言。
 *
 * 用法：
 *   node scripts/verify-tag-files.mjs
 * 退出码：0 = 全部通过；1 = 存在失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_BASE = path.resolve(HERE, '..', 'data', 'corpus');
const CORPUS_DIR = path.join(CORPUS_BASE, 'sanguo-yanyi');
const TAG_DIR = path.join(CORPUS_BASE, 'tags');
const ALIAS_FILE = path.join(path.resolve(HERE, '..', 'data'), 'alias.json');
const ALIAS_BUILD_SCRIPT = path.join(HERE, 'build_alias.py');

const BIRTH_RE = /^人物之生-(.+)登场$/;
const DEATH_RE = /^人物之死-(.+)之死$/;
const DUEL_RE = /^武将单挑-([^-]+)-([^-]+)$/;
const STORY_PUNCT_RE = /[，。、；：？！“”‘’「」『』《》〈〉【】（）…·—–-]/;
const STORY_EXEMPT = new Set(['既生瑜，何生亮']);
const EVENT_COUNT_EXPECT = { birth: 135, death: 336, total: 471, entries: 354 };
const STORY_ENTRIES_EXPECT = 334;
const DUEL_ENTRIES_EXPECT = 39;

let failures = 0;
let checks = 0;

function assert(cond, msg) {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

/** 读语料全部 chunk：{ id → text }。 */
function loadCorpus() {
  const chunks = new Map();
  const files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8'));
    for (const ch of doc.chunks) chunks.set(ch.id, ch.text);
  }
  return chunks;
}

/**
 * 从 build_alias.py 的 PERSONS 表解析规范名（P001 起按表序）。
 * 规范名 = PERSONS 每行元组的首元素；别名经 data/alias.json 映射到 PID 后回查。
 */
function loadCanonicalNames() {
  const src = fs.readFileSync(ALIAS_BUILD_SCRIPT, 'utf8');
  const m = src.match(/PERSONS\s*=\s*\[([\s\S]*?)\n\]/);
  if (!m) throw new Error('build_alias.py 中找不到 PERSONS 表');
  const names = [];
  for (const line of m[1].split('\n')) {
    const hit = line.match(/^\s*\(\s*"([^"]+)"\s*,\s*\[/);
    if (hit) names.push(hit[1]);
  }
  const byPid = {};
  names.forEach((name, i) => {
    byPid[`P${String(i + 1).padStart(3, '0')}`] = name;
  });
  return byPid;
}

const corpus = loadCorpus();
const alias = JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8'));
const canonicalByPid = loadCanonicalNames();

section('自检：alias 规范名表');
assert(canonicalByPid.P001 === '刘备' && canonicalByPid.P002 === '关羽', 'P001=刘备、P002=关羽（build_alias.py 登记）');

/** 人名 → 规范名：alias 表覆盖的在册人物映射到规范名，未覆盖的按原名。 */
function canonicalPerson(name) {
  const pid = alias[name];
  if (!pid) return name;
  return canonicalByPid[pid] ?? name;
}

section('event.json');
{
  const file = path.join(TAG_DIR, 'event.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = Object.keys(data);
  let birth = 0;
  let death = 0;
  const debutByPid = new Map();
  const badNames = [];

  assert(keys.length === EVENT_COUNT_EXPECT.entries, `条目数 = ${EVENT_COUNT_EXPECT.entries}（实际 ${keys.length}）`);

  for (const key of keys) {
    assert(corpus.has(key), `chunkId 在语料中：${key}`);
    const tags = data[key].split('|');
    assert(new Set(tags).size === tags.length, `chunk 内无重复标签：${key}`);
    for (const tag of tags) {
      const birthHit = tag.match(BIRTH_RE);
      const deathHit = tag.match(DEATH_RE);
      assert(Boolean(birthHit) || Boolean(deathHit), `标签格式合规：${key} => ${tag}`);
      if (birthHit) {
        birth += 1;
        const pid = canonicalPerson(birthHit[1]);
        assert(!debutByPid.has(pid), `人物首次登场只记一次：${birthHit[1]}`);
        debutByPid.set(pid, key);
        if (alias[birthHit[1]] && canonicalPerson(birthHit[1]) !== birthHit[1]) {
          badNames.push(`登场:${birthHit[1]}`);
        }
      } else if (deathHit) {
        death += 1;
        if (alias[deathHit[1]] && canonicalPerson(deathHit[1]) !== deathHit[1]) {
          badNames.push(`之死:${deathHit[1]}`);
        }
      }
    }
  }

  assert(
    birth === EVENT_COUNT_EXPECT.birth && death === EVENT_COUNT_EXPECT.death,
    `生 ${EVENT_COUNT_EXPECT.birth} / 死 ${EVENT_COUNT_EXPECT.death} / 总 ${EVENT_COUNT_EXPECT.total}（实际 ${birth} / ${death} / ${birth + death}）`,
  );
  assert(badNames.length === 0, `登场/之死人名均为 alias 规范名` + (badNames.length ? `（命中：${badNames.join('、')}）` : '（未命中别名）'));
}

section('story.json');
{
  const data = JSON.parse(fs.readFileSync(path.join(TAG_DIR, 'story.json'), 'utf8'));
  const keys = Object.keys(data);
  const names = new Set();

  assert(keys.length === STORY_ENTRIES_EXPECT, `条目数 = ${STORY_ENTRIES_EXPECT}（实际 ${keys.length}）`);
  for (const key of keys) {
    assert(corpus.has(key), `chunkId 在语料中：${key}`);
    const tags = data[key].split('|');
    assert(new Set(tags).size === tags.length, `chunk 内无重复典故名：${key}`);
    for (const name of tags) {
      names.add(name);
      assert(name.length > 0, `典故名非空：${key}`);
      assert(!/^(典故|成语|俗语)-/.test(name), `典故名无前缀：${key} => ${name}`);
      assert(
        STORY_EXEMPT.has(name) || !STORY_PUNCT_RE.test(name),
        `典故名无标点（豁免「既生瑜，何生亮」）：${key} => ${name}`,
      );
      assert(
        !/^人物之(生|死)-/.test(name) && !/^武将单挑-/.test(name),
        `典故名不混入事件/单挑格式：${key} => ${name}`,
      );
    }
  }
  assert(names.size > 0, `唯一典故名 ${names.size} 个（正值）`);
}

section('duel.json');
{
  const data = JSON.parse(fs.readFileSync(path.join(TAG_DIR, 'duel.json'), 'utf8'));
  const keys = Object.keys(data);
  const badNames = [];

  assert(keys.length === DUEL_ENTRIES_EXPECT, `条目数 = ${DUEL_ENTRIES_EXPECT}（实际 ${keys.length}）`);
  for (const key of keys) {
    assert(corpus.has(key), `chunkId 在语料中：${key}`);
    const tags = data[key].split('|');
    assert(new Set(tags).size === tags.length, `chunk 内无重复单挑标签：${key}`);
    for (const tag of tags) {
      const m = tag.match(DUEL_RE);
      assert(Boolean(m), `单挑格式 武将单挑-武将A-武将B：${key} => ${tag}`);
      if (m) {
        assert(m[1] !== m[2], `单挑双方非同一人：${key} => ${tag}`);
        for (const name of [m[1], m[2]]) {
          if (alias[name] && canonicalPerson(name) !== name) {
            badNames.push(name);
          }
        }
      }
    }
  }
  assert(badNames.length === 0, `单挑人名均为 alias 规范名` + (badNames.length ? `（命中：${badNames.join('、')}）` : '（未命中别名）'));
}

section('汇总');
console.log(`  断言 ${checks} 项，失败 ${failures} 项`);
console.log('  死键：chunkId 缺失即报错（见上逐条断言），以上失败为 0 即三文件死键 = 0');
process.exit(failures === 0 ? 0 : 1);
