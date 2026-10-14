---
name: boss-cli-jobs
description: 使用本地 boss-cli 查询 BOSS 直聘城市、按条件搜索职位、读取职位详情并导出结果。用户需要找工作、筛选或比较职位、查看职位链接时使用；不用于发送消息、投递简历或改变收藏。
---

# 职位搜索与详情

## 找到 CLI

从当前工作目录及其父目录、用户提供的项目目录，或本技能所在目录的父目录中定位项目。确认 `package.json` 的 `name` 为 `boss-cli`，且存在 `bin/boss.js`；不要把全局安装后的技能目录当成项目根。找不到时询问项目位置。

在确认的项目根执行以下命令，不依赖全局 `boss` 命令。Node.js 需为 22 或更新版本；缺依赖、浏览器或登录时使用可用的 `boss-cli-setup` 技能，或读取该项目 README 的安装与登录部分。沿用用户选定的 `--profile`、`--cdp-url` 等配置，跨命令保持一致。

## 城市与搜索

以用户给出的关键词、地区和条件为准。常见明确城市可直接传名称；简称、拼音或多个匹配时先查城市，以返回的准确名称或代码搜索。未指定城市且不影响任务时可省略，明确说明这是全国范围。

```powershell
node bin/boss.js cities "成都" --json
node bin/boss.js search "Python" --city "成都" --page 1 --limit 15 --json
node bin/boss.js search "前端开发" --city "北京" --salary "10-20K" --experience "1-3年" --education "本科" --json
```

可用搜索参数：

| 参数 | 支持值示例或来源 |
|---|---|
| `--city` | 城市准确名称或 `cities` 返回的代码 |
| `--page` / `--limit` | 页码 1–500；每页 1–100，默认 1 / 15 |
| `--salary` | `3K以下`、`3-5K`、`5-10K`、`10-20K`、`20-50K`、`50K以上`、`不限` |
| `--experience` | `在校生`、`应届生`、`经验不限`、`1年以内`、`1-3年`、`3-5年`、`5-10年`、`10年以上`、`不限` |
| `--education` | `初中及以下`、`中专/中技`、`高中`、`大专`、`本科`、`硕士`、`博士`、`不限` |
| `--job-type` | `全职`、`兼职`、`不限` |
| `--scale` | `0-20人`、`20-99人`、`100-499人`、`500-999人`、`1000-9999人`、`10000人以上`、`不限` |
| `--stage` | `未融资`、`天使轮`、`A轮`、`B轮`、`C轮`、`D轮及以上`、`已上市`、`不需要融资`、`不限` |
| `--industry` / `--business-district` / `--subway` | 用户或当前站点提供的行业、区域商圈、地铁值；CLI 没有这些字典的查询命令，不猜测代码 |

筛选也接受站点代码，多选用逗号分隔。用户条件与站点区间不完全一致时，说明采用的区间并在结果中核对，不宣称精确匹配。CLI 没有 `--sort`、`--remote` 等参数；需查看真实字段后本地排序或筛选，缺失信息标注未知。

读取成功 JSON 中的 `items`、`city`、`page`、`limit`、`filters` 和 `hasMore`。`filters` 是实际发送的代码。按用户所需范围串行翻页，`hasMore=false` 或空页即停止；不要把一页数量当成全站总数，不为普通查询自动拉取所有页。跨页汇总按 `id` 去重。

## 详情与上下文

优先使用本次 `search` 或 `favorites list` 返回的 `url`，完整保留查询参数。PowerShell 中将带 `&` 的链接作为带引号的参数传入。

```powershell
$job = '从结果中取得的完整职位 URL'
node bin/boss.js job "$job" --json
```

- 支持完整职位链接、已有缓存的加密职位 ID；无缓存裸 ID 会正常打开详情页尝试读取。不要使用纯数字内部 ID 或自行拼装 `securityId` / `lid`。
- CLI 的职位缓存按 profile/CDP scope 隔离，自动复用期限为 30 分钟，这是本地策略。详情的 `context.source` 为 `url`、`cache` 或 `rendered-page`；`observedFrom` 标记 API 或网页来源。
- `STALE_JOB_CONTEXT` 表示没有取得新上下文；可在本次任务范围内重新执行原搜索或读取收藏一次，取得目标的新链接再继续。不要修改缓存时间、跨账号搬运上下文，或把首页内容当成详情。
- 核对返回 `id` 与目标一致；引用 `title`、`company`、`salary`、`city`、`experience`、`education`、`description` 等实际字段。职位缺失字段或描述为空时如实说明，不补造信息。

## 导出与呈现

默认供用户阅读的表格会截短长字段，分析用 `--json`。用户要求保存时选用 `--format csv` 或 `--json` 配合 `--output`；只在确认目标文件可写后执行，现有同名文件会被覆盖。

```powershell
node bin/boss.js search "Python" --city "成都" --format csv --output ".\exports\python-chengdu.csv"
node bin/boss.js job "$job" --json --output ".\exports\job-detail.json"
```

命令只导出本次查询结果，不自动汇总其他页。成功结果在 stdout；指定 `--output` 后结果在文件，路径提示在 stderr。JSON 错误在 stderr，形如 `{"ok":false,"error":{"code","message","details"}}`，先检查退出码再解析结果。

汇报实际查询范围与结果数量，给出有用字段和职位链接；比较结论注明依据，不把排序等同于录用概率。导出的职位 URL 和上下文按个人数据保管，不上传到无关服务。

## 停止条件

- `AUTH_REQUIRED`：停止本次请求，指导本人完成正常登录。
- `VERIFICATION_REQUIRED`（包括 `details.apiCode=37`）：停止，不自动刷新、重试或改参数绕过；CLI 已负责正常网页初始化，查看保留的浏览器页面，人工验证由本人完成。
- `BROWSER_RESTART_REQUIRED`：只重启 CLI 对应 profile 的专用窗口，再正常登录，不结束所有浏览器进程。
- `RATE_LIMITED`、网络或超时错误：报告原因，停止本轮抓取，不循环重试。
- `JOB_MISMATCH`、`SITE_CHANGED`、其他站点拒绝：保留错误含义，不能当成“没有职位”，也不能用其他职位代替。

搜索和详情本身不授权收藏、开聊、发消息或投递；不调用这些写命令。
