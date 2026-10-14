# pay-by-god

BOSS 直聘求职端命令行工具，提供职位搜索、职位及关联公司资料、收藏、沟通与附件简历投递命令，使用 CLI 专用 Edge / Chrome 浏览器中的正常登录会话。

当前版本为 `0.1.0`，不是 BOSS 直聘官方 API。**搜索、职位详情与职位关联公司资料已通过真实站点只读验证；收藏、沟通和投递写操作通过隔离测试，尚未完成真实账号写入验证。**

搜索与详情会先等待正常职位页面完成初始化，再发送请求；支持完整职位链接、缓存 ID 和无缓存 ID 的页面读取。站点要求人工验证时，需要在专用浏览器中完成。

## 配套 skills

项目的 `skills/` 目录提供五个中文技能，可向支持本地 skills 的客户端指定相应 `SKILL.md` 使用。它们保存在本项目中，未自动安装到用户的全局技能目录。

| 技能 | 用途 |
| --- | --- |
| [boss-cli-setup](skills/boss-cli-setup/SKILL.md) | 新手环境检查、Node/npm 与浏览器配置、独立账号登录引导及常见错误处理；附离线预检脚本 |
| [boss-cli-jobs](skills/boss-cli-jobs/SKILL.md) | 城市、职位搜索与筛选、职位及关联公司资料读取和结果导出 |
| [boss-cli-favorites](skills/boss-cli-favorites/SKILL.md) | 收藏分页查看、收藏与取消收藏 |
| [boss-cli-chat](skills/boss-cli-chat/SKILL.md) | 会话与历史消息、发起沟通、消息预览和发送 |
| [boss-cli-apply](skills/boss-cli-apply/SKILL.md) | 附件简历预览、选择与投递 |

例如：让客户端“使用 `skills/boss-cli-setup/SKILL.md`，帮我检查环境并引导首次登录”。每个技能包含独立的 `SKILL.md` 和 `agents/openai.yaml`；调用涉及发送、投递或收藏变更的技能本身不代表授权这些写操作。

## 安装与登录

需要 Node.js **22 或更新版本**、npm，以及已安装的 Microsoft Edge 或 Google Chrome。

下载或克隆本仓库后，在 PowerShell 中进入项目根目录。下面按仓库名 `pay-by-god` 举例：

```powershell
cd pay-by-god
npm ci
node bin/boss.js --help
node bin/boss.js login
```

Windows 也可使用目录内的快捷启动器，命令与选项相同：

```powershell
.\boss.cmd login
.\boss.cmd status --json
.\boss.cmd cities 成都
```

CLI 会自动检测 Edge / Chrome，打开独立的浏览器配置目录。正常使用时需要本人在该窗口完成站点登录；已有浏览器个人资料不会被直接读取或复制。浏览器窗口可以保持打开，后续命令会重新连接同一会话。

专用浏览器使用非零随机本机调试端口，并在本次启动中禁用扩展，避免同步扩展干扰站点初始化；不会卸载扩展。旧版本打开的专用窗口会显示 `BROWSER_RESTART_REQUIRED`：关闭该 profile 的窗口后重新运行 `boss login`，登录数据保留。已运行的新版本窗口可直接复用。

```powershell
node bin/boss.js login --wait 120000
node bin/boss.js status --json
```

`--wait`、`--timeout` 的单位都是毫秒。login 默认打开窗口后返回；`--wait` 可等待登录，最大 900000。命令默认超时 45000，可用 `--timeout` 调整，最大 600000。

自动检测失败时指定已安装浏览器：

```powershell
node bin/boss.js login --browser-path "<已安装浏览器的可执行文件绝对路径>"
```

多个账号可以使用不同的配置名，并在每条命令中保持一致：

```powershell
node bin/boss.js login --profile job-search
node bin/boss.js status --profile job-search
```

`logout` 会立即清除当前 CLI 会话的本地站点 Cookie / 存储；它不要求 `--execute`：

```powershell
node bin/boss.js logout
```

## 搜索与详情

```powershell
node bin/boss.js cities 成都
node bin/boss.js search "Python" --city 成都 --page 1 --limit 15 --json
node bin/boss.js search "前端开发" --city 北京 --salary "10-20K" --experience "1-3年" --education 本科
```

搜索可使用城市名称或 `cities` 返回的城市代码。筛选选项包括：

