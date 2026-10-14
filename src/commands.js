import { positiveInteger } from './config.js';
import { UsageError } from './errors.js';

const VALUE_OPTIONS = new Set(['city', 'page', 'limit', 'salary', 'experience', 'education', 'job-type', 'industry', 'scale', 'stage', 'business-district', 'subway', 'profile', 'cdp-url', 'browser-path', 'timeout', 'wait', 'format', 'output', 'query', 'message', 'text', 'resume-id']);
const BOOLEAN_OPTIONS = new Set(['help', 'version', 'json', 'execute', 'headless']);
const ALIASES = { h: 'help', v: 'version', q: 'query', o: 'output' };
const FILTER_NAMES = ['salary', 'experience', 'education', 'job-type', 'industry', 'scale', 'stage', 'business-district', 'subway'];
const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const GLOBAL_OPTIONS = new Set(['help', 'version', 'json', 'format', 'output', 'profile', 'cdpUrl', 'browserPath', 'timeout', 'headless', 'execute']);

function validateCommandOptions(options, command) {
  const allowed = new Set(GLOBAL_OPTIONS);
  const action = command.args.action;
  if (command.name === 'search') ['query', 'city', 'page', 'limit', ...FILTER_NAMES.map(camel)].forEach((key) => allowed.add(key));
  if (command.name === 'cities') allowed.add('query');
  if (command.name === 'login') allowed.add('wait');
  if ((command.name === 'favorites' && action === 'list') || (command.name === 'chats' && ['list', 'messages'].includes(action))) ['page', 'limit'].forEach((key) => allowed.add(key));
  if (command.name === 'chats' && ['send', 'start'].includes(action)) ['text', 'message'].forEach((key) => allowed.add(key));
  if (command.name === 'apply') ['message', 'resumeId'].forEach((key) => allowed.add(key));
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new UsageError(`选项 --${key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())} 不适用于 ${command.name}${action ? ' ' + action : ''}。`);
  }
}

export function parseArguments(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (!token.startsWith('-') || token === '-') { positionals.push(token); continue; }
    let name;
    let value;
    if (token.startsWith('--')) {
      const equal = token.indexOf('=');
      name = token.slice(2, equal === -1 ? undefined : equal);
      if (equal !== -1) value = token.slice(equal + 1);
    } else {
      name = ALIASES[token.slice(1)];
      if (!name) throw new UsageError(`未知选项：${token}。请运行 boss --help。`);
    }
    if (BOOLEAN_OPTIONS.has(name)) {
      if (value !== undefined) throw new UsageError(`--${name} 不接受值。`);
      if (options[camel(name)] !== undefined) throw new UsageError(`选项 --${name} 重复。`);
      options[camel(name)] = true;
    } else if (VALUE_OPTIONS.has(name)) {
      if (value === undefined) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('-')) throw new UsageError(`--${name} 缺少参数。`);
        value = argv[++index];
      }
      if (value === '') throw new UsageError(`--${name} 缺少参数。`);
      if (options[camel(name)] !== undefined) throw new UsageError(`选项 --${name} 重复。`);
      options[camel(name)] = value;
    } else {
      throw new UsageError(`未知选项：--${name}。请运行 boss --help。`);
    }
  }
  if (options.json && options.format && options.format !== 'json') throw new UsageError('--json 与 --format table/csv 不能同时使用。');
  const format = options.json ? 'json' : options.format ?? 'table';
  if (!['table', 'json', 'csv'].includes(format)) throw new UsageError('--format 仅支持 table、json 或 csv。');
  return { options: { ...options, format }, positionals };
}

function requireTarget(values, message) {
  if (values.length !== 1 || !values[0].trim()) throw new UsageError(message);
  return values[0];
}

