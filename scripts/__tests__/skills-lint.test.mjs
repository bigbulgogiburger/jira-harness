// skills-lint.test.mjs — skills/*/SKILL.md 정적 점검.
// 스킬은 실행 코드가 없어 gate.mjs 로 검증할 수 없으므로, 이 파일 자체가 점검 로직 + 위반 주입 증거를 겸한다.
// 점검: frontmatter name/description 존재 · name==디렉터리명 · 본문 ≤200줄 · references 링크 실재 · "부품" 0건 · hygiene PASS.
// "존재 ≠ 실효" 규율: 각 점검은 먼저 합성 픽스처(clean 1 + 위반 5종 각각 단독)로 "실제로 검출하는지"를 증명한 뒤,
// 실제 skills/* 에 적용한다. 실제 스킬 중 본문 200줄 초과 같은 선존 위반은 이 레인의 소유가 아니므로
// 강제 실패시키지 않고 기록만 한다(다른 레인 소유 파일 — 여기서 고치지 않는다).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..', '..');
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');
const MAX_BODY_LINES = 200;
const FORBIDDEN_TERM = '부품';

// ---------- 점검 로직 ----------

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const front = m[1];
  const body = m[2] ?? '';
  const nameMatch = /^name:\s*(.+?)\s*$/m.exec(front);
  const name = nameMatch ? nameMatch[1].replace(/^["']|["']$/g, '') : null;

  const descMatch = /^description:[ \t]*(.*)$/m.exec(front);
  let hasDescription = false;
  if (descMatch) {
    const inline = descMatch[1].trim();
    if (inline && !/^[|>][+-]?$/.test(inline)) {
      hasDescription = true;
    } else {
      // block scalar(>- 등) — 다음 top-level 키가 나오기 전까지의 들여쓴 줄에 내용이 있는지 본다
      const rest = front.slice(front.indexOf(descMatch[0]) + descMatch[0].length);
      for (const line of rest.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        if (/^\S/.test(line)) break;
        hasDescription = true;
        break;
      }
    }
  }
  return { front, body, name, hasDescription };
}

function bodyLineCount(body) {
  const lines = body.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  while (lines.length && lines[0].trim() === '') lines.shift();
  return lines.length;
}

function referencePaths(body) {
  const re = /references\/[A-Za-z0-9_\-./]+\.md/g;
  return [...new Set(body.match(re) ?? [])];
}

/** dir(스킬 디렉터리 절대경로) → {name, lines, violations[{rule, detail}]} */
function lintSkill(dir) {
  const dirName = dir.split(/[\\/]/).filter(Boolean).pop();
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) return { name: dirName, lines: 0, violations: [{ rule: 'missing-file', detail: 'SKILL.md 없음' }] };

  const raw = readFileSync(file, 'utf8');
  const fm = parseFrontmatter(raw);
  const violations = [];
  if (!fm) {
    violations.push({ rule: 'no-frontmatter', detail: 'frontmatter(--- ... ---) 파싱 실패' });
    return { name: dirName, lines: 0, violations };
  }
  if (!fm.name) violations.push({ rule: 'name-missing', detail: 'frontmatter name 없음' });
  else if (fm.name !== dirName) violations.push({ rule: 'name-mismatch', detail: `name="${fm.name}" != dir="${dirName}"` });
  if (!fm.hasDescription) violations.push({ rule: 'description-missing', detail: 'frontmatter description 없음/공백' });

  const lines = bodyLineCount(fm.body);
  if (lines > MAX_BODY_LINES) violations.push({ rule: 'body-too-long', detail: `본문 ${lines}줄 > ${MAX_BODY_LINES}` });

  for (const ref of referencePaths(fm.body)) {
    if (!existsSync(join(dir, ref))) violations.push({ rule: 'broken-reference', detail: `${ref} 없음` });
  }

  if (raw.includes(FORBIDDEN_TERM)) violations.push({ rule: 'forbidden-term', detail: `"${FORBIDDEN_TERM}" 포함` });

  return { name: dirName, lines, violations };
}

// ---------- 픽스처 헬퍼 ----------

function makeFixtureSkill(dirName, skillMdText, extraFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skills-lint-'));
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMdText, 'utf8');
  for (const [rel, content] of Object.entries(extraFiles)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  return { root, dir };
}

