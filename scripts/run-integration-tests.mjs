import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const testsDir = resolve(root, 'tests');

// Suites that run entirely with local mocks. No external database or server.
const testSuites = [
  { name: 'Public homepage and explicit management entry', file: 'tests/homepage.integration.mjs', loader: './tests/homepage-loader.mjs' },
  { name: 'API role boundaries', file: 'tests/role-api.integration.mjs', loader: './tests/role-api-loader.mjs' },
  { name: 'Backup restore authorization and provenance', file: 'tests/backup-api.integration.mjs', loader: './tests/role-api-loader.mjs' },
  { name: 'Member app integration boundaries', file: 'tests/member-api.integration.mjs', loader: './tests/member-api-loader.mjs' },
  { name: 'Phone sign-in boundaries', file: 'tests/member-session.integration.mjs', loader: './tests/member-session-loader.mjs' },
  { name: 'Engagement, SMS and device security boundaries', file: 'tests/engagement-api.integration.mjs', loader: './tests/role-api-loader.mjs' },
  { name: 'Finance, HR and manual WhatsApp role boundaries', file: 'tests/business-gap-api.integration.mjs', loader: './tests/role-api-loader.mjs' },
  { name: 'Private member conversation boundaries', file: 'tests/member-messages.integration.mjs', loader: './tests/member-messages-loader.mjs' },
  { name: 'Web Push subscription tenant, branch and role boundaries', file: 'tests/web-push-subscriptions.integration.mjs', loader: './tests/web-push-loader.mjs' },
  { name: 'Firebase Cloud Messaging enrollment and tenant boundaries', file: 'tests/fcm-subscriptions.integration.mjs', loader: './tests/fcm-subscriptions-loader.mjs' },
  { name: 'Manager member credential controls', file: 'tests/member-credentials.integration.mjs', loader: './tests/member-credentials-loader.mjs' },
  { name: 'Product photo privacy', file: 'tests/product-photo.integration.mjs', loader: './tests/role-api-loader.mjs' },
  { name: 'Simplified onboarding and task panels', file: 'tests/usability.integration.mjs', loader: './tests/usability-loader.mjs' },
  { name: 'Licensed music and platform directory UI', file: 'tests/commercial-library-ui.integration.mjs', loader: './tests/member-console-ui-loader.mjs' },
  { name: 'Unified member form interactions', file: 'tests/member-console-ui.integration.mjs', loader: './tests/member-console-ui-loader.mjs' },
  { name: 'Barcode API with PostgreSQL policies and reservation SQL', file: 'tests/barcode-api.integration.mjs', loader: './tests/barcode-api-loader.mjs' },
  { name: 'Entity counters and size bound across every writer, recount, gate (PGlite)', file: 'tests/entity-counters.integration.mjs', loader: './tests/commercial-loader.mjs' },
  { name: 'Hot write cannot pass the 20,000,000-byte rule (reopened visit with huge timestamp)', file: 'tests/hot-size.integration.mjs', loader: './tests/workspace-post-loader.mjs' },
  { name: 'Hot-operation slice persist parity against the full persist path (PGlite)', file: 'tests/hot-persist.integration.mjs', loader: './tests/commercial-loader.mjs' },
  { name: 'GET /api/workspace/member-history flag, scope, paging and legacy layout (PGlite)', file: 'tests/member-history-route.integration.mjs', loader: './tests/workspace-post-loader.mjs' },
  { name: 'POST /api/workspace hot path vs full path over a real entity-layout club (PGlite)', file: 'tests/workspace-post.integration.mjs', loader: './tests/workspace-post-loader.mjs' },
  { name: 'Barcode API over a real entity-layout club (slice backend, no state alias)', file: 'tests/barcode-entity.integration.mjs', loader: './tests/barcode-entity-loader.mjs' },
  { name: 'Report API timezone and scope contract', file: 'tests/report-api.integration.mjs', loader: './tests/report-api-loader.mjs' },
];

