import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || '/usr/src/wpp-server';

function patchFile(relPath, replacer) {
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing target file for WPPConnect patch: ${full}`);
  }
  const before = fs.readFileSync(full, 'utf8');
  const after = replacer(before);
  if (after !== before) {
    fs.writeFileSync(full, after, 'utf8');
    console.log(`[patch] updated ${relPath}`);
  } else {
    console.log(`[patch] already up to date: ${relPath}`);
  }
}

// 1. Update hardcoded Chrome/102 User-Agent so modern WhatsApp Web renders QR cleanly.
patchFile(
  'node_modules/@wppconnect-team/wppconnect/dist/config/WAuserAgente.js',
  (src) =>
    src.replace(
      /Chrome\/102\.0\.5005\.63/g,
      'Chrome/131.0.0.0'
    )
);

// 2. Add DOM <canvas> + [data-ref] fallback in getQrCode() and 2s qrPoll in waitForQrCodeScan().
patchFile(
  'node_modules/@wppconnect-team/wppconnect/dist/api/layers/host.layer.js',
  (src) => {
    let out = src;
    if (!out.includes('document.querySelectorAll(\'canvas\')')) {
      out = out.replace(
        /async getQrCode\(\)\s*\{[\s\S]*?return \{ urlCode: qr\.fullCode, base64Image: qr\.base64Image \};\s*\}/,
        `async getQrCode() {
        let qr = await (0, helpers_1.evaluateAndReturn)(this.page, () => WPP.conn.getQRCode()).catch(() => null);
        if (!qr || !qr.fullCode || !qr.base64Image) {
            qr = await this.page.evaluate(() => {
                const canvases = Array.from(document.querySelectorAll('canvas'));
                const c = canvases.find((el) => el.width >= 100 && el.height >= 100);
                if (!c) return null;
                const refEl = c.closest('[data-ref]') || document.querySelector('[data-ref]');
                const ref = refEl?.getAttribute('data-ref') || '';
                const base64Image = c.toDataURL('image/png');
                return { fullCode: ref || ('canvas:' + base64Image.slice(-32)), base64Image };
            }).catch(() => null);
        }
        if (!qr || !qr.base64Image)
            return undefined;
        return { urlCode: qr.fullCode, base64Image: qr.base64Image };
    }`
      );
    }
    if (!out.includes('const qrPoll = setInterval')) {
      out = out.replace(
        /(async waitForQrCodeScan\(catchQR\)\s*\{[\s\S]*?throw new Error\('waitForQrCodeScan error: Session not started'\);\s*\})\s*(while \(!this\.page\.isClosed\(\) && !this\.isLogged\) \{[\s\S]*?this\.isLogged = !needScan;\s*\})/,
        `$1
        const qrPoll = setInterval(() => {
            if (!this.qrLoopCancelled && !this.page.isClosed() && !this.isLogged) {
                void this.checkQrCode().catch(() => {});
            }
        }, 2000);
        try {
        $2
        } finally { clearInterval(qrPoll); }`
      );
    }
    return out;
  }
);

// 3. Fallback to raw contact JID if WPP.contact.queryExists throws in checkNumberStatus().
patchFile(
  'dist/middleware/statusConnection.js',
  (src) => {
    if (src.includes('[statusConnection] checkNumberStatus failed')) return src;
    return src.replace(
      /try\s*\{\s*profile = await req\.client\.checkNumberStatus\(contact\);\s*\}\s*catch\s*\(error\)\s*\{[\s\S]*?return res\.status\(502\)\.json\(\{[\s\S]*?\}\);\s*\}/,
      `try {
            profile = await req.client.checkNumberStatus(contact);
          } catch (error) {
            req.logger.warn(\`[statusConnection] checkNumberStatus failed, using raw contact \${contact}: \${error?.message || error}\`);
            resolved.set(contact, contact);
            localArr[index] = contact;
            index++;
            continue;
          }`
    );
  }
);

// 4. Mark client CONNECTED and clear stale qrcode immediately when inChat/isLogged fires.
patchFile(
  'dist/util/createSessionUtil.js',
  (src) => {
    if (src.includes('_wppconnect.StatusFind.inChat')) return src;
    return src.replace(
      /(if\s*\(\s*statusFind === _wppconnect\.StatusFind\.autocloseCalled)/,
      `if (
                statusFind === _wppconnect.StatusFind.inChat ||
                statusFind === _wppconnect.StatusFind.isLogged)
                {
                  client.status = 'CONNECTED';
                  client.qrcode = null;
                }
                $1`
    );
  }
);
