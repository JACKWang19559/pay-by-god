# 环境和会话排错

先读取退出码和 JSON 错误的 `error.code`、`error.details`。成功结果在 stdout，错误在 stderr；不要把空 stdout 当作成功的空列表。使用 `--output` 时结果写入文件，stderr 的保存提示不是错误，仍需看退出码。

| 现象 | 处理 |
| --- | --- |
| `node` / `npm` 找不到 | 检查是否已安装及当前 PATH；安装符合项目 Node 版本要求的运行时后重开终端。不要用安装 playwright 的浏览器包代替系统 Edge / Chrome |
| PowerShell 只阻止 `npm.ps1` | 尝试 `npm.cmd --version`、`npm.cmd ci`，不改整机执行策略 |
| `ERR_MODULE_NOT_FOUND` / 离线检查 dependency 未通过 | 确认项目根，再按锁文件安装依赖。网络、代理或 npm 源失败应报告实际原因，勿静默关闭 TLS 校验或替换全局源 |
| `BROWSER_NOT_FOUND` | 检查浏览器路径；用 `login --browser-path "实际可执行文件"` 指定现有浏览器，或引导安装 |
| `status.connected=false` | 专用浏览器未运行；执行当前 profile 的 `login` 打开窗口，不据此删除登录数据 |
| `AUTH_REQUIRED` / `authenticated=false` | 检查是否选错 profile；在正确的专用窗口完成登录，再运行 `status` |
| `authenticated=null` / `BROWSER_STATE_UNAVAILABLE` | 页面跳转或状态探测未确认；查看当前页面与 `authenticationCheck`，等待页面稳定后再检查，不能宣布登录成功 |
| `BROWSER_RESTART_REQUIRED` | 旧版专用浏览器使用了过时启动配置。关闭错误详情指定的 profile 窗口，再运行同 profile 的 `login`，保留数据；不要结束所有 Edge / Chrome 进程 |
| `BROWSER_START_TIMEOUT` / `BROWSER_ENDPOINT_SAVE_FAILED` | 检查旧专用窗口是否仍占用该 profile、浏览器路径和该数据目录权限；只处理目标 profile，不删除其 Cookie 或端点清单来冒充修复 |
| `BROWSER_CONNECTION_FAILED` | 核对目标窗口、本机端口和是否设置了 `BOSS_CDP_URL`。高级 CDP 只接受带端口的本机回环 HTTP / WebSocket 地址，默认配置不需要手填端口 |
| `VERIFICATION_REQUIRED` / 站点 code 37 | 检查 `automaticCheck` 或当前可见页面。自动环境检查让网页自行完成；人工验证由用户操作。CLI 已在搜索/详情前等待正常页面初始化，不再叠加抓 token、伪造验证码参数或后台重试 |
| `BROWSER_INITIALIZATION_TIMEOUT` / `BROWSER_SESSION_UNAVAILABLE` | 保留窗口查看页面是否空白、关闭、网络不通；根据错误提示处理目标 profile。仅在环境有实际变化后再明确尝试一次，不循环重启 |
| `RATE_LIMITED` | 停止本轮请求并告知访问频率限制，不通过增加并发或更换账号重试 |
| `STALE_JOB_CONTEXT` | 重新搜索或读取收藏获取当前职位完整链接，不继续发送旧的 securityId / lid |
| `SITE_CHANGED` / `JOB_MISMATCH` | 保留错误，核对职位有效性和实际目标；不能改用首页、其他职位或缓存描述冒充成功 |

`--wait` 只适用于 `login`；慢速正常请求可以按需要提高 `--timeout`，但增加等待不是认证或验证问题的修复。CLI 没有自动更新功能，不能建议不存在的 `boss update` / `boss config` / `boss doctor` 命令。

本地数据默认在项目的 `.boss-cli`。浏览器 profile 和职位缓存可能含登录资料与职位上下文；排错只记录必要状态、错误码和脱敏路径，不打包上传整个目录。报告 code 37 的具体响应时保留业务码即可，不输出服务器返回的挑战字段。
