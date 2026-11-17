import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const testSuites = [
  { name: 'Public homepage and explicit management entry', file: 'tests/homepage.integration.mjs', loader: './tests/homepage-loader.mjs' },
  { name: 'API role boundaries', file: 'tests/role-api.integration.mjs', loader: './tests/role-api-loader.mjs' },
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
  { name: 'Report API timezone and scope contract', file: 'tests/report-api.integration.mjs', loader: './tests/report-api-loader.mjs' }
];

console.log(`Starting execution of ${testSuites.length} integration test suites...\n`);

let passed = 0;
let failed = 0;
const startTotal = Date.now();

for (const suite of testSuites) {
  console.log(`----------------------------------------------------------------`);
  console.log(`▶ ${suite.name} (${suite.file})`);
  console.log(`----------------------------------------------------------------`);
  const suiteStart = Date.now();
  const args = ['--import', suite.loader, '--test', '--test-isolation=none', suite.file];
  const res = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' }
  });
  const duration = ((Date.now() - suiteStart) / 1000).toFixed(2);
  if (res.status === 0) {
    passed++;
    console.log(`✔ Passed in ${duration}s\n`);
  } else {
    failed++;
    console.error(`\n✖ FAILED in ${duration}s with exit code ${res.status}\n`);
    process.exit(res.status || 1);
  }
}

const totalDuration = ((Date.now() - startTotal) / 1000).toFixed(2);
console.log(`================================================================`);
console.log(`✔ All ${passed} integration test suites passed in ${totalDuration}s.`);
console.log(`================================================================\n`);
