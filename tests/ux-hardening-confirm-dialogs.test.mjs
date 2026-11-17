import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = name => readFileSync(new URL(`../app/${name}`, import.meta.url), 'utf8');
const memberConsole = source('member-console.tsx');
const backupPanel = source('backup-panel.tsx');
const teamPage = source('team-page.tsx');

test('member console, backup panel and team page no longer call native confirm/prompt', () => {
  for (const [name, text] of [['member-console.tsx', memberConsole], ['backup-panel.tsx', backupPanel], ['team-page.tsx', teamPage]]) {
    assert.doesNotMatch(text, /\bwindow\s*\.\s*(confirm|prompt)\s*\(/, name);
    assert.doesNotMatch(text, /(?<![\w.])(confirm|prompt)\s*\(/, name);
  }
});

test('all three confirmations use the shared AlertDialog with explicit portal language', () => {
  for (const [name, text] of [['member-console.tsx', memberConsole], ['backup-panel.tsx', backupPanel], ['team-page.tsx', teamPage]]) {
    assert.match(text, /import\('\.\.\/components\/ui\/alert-dialog'\)/);
    for (const part of ['AlertDialog', 'AlertDialogContent', 'AlertDialogHeader', 'AlertDialogFooter', 'AlertDialogTitle', 'AlertDialogDescription', 'AlertDialogCancel', 'AlertDialogAction']) {
      assert.ok(text.includes(part), `${name} uses ${part}`);
    }
    assert.match(text, /<AlertDialogContent[^>]*dir=\{ar\?'rtl':'ltr'\} lang=\{ar\?'ar':'en'\}/, `${name} sets dialog direction and language`);
  }
});

test('card confirmations preserve their original Arabic confirm text and authorization path', () => {
  for (const text of [
    'تأكيد استعادة الكارت السابق وإلغاء الكارت النشط؟',
    'تأكيد تفعيل الكارت المختار وإلغاء الكارت النشط؟',
    'تأكيد إلغاء الكارت النشط؟ لن يسمح بالدخول بهذا الكارت.',
  ]) assert.ok(memberConsole.includes(text), text);
  assert.match(memberConsole, /change\('card\.replace'\)/);
  assert.match(memberConsole, /change\('card\.restore'\)/);
  assert.match(memberConsole, /setConfirmAction\('card\.revoke'\)/);
  assert.match(memberConsole, /permission\(p,'card\.replace'\)/);
  assert.match(memberConsole, /permission\(p,'card\.restore'\)/);
  assert.match(memberConsole, /permission\(p,'card\.revoke'\)/);
  assert.match(memberConsole, /type:'card\.revoke',id:m\.id/);
});

test('backup restore still requires the typed RESTORE confirmation and focuses its input', () => {
  assert.match(backupPanel, /data-gymos-restore-code/);
  assert.match(backupPanel, /disabled=\{restoreCode!=='RESTORE'\}/);
  assert.match(backupPanel, /querySelector<HTMLInputElement>\('\[data-gymos-restore-code\]'\)\?\.focus\(\)/);
  assert.match(backupPanel, /restoreBackup\(owner,backup\.data,revision\)/);
});

test('team revoke dialog still sends the original revoke operation', () => {
  assert.match(teamPage, /send\(\{action:'revoke',user:target\.user_id\}\)/);
  assert.ok(teamPage.includes('استعادة نسخة احتياطية كاملة للنادي'));
  assert.ok(memberConsole.includes("['backup.restore','استعادة نسخة احتياطية كاملة — لمدير له صلاحية إدارية صريحة']"));
});
