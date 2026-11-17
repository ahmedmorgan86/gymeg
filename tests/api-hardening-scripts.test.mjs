import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('B09: integration runner registers every suite and labels external prerequisites', async () => {
  const runner = await read('scripts/run-integration-tests.mjs');
  for (const suite of [
    'tests/api.integration.mjs',
    'tests/commercial-restore-db.integration.mjs',
    'tests/platform-support-db.integration.mjs'
  ]) assert.ok(runner.includes(suite), `${suite} must be registered`);
  assert.match(runner, /externalSuites/);
  assert.match(runner, /GYMOS_DB_TESTS/);
  assert.match(runner, /GYMOS_LIVE_SERVER_TESTS/);
  assert.match(runner, /Not counted as a pass/);
  assert.match(runner, /Unregistered integration suites/);
  assert.match(runner, /dbGatedUnitSuites/);
});

test('B09: integration runner is syntactically valid', () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/run-integration-tests.mjs'], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});

test('B10: CI installers no longer invoke or require vinext', async () => {
  for (const path of ['scripts/install-ci.sh', 'scripts/install-ci.mjs']) {
    const source = await read(path);
    assert.doesNotMatch(source, /vinext/i, `${path} must not reference vinext`);
  }
  const shell = await read('scripts/install-ci.sh');
  assert.match(shell, /npm_ci_args=\(ci /, 'clean npm ci must remain in the shell installer');
  const node = await read('scripts/install-ci.mjs');
  assert.match(node, /"ci"/, 'clean npm ci must remain in the node installer');
  assert.doesNotMatch(node, /accessSync/);
});

test('B10: dependency lockfile does not contain vinext', async () => {
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(lock.packages?.['node_modules/vinext'], undefined);
});
