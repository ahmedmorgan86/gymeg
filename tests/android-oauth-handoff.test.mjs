import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Android system-browser OAuth handoff: source-level invariants for the
// review artifact. Runtime recreation/background-return verification is owed
// on a device; these assertions pin the mechanisms that make it work.
for (const role of ['members','management']) {
  test(`Android ${role} OAuth handoff: task reuse, pending verifier, no token in URL`, () => {
    const base = new URL(`../mobile-android/${role}/`, import.meta.url);
    const manifest = readFileSync(new URL('AndroidManifest.xml', base), 'utf8');
    const main = readFileSync(new URL(`src/com/pushtorq/${role}/MainActivity.java`, base), 'utf8');

    // App Link must reuse the running task so the flow returns to the same
    // activity instance (singleTask -> onNewIntent), and the link is a
    // verified https App Link for the handoff path only.
    assert.match(manifest, /android:launchMode="singleTask"/);
    assert.match(manifest, /android:autoVerify="true"/);
    assert.match(manifest, new RegExp(`android:path="\\/auth\\/mobile\\/callback\\/${role}"`), 'per-app deterministic App Link path');
    assert.match(manifest, /android:host="\$\{webHost\}"/);

    // The verifier survives activity recreation and process death via
    // app-private prefs, expires with the server flow, and is cleared only
    // by the matching successful exchange - a malformed or unrelated intent
    // can never erase it (validated before the proof is even read).
    assert.ok(main.includes('readPendingVerifier()'), 'pending verifier recovery');
    assert.ok(main.includes('clearPendingVerifierIfMatches(verifier)'), 'proof cleared only by matching success');
    assert.ok(main.includes('PENDING_TTL_MS=600000L'), 'pending verifier expiry matches flow cookies');
    assert.ok(!main.includes('private String oauthVerifier'), 'no lost-on-recreation in-memory-only verifier');
    assert.ok(main.indexOf('OAUTH_CLIENT.equals(client)') < main.indexOf('final String verifier=readPendingVerifier()'), 'validation precedes proof read');
    assert.ok(main.includes(`CALLBACK_PATH="/auth/mobile/callback/${role}"`), 'app handles only its own return path');
    // Explicit attempt phases close the duplicate-callback races. These
    // assertions pin the mechanism; runtime interleaving proof is owed on a
    // device, not claimed from source.
    assert.ok(main.includes('private String inflightVerifier,installingVerifier;'), 'attempt phase fields');
    assert.ok(main.includes('if(inflightVerifier!=null||installingVerifier!=null)return;'), 'new flow serialized against active phases');
    assert.ok(main.includes('if(inflightVerifier!=null||installingVerifier!=null)return true;inflightVerifier=verifier;exchange(code,verifier)'), 'single exchange per pending attempt; duplicate intent swallowed in both active phases');
    assert.ok((main.match(/if\(!verifier\.equals\(inflightVerifier\)\)return;inflightVerifier=null;/g) || []).length === 3, 'stale exchange responses ignored in all three outcomes');
    assert.ok(main.includes('installingVerifier=verifier;CookieManager.getInstance().setCookie("https://"+HOST,cookie'), 'cookie install owns the installing phase');
    assert.ok(main.includes('if(!verifier.equals(installingVerifier))return;installingVerifier=null;'), 'stale cookie completion ignored');
    const oauthFailPath = role === 'members' ? '/member?error=google_failed' : '/sign-in?error=google_failed';
    assert.ok(main.includes('}else if(attemptCurrent(verifier)){web.loadUrl("https://"+HOST+"'+oauthFailPath+'");'), 'rejected cookie navigates only while attempt current');
    assert.ok(main.indexOf('setCookie("https://"+HOST,cookie') < main.indexOf('clearPendingVerifierIfMatches(verifier)'), 'clear after bound exchange');
    assert.ok(!main.includes('takePendingVerifier'), 'no delete-on-read proof');
    // The proof file is explicitly excluded from backup and device transfer.
    const rules = readFileSync(new URL('res/xml/data_extraction_rules.xml', base), 'utf8');
    assert.ok(rules.includes('path="gymeg_oauth.xml"'), 'explicit sharedpref exclusion');

    // The flow starts in the system browser, never inside the WebView, and
    // the session arrives only as a Set-Cookie copied into the CookieManager
    // after the native exchange - never in any URL the WebView loads.
    assert.ok(main.includes('openExternal(out)'), 'system-browser start');
    assert.ok(main.includes('/api/auth/mobile/exchange'), 'native exchange endpoint');
    // Authenticated navigation happens only inside the CookieManager
    // completion callback after the cookie is accepted.
    assert.ok(main.includes('setCookie("https://"+HOST,cookie,new android.webkit.ValueCallback<Boolean>()'), 'cookie handoff with completion callback');
    assert.ok(main.indexOf('onReceiveValue(Boolean accepted)') < main.indexOf('flush();loadHome();'), 'navigation after acceptance');
    assert.ok(main.indexOf('clearPendingVerifierIfMatches(verifier)') > main.indexOf('Boolean.TRUE.equals(accepted)'), 'proof retained until cookie accepted');
    assert.ok(!/loadUrl\([^)]*code/.test(main), 'no code in WebView URLs');
    assert.ok(!/loadUrl\([^)]*gymos_session/.test(main), 'no session in WebView URLs');
    assert.ok(main.includes('"android-' + role + '"'), 'client tag');

    // The origin comes from the flavor BuildConfig, never a hardcoded literal.
    assert.ok(main.includes('HOST=BuildConfig.WEB_HOST'), 'BuildConfig origin');
    assert.ok(!main.includes('HOST="gymeg'), 'no hardcoded host in MainActivity');

    // Transient-error handling: exchange failures and missing/expired
    // verifiers fail cleanly back to sign-in, never loop or crash.
    assert.ok(main.includes(oauthFailPath), 'clean failure path');
    assert.ok(main.includes('catch(Exception e)'), 'transient network failure handled');
  });

  test(`Android ${role} flavors: production default + reproducible freshtest overlay`, () => {
    const gradle = readFileSync(new URL(`../mobile-android/${role}/build.gradle`, import.meta.url), 'utf8');
    assert.match(gradle, /production \{[\s\S]*?WEB_HOST', '"gymeg\.vercel\.app"'/);
    assert.match(gradle, /freshtest \{[\s\S]*?applicationIdSuffix '\.freshtest'/);
    assert.match(gradle, /freshtest \{[\s\S]*?WEB_HOST', '"gymeg-supabase\.vercel\.app"'/);
    // Committed defaults stay production: applicationId without suffix.
    assert.match(gradle, new RegExp(`defaultConfig \\{ applicationId 'com\\.pushtorq\\.${role}'`));
    // Freshtest flavor resources exist in the tree (Arabic test label).
    const label = readFileSync(new URL(`../mobile-android/${role}/src/freshtest/res/values/strings.xml`, import.meta.url), 'utf8');
    assert.ok(label.includes('تجريبي'));
    const firebase = JSON.parse(readFileSync(new URL(`../mobile-android/${role}/src/freshtest/google-services.json`, import.meta.url), 'utf8'));
    const ids = firebase.client.map((c) => c.client_info.android_client_info.package_name);
    assert.ok(ids.every((id) => id.endsWith('.freshtest')), 'freshtest google-services only freshtest packages');
  });
}
