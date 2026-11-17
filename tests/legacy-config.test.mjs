import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const stripBom = (text) => text.replace(/^\uFEFF/, '');

const SUPERSEDED_BANNER = '> SUPERSEDED / مُلغى كمرجع حالي — historical record only. Current status: docs/PRODUCTION_READINESS_AUDIT_2026-11-17_AR.md and the final readiness report; counts and claims below are NOT current verification evidence.';

test('C08: vite.config.ts is intentionally empty and has no legacy imports', async () => {
  const source = stripBom(await read('vite.config.ts'));
  assert.doesNotMatch(source, /vinext/i, 'vite.config.ts must not reference vinext');
  assert.doesNotMatch(source, /build\//i, 'vite.config.ts must not reference build/ plugins');
  assert.doesNotMatch(source, /@cloudflare\/vite-plugin/i, 'vite.config.ts must not import the Cloudflare Vite plugin');
  assert.doesNotMatch(source, /^\s*import\b/m, 'vite.config.ts must not contain imports');
  assert.match(source, /export\s+default\s*\{\s*\}\s*;?/, 'vite.config.ts must export an empty config');
  assert.equal((source.match(/\bexport\b/g) ?? []).length, 1, 'vite.config.ts must only export the empty default config');
});

test('C08: remaining vinext references in scripts are explicitly marked legacy', async () => {
  const entries = await readdir(new URL('scripts/', root));
  const scripts = entries.filter((name) => /\.(?:mjs|js|sh)$/.test(name));
  let marked = 0;
  for (const name of scripts) {
    const source = stripBom(await read(`scripts/${name}`));
    if (!/vinext/i.test(source)) continue;
    marked += 1;
    const header = source.split(/\r?\n/, 8).join('\n');
    assert.match(header, /LEGACY|SUPERSEDED/i, `scripts/${name} needs a LEGACY/SUPERSEDED marker above its vinext reference`);
    assert.match(header, /npm\s+(?:ci|run)\b/i, `scripts/${name} marker must point to the current npm scripts`);
  }
  assert.ok(marked > 0, 'expected at least one explicitly marked legacy script');
  for (const installer of ['scripts/install-ci.sh', 'scripts/install-ci.mjs']) {
    assert.doesNotMatch(stripBom(await read(installer)), /vinext/i, `${installer} must stay clean`);
  }
});

test('C09: stale verification docs lead with the superseded banner', async () => {
  for (const path of ['TEST_REPORT.md', 'PRODUCT_REVIEW_2026-10-20.md']) {
    const source = stripBom(await read(path));
    const bannerAt = source.indexOf(SUPERSEDED_BANNER);
    assert.notEqual(bannerAt, -1, `${path} must contain the exact superseded banner`);
    const headingAt = source.search(/^#\s/m);
    assert.ok(bannerAt < headingAt, `${path} banner must come before the first heading`);
  }
});

test('C14: README documents report export caps in Arabic and English', async () => {
  const source = stripBom(await read('README.md'));
  const start = source.indexOf('## Report export limits');
  assert.notEqual(start, -1, 'README must keep the report export limits section');
  const next = source.indexOf('\n## ', start + 1);
  const section = source.slice(start, next === -1 ? source.length : next);
  for (const needle of ['366 days', '50,000 events', 'split by period', 'HTTP 400 or 413', 'machine-readable `cap`']) {
    assert.ok(section.includes(needle), `English report cap note missing: ${needle}`);
  }
  for (const needle of ['366 يومًا', '50,000', 'طلبات منفصلة', '400 أو 413', '`cap`', 'لا يوجد ترقيم صفحات تلقائي']) {
    assert.ok(section.includes(needle), `Arabic report cap note missing: ${needle}`);
  }
  assert.doesNotMatch(section, /pagination (?:is )?(?:available|provided|supported)/i, 'no pagination promise allowed');
});
