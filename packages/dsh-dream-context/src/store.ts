import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Immutable content-addressed objects. A native session event publishes a book
 * only after its object is fsynced. A fork inherits that exact historical book. */
export class Store {
  constructor(readonly root: string) {}
  async put(value: unknown): Promise<string> {
    const ref = digest(value);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `${ref}.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, join(this.root, `${ref}.json`));
    const directory = await open(this.root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return ref;
  }
  async get<T>(ref: string): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error('Invalid dream object reference');
    const value: unknown = JSON.parse(await readFile(join(this.root, `${ref}.json`), 'utf8'));
    if (digest(value) !== ref) throw new Error('Dream object checksum mismatch');
    return value as T;
  }
}
