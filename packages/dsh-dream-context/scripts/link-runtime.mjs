// Bind this isolated review package to already installed dependencies. Never
// installs, upgrades, or writes into the supplied runtime/development roots.
import { mkdir, readdir, lstat, realpath, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const roots = process.argv.slice(2).map(path => resolve(path, 'node_modules'));
if (!roots.length) throw new Error('Pass the DSH profile and optional TypeScript development package roots');
const target = new URL('../node_modules/', import.meta.url).pathname;
await mkdir(target, { recursive: true });
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
for (const root of roots) {
  for (const name of await readdir(root)) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      await mkdir(join(target, name), { recursive: true });
      for (const item of await readdir(join(root, name))) {
        const destination = join(target, name, item);
        if (!await exists(destination)) await symlink(await realpath(join(root, name, item)), destination);
      }
    } else if (!await exists(join(target, name))) await symlink(await realpath(join(root, name)), join(target, name));
  }
}
await mkdir(join(target, '.bin'), { recursive: true });
if (!await exists(join(target, '.bin/tsc'))) await symlink('../typescript/bin/tsc', join(target, '.bin/tsc'));
console.log('Local dependency links ready; supplied runtimes unchanged.');