| 选项 | 示例或含义 |
|---|---|
| `--salary` | `10-20K`、`20-50K` 或站点代码 |
| `--experience` | `1-3年`、`3-5年`、`应届生` |
| `--education` | `本科`、`硕士`、`大专` |
| `--job-type` | `全职`、`兼职` |
| `--scale` | `20-99人`、`100-499人` |
| `--stage` | `A轮`、`已上市` |
| `--industry` | 站点行业代码 |
| `--business-district` | 站点区域 / 商圈值 |
| `--subway` | 站点地铁筛选值 |

多选值使用逗号分隔。行业、商圈、地铁值应使用当前站点提供的值；CLI 不生成这些代码。

查看详情时优先复制 `search` 输出中的**完整职位链接**，保留站点的 `securityId` 和 `lid`。也接受已缓存的加密职位 ID；仅有 ID 且没有缓存时，会尝试正常打开职位详情页。

以下示例中的 `$job`、`$chat`、`$resume` 都需要替换为实际返回值：

```powershell
$job = "从 search 输出复制的完整职位链接"
node bin/boss.js job "$job" --json
```

搜索与详情受站点当前登录、验证及职位有效性影响。HTTP 200 或打开了网页不代表接口成功；CLI 会检查业务返回码。当前前端的“查看更多信息”仍指向 `/job_detail/<ID>.html?securityId=…`；没有证据支持另造一个 SPA 详情地址。正常详情导航若跳回首页，CLI 会停止并报告错误，不从首页冒充读取指定职位。

每个新命令会先让正常职位页面完成初始化，等待页面自己的搜索或推荐列表成功，再发送 CLI 请求。初始化仅观察页面和网络事件，不启用控制台对象预览；同一客户端的后续读取可复用准备状态。站点的自动环境检查由网页自行完成，人工验证页则保留供本人处理。接口若仍拒绝请求，会返回原始业务错误，不自动重试。

搜索 JSON 会显示实际发送的筛选代码。详情 JSON 的 `context.source` 表示链接、缓存或页面来源。链接提供新 `securityId` 时，不会拼接旧缓存的 `lid`；纯数字内部 ID 不作为加密职位 ID 使用。

CLI 自动复用职位缓存的本地期限为 **30 分钟**，这不是站点公布的有效期。超过期限时尝试正常页面获取新上下文；没有新数据会报告 `STALE_JOB_CONTEXT`。验证、认证、限流或网络错误会直接停止，不借刷新缓存重新请求。每次 `login` / `logout` 会清理当前 profile/CDP scope 的职位缓存，其他 scope 与城市缓存保留。

## 职位关联公司资料

从指定职位读取公司资料，使用同一个完整职位链接或加密职位 ID：

```powershell
node bin/boss.js company "$job" --json
node bin/boss.js company "$job" --profile job-search --json --output ".\exports\company.json"
```

`company` 是只读命令，不接受 `--execute` 或搜索筛选参数；它查询给定职位关联的公司，不按公司名称搜索。与 `job` 一样优先使用搜索或收藏结果中的完整职位链接，并沿用取得该职位时的 profile。

输出按站点实际提供的数据包含公司名称 `name`、行业 `industry`、规模 `scale`、融资阶段 `stage`、介绍 `description` 和福利 `welfare`，以及关联职位 `job`、数据来源 `observedFrom` 和上下文 `context`。公司标识及可用上下文充分时还会提供公司主页 `url`；匿名或代招等情况下不推算主页。

`name` 是职位中展示的公司；`recruitingCompany.name` 是招聘者展示的公司，两者在代招场景可能不同，不据此推断实际劳动合同主体。缺失字段不补造；`job.workAddress` 仅在站点允许展示时输出，是该岗位的工作地点，不是公司注册地址。该命令读取职位附带的公司资料，不包含公司主页的完整工商信息。

无缓存职位 ID 会正常打开详情页读取；页面不提供完整资料时，结果可能只有公司名称与介绍。未取得公司名称会报告 `COMPANY_INFO_UNAVAILABLE`，不会把空对象当作完整公司资料。

## 收藏

远程业务写操作默认只返回预览，**每次加入 `--execute` 才执行**。

```powershell
node bin/boss.js favorites list --page 1 --limit 15
node bin/boss.js favorites list --page 3 --limit 20 --json
node bin/boss.js favorites add "$job"
node bin/boss.js favorites add "$job" --execute
node bin/boss.js favorites remove "$job"
node bin/boss.js favorites remove "$job" --execute
```

预览会读取当前职位 / 收藏状态，但不会提交收藏变更。已经处于目标状态时返回 `unchanged`。