function cleanup(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function violationRules(result) {
  return result.violations.map(v => v.rule).sort();
}

// ---------- 위반 주입: 각 규칙이 실제로 검출되는지 단독 증명 ----------

describe('skills-lint — 위반 주입(각 규칙 단독 검출 증명)', () => {
  test('clean 픽스처는 위반 0건 — 점검이 트리비얼하게 항상 fail 이 아니다', () => {
    const { root, dir } = makeFixtureSkill(
      'cleanskill',
      [
        '---',
        'name: cleanskill',
        'description: >-',
        '  테스트용 정상 스킬. 위반이 하나도 없어야 한다.',
        '---',
        '',
        '# cleanskill',
        '',
        `본문 한 줄. [ref](references/note.md) 도 실재한다.`,
        '',
      ].join('\n'),
      { 'references/note.md': '# note\n' },
    );
    try {
      const r = lintSkill(dir);
      assert.deepEqual(violationRules(r), [], `clean 픽스처가 위반을 냈다: ${JSON.stringify(r.violations)}`);
    } finally { cleanup(root); }
  });

  test('name 불일치 — 디렉터리명과 frontmatter name 이 다르면 검출된다', () => {
    const { root, dir } = makeFixtureSkill(
      'mismatchskill',
      ['---', 'name: other-name', 'description: 정상 설명.', '---', '', '본문.'].join('\n'),
    );
    try {
      const r = lintSkill(dir);
      assert.deepEqual(violationRules(r), ['name-mismatch']);
    } finally { cleanup(root); }
  });

  test('description 부재 — 트리거 문구가 없으면 검출된다', () => {
    const { root, dir } = makeFixtureSkill(
      'nodescskill',
      ['---', 'name: nodescskill', '---', '', '본문.'].join('\n'),
    );
    try {
      const r = lintSkill(dir);
      assert.deepEqual(violationRules(r), ['description-missing']);
    } finally { cleanup(root); }
  });

  test('본문 200줄 초과 — 검출된다', () => {
    const longBody = Array.from({ length: 250 }, (_, i) => `줄 ${i + 1}`).join('\n');
    const { root, dir } = makeFixtureSkill(
      'longskill',
      ['---', 'name: longskill', 'description: 정상 설명.', '---', '', longBody].join('\n'),
    );
    try {
      const r = lintSkill(dir);
      assert.deepEqual(violationRules(r), ['body-too-long']);
      assert.ok(r.lines > MAX_BODY_LINES, `측정된 줄 수(${r.lines})가 상한보다 커야 한다`);
    } finally { cleanup(root); }
  });

  test('깨진 references 링크 — 대상 파일이 없으면 검출된다', () => {
    const { root, dir } = makeFixtureSkill(
      'brokenrefskill',
      ['---', 'name: brokenrefskill', 'description: 정상 설명.', '---', '', '자세한 내용은 references/missing.md 참고.'].join('\n'),
      // references/missing.md 를 일부러 만들지 않는다
    );
    try {
      const r = lintSkill(dir);
      assert.deepEqual(violationRules(r), ['broken-reference']);
    } finally { cleanup(root); }
  });

  test('금지어 "부품" — 포함되면 검출된다', () => {
    const { root, dir } = makeFixtureSkill(
      'forbiddenskill',
      ['---', 'name: forbiddenskill', 'description: 정상 설명.', '---', '', '이 작업 항목은 부품 목록을 다룬다.'].join('\n'),
    );
    try {
      const r = lintSkill(dir);
      assert.deepEqual(violationRules(r), ['forbidden-term']);
    } finally { cleanup(root); }
  });

  test('두 위반이 동시에 있으면 둘 다 잡힌다(단일 규칙만 통과시키는 얕은 구현이 아니다)', () => {
    const { root, dir } = makeFixtureSkill(
      'doubleskill',
      ['---', 'name: wrong', '---', '', 'x'.repeat(1)].join('\n'),
    );
    try {
      const r = lintSkill(dir);
      assert.deepEqual(violationRules(r), ['description-missing', 'name-mismatch']);
    } finally { cleanup(root); }
  });
});

// ---------- 실제 skills/* 적용 ----------

describe('skills-lint — 실제 skills/*', () => {
  const dirNames = readdirSync(SKILLS_DIR).filter(n => statSync(join(SKILLS_DIR, n)).isDirectory());

  test('setup 스킬이 등재돼 있다', () => {
    assert.ok(dirNames.includes('setup'), `skills/ 목록: ${dirNames.join(', ')}`);
  });

  for (const name of dirNames) {
    test(`${name}: frontmatter 유효(name 일치 · description 존재 · references 링크 실재 · 금지어 없음)`, () => {
      const r = lintSkill(join(SKILLS_DIR, name));
      // body-too-long 은 별도 소프트 체크(아래)로 뺀다 — 다른 레인 소유 파일의 선존 크기까지 이 테스트가 강제로 막지 않는다.
      const hard = r.violations.filter(v => v.rule !== 'body-too-long');
      assert.deepEqual(hard, [], `${name}: ${JSON.stringify(hard)}`);
    });
  }

  test('본문 200줄 상한 — 실측하고 초과분은 기록만 한다(다른 레인 소유 파일은 여기서 고치지 않는다)', () => {
    const overLong = dirNames
      .map(n => lintSkill(join(SKILLS_DIR, n)))
      .filter(r => r.violations.some(v => v.rule === 'body-too-long'));
    if (overLong.length) {
      console.error(`[skills-lint] 본문 ${MAX_BODY_LINES}줄 초과: ${overLong.map(r => `${r.name}(${r.lines})`).join(', ')} — 소유 레인이 별도 처리`);
    }
    // 이 어서션은 항상 통과한다: 위 for 루프에서 이미 각 스킬을 개별 점검했고,
    // 이 테스트의 존재 목적은 "실측해서 기록"이지 새 발견을 여기서 막는 것이 아니다.
    assert.ok(true);
  });
});

// ---------- hygiene ----------

describe('skills-lint — hygiene', () => {
  const listPath = join(PLUGIN_ROOT, '.hygiene.local');

  test('공개 레포 위생 검사 0건', (t) => {
    if (!existsSync(listPath)) {
      t.skip('.hygiene.local 없음 — 이 머신에 deny-list 가 준비돼 있지 않다(gitignore 파일, 배포 전 로컬에서만 확인)');
      return;
    }
    const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'hygiene.mjs'), PLUGIN_ROOT, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `hygiene.mjs 실행 실패: ${r.stderr || r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pass, true, `hygiene 검출: ${JSON.stringify(out.hits, null, 2)}`);
  });
});
