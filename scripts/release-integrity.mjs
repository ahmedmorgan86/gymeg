/** Local, dependency-free checks shared by `npm run release:check` and its tests. */
import {createHash} from 'node:crypto';
import path from 'node:path';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Read the version label from a release APK filename (e.g. `...-1.1.9.apk`). */
export function versionFromApkFilename(url) {
  return /-(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)\.apk$/i.exec(String(url ?? ''))?.[1] ?? null;
}

/**
 * Guard the advertised APK entries: every entry must be a non-empty, honestly
 * labelled APK, and two releases must not advertise the same bytes under
 * different version labels.
 */
export function checkReleaseVersionLabels(entries) {
  const issues = [];
  const versions = new Map();
  const hashes = new Map();
  for (const entry of entries) {
    const role = entry?.role || 'release';
    const versionKey = `${entry?.package ?? ''}@${entry?.version ?? ''}`;
    if (!entry?.url || typeof entry.url !== 'string') {
      issues.push(`${role}: APK URL is missing`);
      continue;
    }
    const filename = path.basename(entry.url);
    if (!/\.apk$/i.test(filename)) issues.push(`${role}: APK URL is not an .apk file`);
    const label = versionFromApkFilename(filename);
    if (!label) issues.push(`${role}: APK filename has no version label`);
    else if (label !== entry.version) issues.push(`${role}: APK label ${label} differs from metadata version ${entry.version}`);
    if (!Number.isFinite(entry.bytes) || entry.bytes <= 0) issues.push(`${role}: APK byte size must be positive`);
    if (!isHash(entry.sha256)) issues.push(`${role}: APK SHA-256 is missing or malformed`);
    if (versions.has(versionKey)) issues.push(`${role}: ${versionKey} duplicates ${versions.get(versionKey)}`);
    versions.set(versionKey, role);
    if (isHash(entry.sha256)) {
      if (hashes.has(entry.sha256)) issues.push(`${role}: APK bytes duplicate ${hashes.get(entry.sha256)} under another version label`);
      hashes.set(entry.sha256, `${versionKey} (${role})`);
    }
  }
  return issues;
}

/** Hash every declared source file; missing/invalid fields are surfaced, never skipped silently. */
export async function checkSourceHashes(sourceHashes, sourceDir, readFile) {
  const issues = [];
  if (!sourceHashes || typeof sourceHashes !== 'object' || Array.isArray(sourceHashes)) return issues;
  const root = path.resolve(sourceDir);
  for (const [relative, expected] of Object.entries(sourceHashes)) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) {
      issues.push(`source hash key is not a relative path: ${String(relative)}`);
      continue;
    }
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      issues.push(`source hash path escapes the source directory: ${relative}`);
      continue;
    }
    if (!isHash(expected)) {
      issues.push(`source hash is malformed: ${relative}`);
      continue;
    }
    let data;
    try {
      data = await readFile(resolved);
    } catch {
      issues.push(`source hash file is missing: ${relative}`);
      continue;
    }
    const actual = sha256(data);
    if (actual !== expected) issues.push(`source hash mismatch: ${relative} (expected ${expected}, got ${actual})`);
  }
  return issues;
}

/**
 * Locate an official apksigner. `keytool` alone cannot verify APK v2/v3
 * signatures, so it is reported only for diagnostics and never treated as a
 * verifier.
 */
export function selectApkVerifier({env = process.env, pathEnv, existsSync, readdirSync, platform = process.platform} = {}) {
  const has = target => {
    try {
      return Boolean(existsSync(target));
    } catch {
      return false;
    }
  };
  const list = target => {
    try {
      return readdirSync(target);
    } catch {
      return [];
    }
  };
  if (env.ANDROID_APK_SIGNER) return {label: 'ANDROID_APK_SIGNER', command: env.ANDROID_APK_SIGNER, prefix: []};
  if (env.ANDROID_APK_SIGNER_JAR) return {label: 'ANDROID_APK_SIGNER_JAR', command: env.JAVA ?? 'java', prefix: ['-jar', env.ANDROID_APK_SIGNER_JAR]};
  const sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  if (sdk) {
    const tools = path.join(sdk, 'build-tools');
    for (const version of list(tools).sort((a, b) => b.localeCompare(a, undefined, {numeric: true}))) {
      const executable = path.join(tools, version, platform === 'win32' ? 'apksigner.bat' : 'apksigner');
      if (has(executable)) return {label: `Android SDK ${version} apksigner`, command: executable, prefix: []};
      const jar = path.join(tools, version, 'lib', 'apksigner.jar');
      if (has(jar)) return {label: `Android SDK ${version} apksigner.jar`, command: env.JAVA ?? 'java', prefix: ['-jar', jar]};
    }
  }
  for (const directory of (pathEnv ?? env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of platform === 'win32' ? ['apksigner.bat', 'apksigner.exe'] : ['apksigner']) {
      const executable = path.join(directory, name);
      if (has(executable)) return {label: 'apksigner on PATH', command: executable, prefix: []};
    }
  }
  return null;
}

/** Extract lowercase SHA-256 certificate digests from `apksigner verify --print-certs`. */
export function parseApksignerCertificate(output) {
  return [...String(output ?? '').matchAll(/certificate SHA-256 digest:[ \t]*([a-f0-9]{64})[ \t]*/gi)].map(match => match[1].toLowerCase());
}
