// Preloaded with --import: every public fs call that could write to disk
// reports itself on stderr and throws, so a test can see any attempt.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const MARK = 'DISK-WRITE-ATTEMPT';

function report(name: string): never {
  process.stderr.write(`${MARK} ${name}\n`);
  throw new Error(`${MARK} ${name}`);
}

const writeFlag = (flags: unknown) =>
  typeof flags === 'number'
    ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND)) !== 0
    : typeof flags === 'string' && /[wa+]/.test(flags);

const always = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'write', 'writeSync', 'writev', 'writevSync',
  'createWriteStream', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'rename', 'renameSync',
  'copyFile', 'copyFileSync', 'cp', 'cpSync', 'symlink', 'symlinkSync', 'link', 'linkSync',
  'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync',
] as const;
const promised = [
  'writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'copyFile', 'cp', 'symlink', 'link', 'truncate',
] as const;

const target = fs as unknown as Record<string, unknown>;
for (const name of always) target[name] = () => report(name);

for (const name of ['open', 'openSync'] as const) {
  const original = fs[name] as (...args: unknown[]) => unknown;
  target[name] = (path: unknown, flags?: unknown, ...rest: unknown[]) =>
    writeFlag(flags) ? report(name) : original(path, flags, ...rest);
}

const promises = fs.promises as unknown as Record<string, unknown>;
for (const name of promised) promises[name] = async () => report(`promises.${name}`);
const openP = fs.promises.open;
promises.open = async (path: fs.PathLike, flags?: string | number, mode?: fs.Mode) =>
  writeFlag(flags) ? report('promises.open') : openP(path, flags, mode);

syncBuiltinESMExports();
