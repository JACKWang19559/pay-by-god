import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArguments, resolveCommand, HELP } from './commands.js';
import { resolveConfig } from './config.js';
import { normalizeError } from './errors.js';
import { renderOutput } from './output.js';

const VERSION = '0.1.0';

async function defaultClientFactory(config) {
  const { BossClient } = await import('./boss-client.js');
  return new BossClient(config);
}

export async function main(argv = process.argv.slice(2), { clientFactory = defaultClientFactory, stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  let client;
  try {
    parsed = parseArguments(argv);
    const command = resolveCommand(parsed);
    if (command.name === 'help') { stdout.write(HELP); return 0; }
    if (command.name === 'version') { stdout.write(VERSION + '\n'); return 0; }
    const config = resolveConfig(parsed.options);
    client = await clientFactory(config);
    if (typeof client?.[command.method] !== 'function') throw new Error(`客户端缺少 ${command.method} 方法。`);
    const result = await client[command.method](command.args);
    const output = renderOutput(result, parsed.options);
    if (parsed.options.output) {
      const outputPath = path.resolve(parsed.options.output);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, output, 'utf8');
      stderr.write(`输出已保存：${outputPath}\n`);
    } else stdout.write(output);
    return 0;
  } catch (error) {
    const normalized = normalizeError(error);
    if (parsed?.options.format === 'json' || argv.includes('--json') || argv.includes('--format=json')) {
      stderr.write(JSON.stringify({ ok: false, error: normalized.error }, null, 2) + '\n');
    } else {
      stderr.write(`错误 [${normalized.error.code}]：${normalized.error.message}\n`);
      if (normalized.error.code === 'USAGE_ERROR') stderr.write('运行 node bin/boss.js --help 查看用法。\n');
    }
    return normalized.exitCode;
  } finally {
    if (typeof client?.close === 'function') {
      try { await client.close(); } catch (error) { stderr.write(`清理浏览器连接时出错：${normalizeError(error).error.message}\n`); }
    }
  }
}
