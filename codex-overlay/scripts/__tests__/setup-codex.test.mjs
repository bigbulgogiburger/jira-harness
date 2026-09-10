import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const setup = fileURLToPath(new URL('../setup.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/harness.json', import.meta.url));
function run(root, ...args) {
  return spawnSync(process.execPath, [setup, ...args, '--cwd', root, '--json'], { encoding: 'utf8', windowsHide: true });
}

test('Codex setup preserves existing TOML and returns registration argv on repeated writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'jh-codex-setup-'));
  mkdirSync(join(root, '.codex'));
  const file = join(root, '.codex/config.toml');
  const original = '# keep comments\n[features]\nhooks = true\n';
  writeFileSync(file, original);
  for (const status of ['created', 'unchanged']) {
    const result = run(root, 'write', '--config', fixture);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.config.status, status);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(body.settings.status, 'registration-required');
    assert.deepEqual(body.settings.commands, [
      ['codex', 'plugin', 'marketplace', 'add', 'bigbulgogiburger/jira-harness_codex'],
      ['codex', 'plugin', 'add', 'jira-harness@jira-harness-codex'],
    ]);
  }
  const upgrade = run(root, 'upgrade', '--apply');
  assert.equal(upgrade.status, 2);
  assert.equal(JSON.parse(upgrade.stdout).code, 'UNSUPPORTED_CODEX_UPGRADE');
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('fresh Codex setup never creates JSON masquerading as config.toml', () => {
  const root = mkdtempSync(join(tmpdir(), 'jh-codex-setup-'));
  const result = run(root, 'write', '--config', fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, '.codex/harness.json')));
  assert.equal(existsSync(join(root, '.codex/config.toml')), false);
});