export function resolveCommand({ options, positionals }) {
  const [command, ...rest] = positionals;
  if (options.version) return { name: 'version' };
  if (options.help || !command) return { name: 'help' };
  const page = positiveInteger(options.page, '--page', { defaultValue: 1, max: 500 });
  const limit = positiveInteger(options.limit, '--limit', { defaultValue: 15, max: 100 });
  const pagination = { page, limit };
  let result;
  switch (command) {
    case 'login': case 'logout': case 'status':
      if (rest.length) throw new UsageError(`${command} 不接受位置参数。`);
      result = { name: command, method: command, args: command === 'login' && options.wait !== undefined ? { wait: positiveInteger(options.wait, '--wait', { max: 900_000 }) } : {} };
      break;
    case 'search': {
      if (options.query && rest.length) throw new UsageError('搜索关键词请通过位置参数或 --query 指定其中一种。');
      const query = options.query ?? rest.join(' ');
      if (!query.trim()) throw new UsageError('用法：boss search <关键词> [--city 城市]');
      const filters = Object.fromEntries(FILTER_NAMES.filter((key) => options[camel(key)] !== undefined).map((key) => [camel(key), options[camel(key)]]));
      result = { name: command, method: 'search', args: { query, ...pagination, ...(options.city ? { city: options.city } : {}), filters } };
      break;
    }
    case 'job':
      result = { name: command, method: 'job', args: { target: requireTarget(rest, '用法：boss job <职位链接或 ID>') } };
      break;
    case 'company':
      result = { name: command, method: 'company', args: { target: requireTarget(rest, '用法：boss company <职位链接或 ID>') } };
      break;
    case 'cities':
      if (options.query && rest.length) throw new UsageError('城市关键词请通过位置参数或 --query 指定其中一种。');
      result = { name: command, method: 'cities', args: { query: options.query ?? rest.join(' ') } };
      break;
    case 'favorites': {
      const [action = 'list', ...targets] = rest;
      if (!['list', 'add', 'remove'].includes(action)) throw new UsageError('用法：boss favorites [list|add <职位>|remove <职位>]');
      if (action === 'list' && targets.length) throw new UsageError('favorites list 不接受位置参数。');
      result = { name: command, method: 'favorites', args: { action, ...pagination, ...(action === 'list' ? {} : { target: requireTarget(targets, `用法：boss favorites ${action} <职位链接或 ID>`), execute: options.execute === true }) } };
      break;
    }
    case 'chats': {
      const [action = 'list', ...values] = rest;
      if (!['list', 'messages', 'send', 'start'].includes(action)) throw new UsageError('用法：boss chats [list|messages <会话 ID>|send <会话 ID> <文字>|start <职位>]');
      if (action === 'list' && values.length) throw new UsageError('chats list 不接受位置参数。');
      if (options.text !== undefined && options.message !== undefined) throw new UsageError('--text 和 --message 是消息正文的两种写法，请只指定其中一种。');
      if (action === 'messages') {
        result = { name: command, method: 'chats', args: { action, chatId: requireTarget(values, '用法：boss chats messages <会话 ID>'), ...pagination } };
      } else if (action === 'start') {
        const target = requireTarget(values, '用法：boss chats start <职位链接或 ID> [--text 自定义消息] [--execute]');
        const text = options.text ?? options.message;
        if (text !== undefined && !text.trim()) throw new UsageError('自定义消息不能为空白文字。');
        result = { name: command, method: 'chats', args: { action, target, ...(text !== undefined ? { text } : {}), execute: options.execute === true } };
      } else if (action === 'send') {
        const [chatId, ...textParts] = values;
        if ((options.text ?? options.message) && textParts.length) throw new UsageError('消息正文请通过位置参数或 --text 指定其中一种。');
        const text = options.text ?? options.message ?? textParts.join(' ');
        if (!chatId || !text?.trim()) throw new UsageError('用法：boss chats send <会话 ID> <文字> [--execute]');
        result = { name: command, method: 'chats', args: { action, chatId, text, execute: options.execute === true } };
      } else result = { name: command, method: 'chats', args: { action, ...pagination } };
      break;
    }
    case 'apply': {
      const explicitAction = ['preview', 'send'].includes(rest[0]);
      const action = explicitAction ? rest[0] : 'preview';
      const target = requireTarget(explicitAction ? rest.slice(1) : rest, '用法：boss apply [preview|send] <职位链接或 ID> [--resume-id 简历 ID] [--message 招呼语] [--execute]');
      if (action === 'preview' && options.execute) throw new UsageError('apply preview 不执行操作；提交请使用 apply send <职位> --execute。');
      if (options.resumeId !== undefined && (!options.resumeId.trim() || /[\x00-\x1f\x7f]/.test(options.resumeId))) throw new UsageError('--resume-id 不能为空白文字或包含控制字符。');
      result = { name: command, method: 'apply', args: { action, target, ...(options.message ? { message: options.message } : {}), ...(options.resumeId !== undefined ? { resumeId: options.resumeId } : {}), execute: action === 'send' && options.execute === true } };
      break;
    }
    default: throw new UsageError(`未知命令：${command}。请运行 boss --help。`);
  }
  const isWrite = (result.name === 'favorites' && result.args.action !== 'list') || (result.name === 'chats' && ['send', 'start'].includes(result.args.action)) || (result.name === 'apply' && result.args.action === 'send');
  if (options.execute && !isWrite) throw new UsageError('--execute 仅适用于 favorites add/remove、chats start/send 或 apply send。');
  validateCommandOptions(options, result);
  return result;
}

