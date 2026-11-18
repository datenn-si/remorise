import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rootDir = path.dirname(frontendDir);
const docDirs = [
  rootDir,
  path.join(rootDir, 'docs'),
  path.join(rootDir, 'backend'),
  path.join(rootDir, 'backend', 'docs'),
];
// CODE_OF_CONDUCT.md は Contributor Covenant の公式文書をそのまま収録するため、整形の対象から外す。
const excludedFiles = new Set([path.join(rootDir, 'CODE_OF_CONDUCT.md')]);
const files = [];
for (const dir of docDirs) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry.endsWith('.md') && statSync(full).isFile() && !excludedFiles.has(full)) {
      files.push(full);
    }
  }
}
files.sort();
const args = ['--config', path.join(frontendDir, '.oxfmtrc.json')];
if (process.argv.includes('--check')) {
  args.push('--check');
}
args.push(...files);
try {
  execFileSync(
    process.execPath,
    [path.join(frontendDir, 'node_modules', 'oxfmt', 'bin', 'oxfmt'), ...args],
    { stdio: 'inherit' },
  );
} catch (error) {
  process.exit(typeof error.status === 'number' ? error.status : 1);
}
