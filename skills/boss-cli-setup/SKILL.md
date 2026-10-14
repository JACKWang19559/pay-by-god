---
name: boss-cli-setup
description: BOSS CLI 新手入门：检查 Node.js、依赖和浏览器，配置独立 profile，引导本人登录并核验状态。用于首次使用、换账号、环境缺失、登录失效或 code 37 等连接与验证问题；不代替职位搜索、聊天或投递。
---

# BOSS CLI 环境与登录

将用户带到 CLI 能运行、专用浏览器可连接且登录状态已确认的状态。以项目的 `package.json`、`node bin/boss.js --help` 和实际错误为准，不把安装依赖等同于登录成功。

## 找到项目并检查环境

- 优先使用当前工作区中 `package.json` 的 `name` 为 `boss-cli`、同时存在 `bin/boss.js` 的目录。本 skill 可能被复制到别处，不依赖其父目录就是项目，也不写死作者电脑的路径。多个候选无法区分时才询问项目位置。
- 后续命令均在项目根执行；有空格或中文的路径使用参数引用。默认使用 `node bin/boss.js`，不假定已全局安装 `boss`。Windows 可使用项目的 `boss.cmd`。
- 先运行 `node --version`、`npm --version`。当前项目要求 Node.js 22 或更高版本。缺少运行时则引导安装满足 `engines.node` 的 Node.js 和 npm，安装后重新打开终端确认。需要安装浏览器时使用 Edge / Chrome 官方发行版本，安装方式按用户系统及已有授权选择。
- Node 可用后运行本 skill 的离线检查器，其中路径替换为已确认的实际路径：

  ```powershell
  node "<本 skill 目录>/scripts/preflight.mjs" "<项目根目录>"
  ```

  检查器只读项目元数据、解析依赖和检查浏览器可执行文件；不会联网、打开浏览器或读取 Cookie。`readyForLogin` 仅代表环境基本齐备，不代表已登录。设置了 `BOSS_CDP_URL` 时，外部浏览器连接需另行检查。
- 依赖缺失、损坏或不匹配时，在存在 `package-lock.json` 的项目运行 `npm ci`；没有锁文件才用 `npm install`。依赖正常则跳过安装。不要默认执行 `npm update`、全局安装、修改系统执行策略或删除 profile。PowerShell 若仅拦截 `npm.ps1`，可使用 `npm.cmd`。
- 运行 `node bin/boss.js --help` 确认入口正常；它不启动浏览器。

## 配置会话

默认使用已有的 `default` profile，除非用户指定其他名称或需要独立账号。后续每个命令保持相同 profile。profile 仅支持 1–64 位字母、数字、点、下划线和短横线，须以字母或数字开头，不能使用 Windows 设备保留名。

| 配置 | 用法与影响 |
| --- | --- |
| `--profile` / `BOSS_PROFILE` | 选择独立登录配置，默认 `default` |
| `--browser-path` / `BOSS_BROWSER_PATH` / `CHROME_PATH` | 自动查找失败时指定实际存在的 Edge / Chrome 可执行文件 |
| `--timeout` / `BOSS_TIMEOUT` | 命令超时，单位毫秒；默认 45000，最大 600000 |
| `BOSS_CLI_HOME` | 数据位置；默认项目的 `.boss-cli`，相对路径按项目根解析。更改会切换浏览器资料和缓存位置 |
| `--cdp-url` / `BOSS_CDP_URL` | 高级用法，连接用户指定的本机回环浏览器；新手默认使用 CLI 管理的独立 profile |

先检查现有相关环境变量是否设置，不输出可能携带凭据的原始连接地址。不要为排错静默覆盖用户环境变量。一次性配置优先命令参数；用户需要持久配置时再选进程、用户或项目范围。CLI 没有 `config` 命令，也不自动加载 `.env`。

## 引导登录并核验

示例使用 `default`；用户选了其他 profile 时替换每个命令中的值。

```powershell
node bin/boss.js status --profile default --json
node bin/boss.js login --profile default --wait 120000 --json
node bin/boss.js status --profile default --json
```

1. 先读 `status`；该命令不会主动启动已关闭的专用浏览器。若 `connected=true`、`authenticated=true` 且无需验证，直接复用。不要为例行检查重复 `login`，它会清理该 scope 的职位缓存。
2. 需要登录时打开可见窗口并引导用户本人扫码或按站点流程登录，不使用 `--headless`。`--wait` 是等待登录的毫秒数，最大 900000；等待超时不等于登录成功。不要索取聊天中的密码、短信验证码或 Cookie。
3. 保留专用窗口，完成后再次执行 `status`。`authenticated=null` 表示尚未确认，不能当作已登录或已退出；根据 `authenticationCheck`、页面状态及错误处理。验证码或人工验证由用户在该窗口处理。
4. 以状态字段确认结果。可以按用户需求继续一次只读搜索；公开的 `cities` 成功仅证明城市查询可用，不能证明账号已登录。不得因“测试配置”自动收藏、开聊、发消息或投递。

专用浏览器会保存登录数据，后续 CLI 退出仅断开连接。当前版本由 CLI 分配非零本机调试端口，并在专用启动中禁用扩展；不要让用户手工注入 token、额外调试启动参数或复制个人浏览器资料。用户明确要求退出时才运行 `logout`，它会立即清除当前会话的站点登录数据，不需要 `--execute`。

## 排错与交付

遇到安装、连接、`BROWSER_RESTART_REQUIRED`、`VERIFICATION_REQUIRED` / code 37 等问题时，按 [references/troubleshooting.md](references/troubleshooting.md) 的对应行处理。不要盲目循环重试，也不要用删除用户资料作为通用修复。

完成时简短说明项目位置、Node 与浏览器检查结果、所用 profile、实际登录状态，以及用户下一步可运行的命令。需要用户在窗口扫码或完成验证时，明确告诉他待完成的是哪一步，保留当前窗口；仅环境检查通过时不要声称整个登录引导已完成。
