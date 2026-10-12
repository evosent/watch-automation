import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Stage new source files first. Local archives, diagnostics and personal
// untracked directories never become part of the integrity manifest.
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))]
  .filter(file => file !== 'SHA256SUMS.txt').sort();
const lines = [];
for (const file of files) {
  const fullPath = path.resolve(root, file);
  if (!fullPath.startsWith(root + path.sep)) throw new Error('Source path outside repository');
  const bytes = await fs.readFile(fullPath);
  const text = file === '.gitignore' || /\.(?:md|m?js|json|html|css|cmd|ps1|txt|ya?ml)$/i.test(file);
  const canonical = text ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes;
  lines.push(`${createHash('sha256').update(canonical).digest('hex')}  ${file}`);
}
await fs.writeFile(path.join(root, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(`Source checksums refreshed: ${lines.length}`);