CLI 会按需读取站点分页，再组成指定 `--page` / `--limit` 的结果。列表返回 `total` 和 `hasMore`；站点没有提供足够信息时可能为 `null`，不能当作 0 或没有更多结果。可查询的收藏范围以站点实际返回为准。

## 沟通与消息

```powershell
node bin/boss.js chats list --page 1 --limit 20 --json
$chat = "从 chats list 返回结果中复制的 chatId"
node bin/boss.js chats messages "$chat" --page 1 --limit 20 --json
```

`chatId` 由站点好友 ID 与 source 组成。不要把职位 ID、加密 Boss ID 或姓名当作 chatId。消息历史按站点游标读取，CLI 不通过点击会话来读取历史。

发起职位沟通：

```powershell
node bin/boss.js chats start "$job"
node bin/boss.js chats start "$job" --execute
node bin/boss.js chats start "$job" --message "您好，我对这个职位感兴趣，希望进一步了解。"
node bin/boss.js chats start "$job" --message "您好，我对这个职位感兴趣，希望进一步了解。" --execute
```

站点“开始沟通”本身可能发送账号设置的默认招呼语；`--message` / `--text` 是开聊成功后**追加**的自定义消息，可能形成两条消息。收件人无法唯一确认时会停止追加消息并报告部分成功。

向已有会话发消息：

```powershell
node bin/boss.js chats send "$chat" "您好，方便介绍一下团队和工作内容吗？"
node bin/boss.js chats send "$chat" --text "您好，方便介绍一下团队和工作内容吗？" --execute
```

正文限制为 1–999 个字符。执行时会核对实际收件人，调用站点现有编辑器，并等待与本次消息匹配的应用层回执。已有浏览器草稿会阻止覆盖。`DELIVERY_UNCONFIRMED` 表示没有确认送达，CLI 不会自动重发；应先核对会话记录，避免重复消息。

## 附件简历投递

先预览职位、当前附件简历列表与可选 `resume-id`：

```powershell
node bin/boss.js apply preview "$job" --json
node bin/boss.js apply "$job" --json
```

`apply` 不写子命令时等同 `apply preview`。`apply send` 也默认预览：

```powershell
$resume = "从 apply preview 返回的 resumes 列表复制附件 ID"
node bin/boss.js apply send "$job" --resume-id "$resume"
node bin/boss.js apply send "$job" --resume-id "$resume" --execute
```

只有一份附件时可自动选择；多份附件必须明确指定 `--resume-id`。账号没有附件简历时，需要通过网站正常上传，CLI 当前没有上传命令。职位网申、不可投递或站点额外确认流程会按实际状态停止或显示站点提示。

附加投递后的跟进文字：

```powershell
node bin/boss.js apply preview "$job" --resume-id "$resume" --message "您好，已附上我的简历，期待进一步沟通。"
node bin/boss.js apply send "$job" --resume-id "$resume" --message "您好，已附上我的简历，期待进一步沟通。" --execute
```

`--message` 是附件提交后的独立消息。若简历已提交而跟进消息失败，会报告 `PARTIAL_SUCCESS`；不要为了重发文字而重复投递附件。只有收到服务端回执才报告提交成功，点击按钮或本地消息对象不算完成。

## 输出、配置与退出码

默认输出表格；复杂预览以结构化内容显示。JSON 保留完整字段，表格会缩短较长单元格，CSV 适合导入表格软件。

```powershell
node bin/boss.js cities 成都 --json
node bin/boss.js favorites list --format csv --output ".\exports\favorites.csv"
node bin/boss.js status --json --output ".\exports\status.json"
```

结果写入 stdout，错误写入 stderr。使用 `--output` 时保存结果，并在 stderr 提示文件路径。默认不额外创建日志文件；JSON 模式错误结构为 `{ "ok": false, "error": { "code", "message", "details" } }`。

| 退出码 | 含义 |
|---|---|
| `0` | 命令完成；预览成功也返回 0，需查看 `executed` 才能判断是否执行 |
| `1` | 其他业务拒绝、站点结构变化、收件人不匹配、部分成功或送达未确认等错误 |
| `2` | 参数或命令用法错误 |
| `3` | 需要登录或登录状态不可用 |
| `4` | 安全验证、网络、超时、访问频率限制等暂时不可用情况；具体以错误 code / details 为准 |

PowerShell 可用 `$LASTEXITCODE` 读取退出码。`PARTIAL_SUCCESS`、`DELIVERY_UNCONFIRMED` 都不应触发脚本盲目重试写操作。

