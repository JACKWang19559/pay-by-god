import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
let count = 0;
for (const folder of ['bin', 'src', 'scripts', 'test']) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:m?js)$/.test(entry.name)) continue;
    const target = path.join(folder, entry.name);
    const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr || result.error?.message || `Syntax failed: ${target}`); process.exit(result.status || 1); }
    count++;
  }
}
process.stdout.write(`Syntax checked ${count} JavaScript files.\n`);
