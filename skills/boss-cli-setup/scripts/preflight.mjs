import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Offline and read-only: never launch a browser or inspect a login profile.
const args = process.argv.slice(2);
if (args.length !== 1 || ['--help', '-h'].includes(args[0])) {
  console.log('Usage: node preflight.mjs <boss-cli-project-directory>');
  process.exit(args.length === 1 ? 0 : 2);
}
const projectRoot = path.resolve(args[0]);
const report = {
  projectRoot,
  node: { version: process.version, minimumMajor: 22, ok: Number(process.versions.node.split('.')[0]) >= 22 },
  project: { ok: false },
  dependency: { name: 'playwright-core', ok: false },
  browser: { found: false, candidates: [] },
  configuration: {
    customProfileConfigured: Boolean(process.env.BOSS_PROFILE),
    customDataDirConfigured: Boolean(process.env.BOSS_CLI_HOME),
    externalCdpConfigured: Boolean(process.env.BOSS_CDP_URL),
  },
  readyForLogin: false,
};
async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}
try {
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  report.project = {
    ok: manifest.name === 'boss-cli' && await isFile(path.join(projectRoot, 'bin', 'boss.js')),
    name: manifest.name,
    version: manifest.version,
    nodeRequirement: manifest.engines?.node,
    lockfilePresent: await isFile(path.join(projectRoot, 'package-lock.json')),
  };
  if (report.project.ok) {
    try {
      const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
      const dependency = projectRequire('playwright-core/package.json');
      const runtime = await import(pathToFileURL(projectRequire.resolve('playwright-core')).href);
      const chromium = runtime.chromium ?? runtime.default?.chromium;
      const expected = manifest.dependencies?.['playwright-core'];
      const matchesPinnedVersion = /^\d+\.\d+\.\d+$/.test(expected ?? '') ? expected === dependency.version : null;
      report.dependency = {
        name: 'playwright-core',
        ok: typeof chromium?.connectOverCDP === 'function' && matchesPinnedVersion !== false,
        expectedVersion: expected,
        installedVersion: dependency.version,
        matchesPinnedVersion,
      };
    } catch (error) { report.dependency.errorCode = error.code ?? 'DEPENDENCY_UNAVAILABLE'; }
  }
} catch (error) { report.project.errorCode = error.code ?? 'INVALID_PACKAGE_JSON'; }

const candidates = [process.env.BOSS_BROWSER_PATH, process.env.CHROME_PATH];
if (process.platform === 'win32') {
  for (const root of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean)) {
    candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
} else if (process.platform === 'darwin') {
  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
} else {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const executable of ['google-chrome', 'microsoft-edge', 'chromium', 'chromium-browser']) candidates.push(path.join(directory, executable));
  }
}
for (const candidate of [...new Set(candidates.filter(Boolean).map(value => path.resolve(value)))]) {
  if (await isFile(candidate)) report.browser.candidates.push(candidate);
}
report.browser.found = report.browser.candidates.length > 0;
report.readyForLogin = report.node.ok && report.project.ok && report.dependency.ok && report.browser.found;
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.readyForLogin ? 0 : 1;
