import {lstatSync, realpathSync, openSync, writeSync, closeSync, fsyncSync, fstatSync, readFileSync, unlinkSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {createHash} from 'node:crypto';
/** Offline-tool output guard. Never overwrites anything: refuses when the output path already exists in ANY form (file, directory,
 * symlink whether dangling or not), when it resolves to the input (alias or symlinked directory), and creates it with O_EXCL
 * (mode 0600) so a path created between the check and the write also fails instead of being followed or truncated.
 * Writing loops until every byte is written (a short write is normal), fsyncs, then re-reads the file and compares size and
 * sha256 with the data. Any failure removes the incomplete output this call created (it is exclusively ours) and throws, so a
 * truncated file is never reported as written. `io` is injectable only so tests can inject short or lying writes. */
export function writeNewFile(inputPath, outPath, data, io = {writeSync}) {
  let exists = true;
  try { lstatSync(outPath); } catch (e) { if (e.code !== 'ENOENT') throw e; exists = false; }
  if (exists) throw Error('refusing: output path already exists');
  const input = realpathSync(inputPath), outDir = realpathSync(dirname(outPath));
  if (join(outDir, basename(outPath)) === input) throw Error('refusing: output resolves to the input');
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const fd = openSync(outPath, 'wx', 0o600);
  let ok = false;
  try {
    let off = 0;
    while (off < buf.length) {
      const n = io.writeSync(fd, buf, off, buf.length - off);
      if (!Number.isInteger(n) || n <= 0) throw Error('write failed or made no progress');
      off += n;
    }
    fsyncSync(fd);
    if (fstatSync(fd).size !== buf.length) throw Error('written size does not match');
    ok = true;
  } finally {
    closeSync(fd);
    if (!ok) { try { unlinkSync(outPath); } catch {} }
  }
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  let verified = false;
  try { const back = readFileSync(outPath); verified = back.length === buf.length && sha(back) === sha(buf); } catch {}
  if (!verified) { try { unlinkSync(outPath); } catch {} throw Error('verification failed: persisted bytes differ from the data; incomplete output removed'); }
}