// Previously orphaned suites. They are registered explicitly, but a skipped
// suite is NEVER counted as a pass. Enable them only with their prerequisite.
const externalSuites = [
  {
    name: 'Legacy live-server API flow',
    file: 'tests/api.integration.mjs',
    loader: null,
    requires: 'a live GymEG dev server on http://127.0.0.1:5173 (GYMOS_LIVE_SERVER_TESTS=1)',
    enabled: () => process.env.GYMOS_LIVE_SERVER_TESTS === '1',
  },
  {
    name: 'Commercial restore against real PostgreSQL',
    file: 'tests/commercial-restore-db.integration.mjs',
    loader: './tests/acceptance-route-loader.mjs',
    requires: 'external PostgreSQL: GYMOS_DB_TESTS=1 and GYMOS_TEST_ADMIN_ID',
    enabled: () => process.env.GYMOS_DB_TESTS === '1' && Boolean(process.env.GYMOS_TEST_ADMIN_ID),
  },
  {
    name: 'Platform support RLS against real PostgreSQL',
    file: 'tests/platform-support-db.integration.mjs',
    loader: './tests/commercial-loader.mjs',
    requires: 'external PostgreSQL: GYMOS_DB_TESTS=1 and GYMOS_TEST_ADMIN_ID',
    enabled: () => process.env.GYMOS_DB_TESTS === '1' && Boolean(process.env.GYMOS_TEST_ADMIN_ID),
  },
];

// These unit suites self-skip unless GYMOS_DB_TESTS=1. They belong to `npm test`,
// not this runner; listing them here makes the external dependency explicit.
const dbGatedUnitSuites = [
  'tests/backup-transfer.test.mjs',
  'tests/commercial-postgres.test.mjs',
  'tests/member-code-db.test.mjs',
  'tests/member-features-db.test.mjs',
  'tests/member-phone-db.test.mjs',
  'tests/trial.test.mjs',
];

// Fail loudly if a suite file is added to tests/ but not classified above.
const registered = new Set([...testSuites, ...externalSuites].map(suite => suite.file));
const orphaned = readdirSync(testsDir)
  .filter(file => file.endsWith('.integration.mjs'))
  .map(file => `tests/${file}`)
  .filter(file => !registered.has(file));
if (orphaned.length) {
  console.error(`Unregistered integration suites: ${orphaned.join(', ')}`);
  process.exit(1);
}
for (const suite of [...testSuites, ...externalSuites]) {
  if (!existsSync(resolve(root, suite.file))) {
    console.error(`Registered suite is missing: ${suite.file}`);
    process.exit(1);
  }
}

console.log(`Starting execution of ${testSuites.length} local integration test suites...\n`);

let passed = 0;
let failed = 0;
let skipped = 0;
const startTotal = Date.now();

function runSuite(suite) {
  console.log('----------------------------------------------------------------');
  console.log(`▶ ${suite.name} (${suite.file})`);
  console.log('----------------------------------------------------------------');
  const suiteStart = Date.now();
  const args = suite.loader
    ? ['--import', suite.loader, '--test', '--test-isolation=none', suite.file]
    : ['--test', '--test-isolation=none', suite.file];
  const res = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' }
  });
  const stdout = res.stdout?.toString() ?? '';
  const stderr = res.stderr?.toString() ?? '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  // Some suites print a failure but still exit 0. Never count those as passes.
  const output = stdout + '\n' + stderr;
  const reportedFailures = /^ℹ fail [1-9]\d*/m.test(output) || /^\s*✖ /m.test(output);
  const duration = ((Date.now() - suiteStart) / 1000).toFixed(2);
  if (res.status === 0 && !reportedFailures && !res.signal) {
    passed++;
    console.log(`✔ Passed in ${duration}s\n`);
  } else {
    failed++;
    const reason = res.status === 0 ? 'reported test failures' : `exit code ${res.status}`;
    console.error(`\n✖ FAILED in ${duration}s (${reason})\n`);
    process.exit(res.status && res.status !== 0 ? res.status : 1);
  }
}

for (const suite of testSuites) runSuite(suite);

for (const suite of externalSuites) {
  if (suite.enabled()) {
    runSuite(suite);
  } else {
    skipped++;
    console.log(`----------------------------------------------------------------`);
    console.log(`⏭ SKIPPED ${suite.name} (${suite.file})`);
    console.log(`   Requires: ${suite.requires}`);
    console.log('   Not counted as a pass.\n');
  }
}

const totalDuration = ((Date.now() - startTotal) / 1000).toFixed(2);
console.log('================================================================');
console.log(`✔ All ${passed} local integration test suites passed in ${totalDuration}s.`);
console.log(`⏭ ${skipped} external suite(s) skipped with an unmet prerequisite.`);
if (process.env.GYMOS_DB_TESTS !== '1') {
  console.log(`ℹ ${dbGatedUnitSuites.length} DB-gated unit suites in npm test are also skipped without GYMOS_DB_TESTS=1:`);
  for (const file of dbGatedUnitSuites) console.log(`   ${file}`);
}
console.log('================================================================\n');