| 配置方式 | 用途 |
|---|---|
| `--profile` / `BOSS_PROFILE` | 独立配置名称，默认 `default` |
| `--browser-path` / `BOSS_BROWSER_PATH` / `CHROME_PATH` | 浏览器可执行文件 |
| `--timeout` / `BOSS_TIMEOUT` | 毫秒超时 |
| `BOSS_CLI_HOME` | 数据目录，默认本项目下 `.boss-cli`；相对值按项目目录解析 |
| `--cdp-url` / `BOSS_CDP_URL` | 连接已有的本机回环 CDP 会话，例如 `http://127.0.0.1:9222` |
| `--headless` | 无界面模式；需要手动登录或验证时应使用正常窗口 |

`--cdp-url` 属于高级用法，会使用所连接浏览器的站点会话；默认的独立 profile 更便于区分账号。CLI 只接受本机回环调试地址。

## 本地数据位置

默认数据都在本目录下：

| 路径 | 内容 |
|---|---|
| `.boss-cli/profiles/<profile>/` | 浏览器 Cookie、站点本地存储与登录状态，由浏览器持久化；按账号机密数据保管 |
| `.boss-cli/profiles/<profile>/BossCliEndpoint.json` | 专用浏览器的本机端口及浏览器实例标识，重连时校验；不包含 Cookie |
| `.boss-cli/cache/cities.json` | 城市列表缓存 |
| `.boss-cli/cache/profiles/<profile>/jobs.json` | 该 profile 的最近职位与关联上下文，可能包含 securityId、lid 等标识 |
| `.boss-cli/cache/profiles/<profile>-<endpointHash>/jobs.json` | 显式 CDP 连接的独立职位缓存；endpointHash 是调试地址 SHA-256 的前 16 位 |
| `research/` | 本地研究素材、诊断记录和截图；不随源码提交 |
| `--output` 指定的文件 | 查询结果、预览或消息内容，保存位置由调用者选择 |

CLI 不需要导出 Cookie 或手工填写 token。搜索和详情先通过独立 CDP 连接在默认浏览器上下文中完成页面初始化，随后站内 API 通过 Playwright 的 `BrowserContext.request` 共享该上下文的 Cookie jar。Cookie 不会导出为 CLI 配置；API 请求不依赖页面中的 JavaScript 执行上下文。公开城市数据可直接读取。输出会屏蔽已知 Cookie / token / password 字段，但职位、消息、简历名称等业务内容仍会出现在正常结果中。

`.gitignore` 排除默认浏览器数据目录、研究记录、`exports/`、本地环境配置和日志。自定义 `BOSS_CLI_HOME` 或将 `--output` 保存到其他位置时，应选择仓库外的目录，或为该路径添加忽略规则。忽略规则只影响 Git 未跟踪的文件，不会过滤手动上传的文件或移除已有提交中的数据。

## 已验证状态与限制

| 项目 | 结果 |
|---|---|
| 登录状态、城市查询 | 已通过真实只读验证 |
| 职位搜索、筛选与翻页 | 已通过真实只读验证 |
| 完整链接、缓存 ID 与无缓存 ID 的详情 | 已通过真实只读验证 |
| 收藏列表、会话与消息历史、附件简历元数据 | 已通过真实只读验证 |
| 消息发送预览 | 已验证预览不会发送消息 |
| 收藏变更、开聊、发送消息、投递附件 | 通过本地隔离测试，未进行真实账号写入验证 |

[隔离浏览器端到端测试](test/browser-integration.test.js) 使用真实 Edge 引擎和本地模拟响应，覆盖登录、查询、预览、写入流程、消息回执、预检超时、验证错误和退出登录。隔离测试通过不代表真实站点已接受业务写入。

登录成功不保证所有接口可访问。站点变化或当前会话限制可能返回 `VERIFICATION_REQUIRED`、`SITE_CHANGED` 等错误，CLI 不会将其伪装成空结果。人工验证由本人完成，状态不明的写操作不会自动重试。

## 开发与测试

```powershell
npm test
npm run check
```

测试使用合成业务数据和脱敏的公开城市结构，不依赖登录账号或本地研究目录。浏览器集成测试需要已安装的 Edge / Chrome，其网络请求使用本地模拟响应。测试覆盖初始化顺序、CDP 上下文选择、身份核对、缓存期限、预览和写入边界等行为。

源码与配套技能位于 `src/`、`bin/`、`test/` 和 `skills/`。个人运行报告、下载的前端素材及一次性诊断脚本保留在本地，不随 Git 提交。使用本 CLI 不需要 Ghidra 或 IDA。

## 许可证

本项目采用 [MIT License](LICENSE)。
