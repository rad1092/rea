import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PIN } from './sandbox.mjs';

export async function runtimeFiles(root) {
  const rows = [];
  async function walk(dir) {
    for (const entry of (await fs.readdir(path.join(root, dir), {withFileTypes: true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const name = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isSymbolicLink()) {
        const resolved = await fs.realpath(path.join(root, name));
        if (!resolved.startsWith(root + path.sep)) throw new Error('External runtime symlink');
        rows.push([name, 'link:' + await fs.readlink(path.join(root, name))]);
      } else if (entry.isFile()) rows.push([name, createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex')]);
      else throw new Error('Special runtime file');
    }
  }
  for (const dir of ['dist', 'node_modules']) await walk(dir);
  for (const name of ['package.json','package-lock.json']) rows.push([name, createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex')]);
  return rows;
}
export function checkPin(root, expectedRevision) {
  const env = {PATH:'/usr/bin:/bin', HOME:'/nonexistent', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_NO_REPLACE_OBJECTS:'1'};
  const git = args => execFileSync('/usr/bin/git', ['-C', root, ...args], {env, encoding:'utf8',maxBuffer:1024*1024}).trim();
  const revision = git(['rev-parse','HEAD']);
  if (expectedRevision && revision !== expectedRevision) throw new Error('Reviewed Git revision mismatch');
  // A derived worker-thread build must retain the exact reviewed upstream base.
  git(['merge-base','--is-ancestor',PIN,revision]);
  if (git(['status','--porcelain','--untracked-files=no'])) throw new Error('Pinned upstream has tracked modifications');
  return revision;
}
export async function verifyRuntime(root, manifestPath) {
  const expected = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (expected.commit !== PIN || !/^[a-f0-9]{40}$/.test(expected.revision) || expected.node !== process.version) throw new Error('Runtime manifest pin/Node mismatch');
  checkPin(root,expected.revision);
  const actual = await runtimeFiles(root);
  if (JSON.stringify(expected.files) !== JSON.stringify(actual)) throw new Error('Runtime files differ from reviewed build attestation');
}
