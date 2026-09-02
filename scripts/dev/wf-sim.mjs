#!/usr/bin/env node
// wf-sim.mjs — 워크플로 스크립트(workflows/*.js)를 Workflow 툴 없이 실행해 **제어 흐름**을 검사한다. 에이전트는 스텁이다.
// 실제 모델을 부르지 않으므로 "레인 수·순서·schema 유무·model 명시·반환 모양" 만 검증한다 — 품질 판정은 아니다.
//
// 사용:
//   node scripts/dev/wf-sim.mjs <workflow.js> [--args '<json>'] [--responses <json 파일>] [--json]
//   responses 파일: { "<label 접두어 | /정규식/ | phase 이름>": <스텁 반환값> } — 없으면 schema 에서 최소 객체를 합성한다.
// 출력: { meta, calls[{label, model, phase, hasSchema, isolation}], phases[], logs[], warnings[], result }
// 종료 코드: 0 · 워크플로가 throw 하면 1 · 규칙 위반(model 누락 등)은 warnings 로만(--strict 면 1).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: wf-sim.mjs <workflow.js> [--args json] [--responses file] [--json] [--strict]'); process.exit(2); }
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = opt('--args') ? JSON.parse(opt('--args')) : undefined;
const responses = opt('--responses') ? JSON.parse(readFileSync(resolve(opt('--responses')), 'utf8')) : {};
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');

let src = readFileSync(resolve(file), 'utf8');
if (!/^\s*export const meta\s*=/m.test(src)) { console.error('워크플로 파일은 `export const meta = {...}` 로 시작해야 한다'); process.exit(1); }
// meta 는 리터럴이 평가되는 그 자리에서 잡는다 — 워크플로는 top-level `return` 으로 끝나므로 본문 뒤에 붙인 줄은 절대 실행되지 않고,
// args 검증에서 throw 하는 경우에도 meta 는 이미 잡혀 있어야 한다.
src = src.replace(/^\s*export const meta\s*=/m, 'var meta = __sim.meta =');

const calls = [], phases = [], logs = [], warnings = [];
let currentPhase = null, seq = 0;

function synth(schema) {
  if (!schema || typeof schema !== 'object') return 'stub';
  if (schema.enum) return schema.enum[0];
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (t) {
    case 'string': return 'stub';
    case 'number': case 'integer': return schema.minimum ?? 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': {
      const o = {};
      for (const k of Object.keys(schema.properties ?? {})) o[k] = synth(schema.properties[k]);
      return o;
    }
    default: return null;
  }
}
function pick(label, phase) {
  for (const [k, v] of Object.entries(responses)) {
    if (k.startsWith('/') && k.endsWith('/')) { if (new RegExp(k.slice(1, -1)).test(label ?? '')) return v; }
    else if ((label ?? '').startsWith(k) || phase === k) return v;
  }
  return undefined;
}

const __sim = { meta: null };
const agent = async (prompt, opts = {}) => {
  const n = ++seq;
  const rec = { n, label: opts.label ?? `agent#${n}`, model: opts.model ?? null, phase: opts.phase ?? currentPhase, hasSchema: !!opts.schema, isolation: opts.isolation ?? null, promptChars: String(prompt ?? '').length };
  calls.push(rec);
  if (!opts.model) warnings.push(`agent() #${n} "${rec.label}" 에 model 이 없다`);
  if (!prompt || String(prompt).length < 40) warnings.push(`agent() #${n} "${rec.label}" 프롬프트가 너무 짧다(${rec.promptChars}자)`);
  const r = pick(rec.label, rec.phase);
  if (r !== undefined) return typeof r === 'string' && r === '__null__' ? null : r;
  return opts.schema ? synth(opts.schema) : `stub text for ${rec.label}`;
};
const parallel = async (thunks) => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)));
const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => {
  let v = item;
  for (const st of stages) { try { v = await st(v, item, i); } catch { return null; } }
  return v;
}));
const phase = (t) => { currentPhase = t; phases.push(t); };
const log = (m) => logs.push(String(m));
const budget = { total: null, spent: () => 0, remaining: () => Infinity };
const workflow = async () => { throw new Error('wf-sim: 중첩 workflow() 는 지원하지 않는다'); };

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let result, error = null;
try {
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', '__sim', src);
  result = await fn(agent, parallel, pipeline, phase, log, args, budget, workflow, __sim);
} catch (e) { error = e; }

const meta = __sim.meta;
if (meta) {
  const declared = (meta.phases ?? []).map(p => p.title);
  for (const p of phases) if (declared.length && !declared.includes(p)) warnings.push(`phase("${p}") 가 meta.phases 에 없다`);
  if (!meta.name || !meta.description) warnings.push('meta.name / meta.description 누락');
} else warnings.push('meta 를 읽지 못했다');

const out = { file, meta, calls, phases, logs, warnings, result, error: error ? String(error.stack ?? error) : null };
if (asJson) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`workflow ${meta?.name ?? '?'} — agent 호출 ${calls.length}건 · phase ${phases.length} · 경고 ${warnings.length}`);
  for (const c of calls) console.log(`  #${c.n} [${c.phase ?? '-'}] ${c.label} model=${c.model ?? '(없음)'} schema=${c.hasSchema ? 'Y' : 'N'}${c.isolation ? ' worktree' : ''}`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  if (error) console.log(`  ✖ ${error.message}`);
  console.log('  result:', JSON.stringify(result));
}
process.exit(error ? 1 : (strict && warnings.length ? 1 : 0));
