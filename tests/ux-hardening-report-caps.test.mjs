import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const route = readFileSync(new URL('../app/api/reports/export/route.ts', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('report export keeps the existing caps and error codes', () => {
  assert.match(route, /Date\.parse\(to\)-Date\.parse\(from\)>366\*86400000/);
  assert.match(route, /LIMIT 50001/);
  assert.match(route, /archived\.length>50000/);
  assert.match(route, /rows\.length,0\)>10000/);
  for (const code of ['periodUpToOneYear', 'narrowPeriod', 'useExcelOrNarrowPeriodForPDF']) {
    assert.ok(route.includes(`error:'${code}'`), code);
  }
  assert.match(route, /error:'periodUpToOneYear'[\s\S]*\},400\)/);
  assert.match(route, /error:'narrowPeriod'[\s\S]*\},413\)/);
  assert.match(route, /error:'useExcelOrNarrowPeriodForPDF'[\s\S]*\},413\)/);
  assert.doesNotMatch(route, /\b(page|offset|cursor)\b/i);
});

test('cap errors expose a readable message and a machine-readable cap', () => {
  for (const [code, cap] of [
    ['periodUpToOneYear', 'maxDays:366'],
    ['narrowPeriod', 'maxEvents:50000'],
    ['useExcelOrNarrowPeriodForPDF', 'maxRows:10000'],
  ]) {
    const match = route.match(new RegExp(`error:'${code}'[\\s\\S]*?cap:\\{[^}]+\\}`));
    assert.ok(match, code);
    const payload = match[0];
    assert.match(payload, /message:'[^']{20,}'/, `${code} needs a readable message`);
    assert.ok(payload.includes(`cap:{${cap}}`), `${code} needs cap:{${cap}}`);
  }
});

test('README documents exact caps and the need to split exports by period', () => {
  assert.match(readme, /^## Report export limits$/m);
  for (const marker of ['366 days', '50,000', '10,000', 'split by period', 'No cap is raised', 'maxDays', 'maxEvents', 'maxRows']) {
    assert.ok(readme.includes(marker), marker);
  }
  assert.match(readme, /حدود تصدير التقارير/);
  assert.match(readme, /يجب تقسيم الفترات الطويلة/);
});