export const HELP = `boss-cli — BOSS 直聘求职端命令行工具

用法：node bin/boss.js <命令> [选项]

  login                           打开浏览器，手动登录并保存本地会话
  status                          查看登录状态和浏览器连接
  logout                          清除当前配置的本地登录状态
  cities [关键词]                  查询城市名称和代码
  search <关键词>                  搜索职位
  job <职位链接或 ID>              查看职位详情
  company <职位链接或 ID>          查看该职位关联的公司资料
  favorites [list]                查看收藏
  favorites add <职位>             预览收藏操作，--execute 后执行
  favorites remove <职位>          预览取消收藏，--execute 后执行
  chats [list]                    查看沟通列表
  chats messages <会话 ID>          查看消息
  chats start <职位>               预览发起沟通，--execute 后发送站点默认招呼
  chats send <会话 ID> <文字>        预览消息，--execute 后发送
  apply [preview] <职位>            预览职位和投递流程
  apply send <职位>                预览投递，--execute 后提交

搜索选项：
  --city <名称或代码> --page <页码> --limit <1–100>
  --salary <值> --experience <值> --education <值> --job-type <值>
  --industry <值> --scale <值> --stage <值> --business-district <值>
  --subway <值>                    过滤参数以当前站点支持范围为准

通用选项：
  --profile <名称>                 独立登录配置，默认 default
  --cdp-url <地址>                 连接已开启远程调试的 Chromium
  --browser-path <文件>            指定 Chromium、Edge 或 Chrome 可执行文件
  --timeout <毫秒>                 超时时间，默认 45000
  --wait <毫秒>                    login 等待手动登录的时长，最大 900000
  --headless                       使用无界面浏览器（手动登录时请省略）
  --json | --format table|json|csv   输出格式，默认 table
  --output <文件>                  保存输出到文件
  --text <文字> | --message <文字>  chats start 的自定义消息或 chats send 正文
  --message <文字>                 apply 投递后的跟进消息
  --resume-id <ID>                 apply 选择附件简历；多份简历时必须明确指定
  --execute                        明确执行收藏、发送或投递操作
  -h, --help                       显示帮助
  -v, --version                    显示版本

示例：
  node bin/boss.js login
  node bin/boss.js search "前端开发" --city 北京 --json
  node bin/boss.js job "https://www.zhipin.com/job_detail/…html"
  node bin/boss.js company <职位 ID> --json
  node bin/boss.js favorites add <职位 ID>

遇到登录、验证码或站点访问限制时，在浏览器中手动完成后重试。
`;
