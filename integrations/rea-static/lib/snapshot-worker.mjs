import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// This helper runs in its own OS sandbox: only source is readable and only
// destination is writable. Target files are copied as bytes, never imported.
const [source, destination] = process.argv.slice(2);
const limits = { files: 128, bytes: 8 * 1024 * 1024, fileBytes: 512 * 1024, depth: 12 };
let bytes = 0;
let directories = 0;
const files = [];
const inside = p => p === source || p.startsWith(source + path.sep);
async function copy(dir, output, depth = 0) {
  if (depth > limits.depth) throw new Error('Snapshot directory depth exceeds 12');
  if (++directories > 128) throw new Error('Snapshot directory count exceeds 128');
  const before = await fs.lstat(dir);
  if (!before.isDirectory() || before.isSymbolicLink() || !inside(await fs.realpath(dir))) throw new Error('Unsafe snapshot directory');
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const entries = (await fs.readdir(dir)).sort();
  if (entries.length > 256) throw new Error('Directory entry limit exceeded');
  for (const name of entries) {
    const src = path.join(dir, name), dest = path.join(output, name);
    const stat = await fs.lstat(src);
    if (stat.isSymbolicLink()) throw new Error('Symlinks are not accepted in static snapshots');
    if (stat.isDirectory()) { await copy(src, dest, depth + 1); continue; }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Only regular files with one link are accepted');
    if (stat.size > limits.fileBytes || bytes + stat.size > limits.bytes || files.length >= limits.files) throw new Error('Snapshot file/byte limit exceeded');
    if (!inside(await fs.realpath(src))) throw new Error('Snapshot path escaped analysis root');
    const handle = await fs.open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error('Input changed while snapshotting');
      // Bound allocations even if a file grows after lstat.
      const buffer = Buffer.alloc(limits.fileBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const r = await handle.read(buffer, size, buffer.length - size, null);
        if (r.bytesRead === 0) break;
        size += r.bytesRead;
      }
      const after = await handle.stat();
      if (size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || !inside(await fs.realpath(src))) throw new Error('Input changed while snapshotting');
      const data = buffer.subarray(0, size);
      await fs.writeFile(dest, data, { flag: 'wx', mode: 0o400 });
      bytes += size;
      files.push({path: path.relative(source, src), bytes: size, sha256: createHash('sha256').update(data).digest('hex')});
    } finally { await handle.close(); }
  }
  const after = await fs.lstat(dir);
  if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) throw new Error('Directory changed while snapshotting');
}
try {
  if (!source || !destination || await fs.realpath(source) !== source) throw new Error('Canonical source and destination required');
  await copy(source, destination);
  process.stdout.write(JSON.stringify({files, bytes}));
} catch (error) {
  process.stderr.write(String(error.message));
  process.exitCode = 1;
}
