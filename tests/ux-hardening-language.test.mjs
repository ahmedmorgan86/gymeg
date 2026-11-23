import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

await import('./usability-loader.mjs');

const consoleSource = readFileSync(new URL('../app/member-console.tsx', import.meta.url), 'utf8');
const demoSource = readFileSync(new URL('../app/demo/page.tsx', import.meta.url), 'utf8');

test('member console derives language from an explicit ar prop with a stored preference fallback', () => {
  assert.match(consoleSource, /ar\?:boolean/);
  assert.match(consoleSource, /usePreference<'ar'\|'en'>\('gymos\.language','ar'\)/);
  assert.match(consoleSource, /const ar=p\.ar\?\?lang==='ar'/);
  assert.match(consoleSource, /const \[ar,t\]=useConsoleLanguage\(p\)/);
  for (const marker of [
    "t('الإدارة الشاملة للأعضاء والحضور','Complete member and attendance management')",
    "t('الاسم الكامل','Full name')",
    "t('الهاتف الأساسي','Primary phone')",
    "t('جميع بيانات العضو','All member data')",
    "t('فلاتر متقدمة','Advanced filters')",
    "t('إغلاق','Close')",
  ]) assert.ok(consoleSource.includes(marker), marker);
  assert.match(consoleSource, /<DeviceCenter[^>]*ar=\{ar\}/);
  assert.match(consoleSource, /<EngagementPage[^>]*ar=\{ar\}/);
  assert.match(consoleSource, /<FaceAttendance[^>]*ar=\{ar\}/);
  assert.match(consoleSource, /<MemberCamera[^>]*ar=\{ar\}/);
  assert.doesNotMatch(consoleSource, /\bar\s+onPendingChange/);
});

test('member console renders English UI when ar is false and Arabic by default', async () => {
  const {default: MemberConsole} = await import('../app/member-console.tsx');
  const {emptyState} = await import('../app/lib/domain.ts');
  const props = {state: emptyState(), branch: 'main', owner: 'club', actor: 'admin', role: 'owner', busy: false, mutate: async () => true, reload: async () => {}};
  const en = renderToStaticMarkup(createElement(MemberConsole, {...props, ar: false}));
  assert.match(en, /<section[^>]*dir="ltr" lang="en"/);
  assert.match(en, /Complete member and attendance management/);
  assert.match(en, /Add a new member/);
  assert.match(en, /Advanced filters/);
  assert.doesNotMatch(en, /الإدارة الشاملة للأعضاء والحضور/);
  const ar = renderToStaticMarkup(createElement(MemberConsole, props));
  assert.match(ar, /<section[^>]*dir="rtl" lang="ar"/);
  assert.match(ar, /الإدارة الشاملة للأعضاء والحضور/);
  assert.match(ar, /فلاتر متقدمة/);
});

test('demo page accepts a language query parameter and translates every UI string', () => {
  assert.match(demoSource, /searchParams:Promise<\{lang\?:string\|string\[\]\}>/);
  assert.match(demoSource, /const ar=requested!=='en'/);
  assert.match(demoSource, /dir=\{ar\?'rtl':'ltr'\} lang=\{ar\?'ar':'en'\}/);
  assert.doesNotMatch(demoSource, /<div dir="ltr">/);
  for (const marker of [
    "t('جرّب GymEG لمدة ٣٠ يومًا مجانًا','Try GymEG free for 30 days')",
    "t('أنشئ حساب المالك أو سجّل الدخول.','Create an owner account or sign in.')",
    "t('إنشاء حساب وبدء التجربة','Create an account and start the trial')",
    "t('العودة للرئيسية','Back to home')",
  ]) assert.ok(demoSource.includes(marker), marker);
});

test('demo page renders the requested language', async () => {
  const {default: Trial} = await import('../app/demo/page.tsx');
  const en = renderToStaticMarkup(await Trial({searchParams: Promise.resolve({lang: 'en'})}));
  assert.match(en, /dir="ltr" lang="en"/);
  assert.match(en, /Try GymEG free for 30 days/);
  assert.match(en, /Create an account and start the trial/);
  assert.doesNotMatch(en, /جرّب GymEG لمدة ٣٠ يومًا مجانًا/);
  const ar = renderToStaticMarkup(await Trial({searchParams: Promise.resolve({lang: 'ar'})}));
  assert.match(ar, /dir="rtl" lang="ar"/);
  assert.match(ar, /جرّب GymEG لمدة ٣٠ يومًا مجانًا/);
});
