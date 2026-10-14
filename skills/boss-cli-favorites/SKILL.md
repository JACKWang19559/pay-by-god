---
name: boss-cli-favorites
description: 使用本地 boss-cli 查看和导出 BOSS 直聘收藏职位，预览或按用户明确要求添加、取消收藏。用户需要管理职位收藏时使用；不用于开聊、发消息或投递简历。
---

# 职位收藏

## 找到 CLI

从当前工作目录及其父目录、用户提供的项目目录，或本技能所在目录的父目录中定位项目。确认 `package.json` 的 `name` 为 `boss-cli`，且存在 `bin/boss.js`。技能安装到全局目录后仍需定位项目，不能直接以技能目录为工作目录。

以下命令在该项目根执行，使用 Node.js 22 或更新版本。沿用同一 `--profile`、`--cdp-url` 等会话配置。缺环境或登录时使用可用的 `boss-cli-setup` 技能，或读取项目 README 的安装与登录部分；不导出 Cookie 或让用户提供 token。

## 读取与导出

```powershell
node bin/boss.js favorites list --page 1 --limit 15 --json
node bin/boss.js favorites list --page 3 --limit 20 --json
node bin/boss.js favorites list --format csv --output ".\exports\favorites.csv"
```

`favorites` 默认等同于 `favorites list`。列表支持 `--page`（1–500）和 `--limit`（1–100），返回 `items`、`page`、`limit`、`total`、`hasMore`。CLI 已处理站点每页 15 条和逻辑分页的换算，不需自己拼站内请求。

按用户要求的范围串行读取，按 `id` 去重；`hasMore=false` 或空页即停止。`hasMore=null` 表示站点未提供足够信息，用户确需完整列表时可再读下一页；若整页都是已见 ID，则停止并说明无法确认完整性。`total=null` 不能当成 0；不要把站点返回的范围称为账号历史全部收藏。

列表会刷新当前 scope 的职位上下文。查看某项详情可运行 `node bin/boss.js job "$job" --json`，其中 `$job` 来自该项完整 `url`。导出只保存本次命令返回的页，跨页汇总需对已成功读取的结果另存；`--output` 会覆盖同名文件，先检查目标路径。

## 添加或取消收藏

目标来自用户明确给出的链接、当前搜索或收藏结果。优先使用完整 `url`，保留 `securityId` 和 `lid`；不要用职位标题、公司名或纯数字内部 ID 替代加密职位 ID。用户说“这几个”而上下文不能唯一对应时，先确认目标。

先读取预览，核对 `job.id`、职位、公司、`current` 与 `desired`：

```powershell
$job = '从用户或结果中取得的完整职位 URL'
node bin/boss.js favorites add "$job" --json
node bin/boss.js favorites remove "$job" --json
```

没有 `--execute` 时只返回预览，`executed=false`；预览也会读取真实职位及当前状态。`current=null` 表示未知，不代表未收藏。

用户已经明确要求对这些目标添加或取消收藏时，预览核对无误即可继续执行，无需重复询问同一授权。仅要求查看、筛选、整理建议或预览时，不执行；技能被调用本身不授权远程变更。

```powershell
node bin/boss.js favorites add "$job" --execute --json
node bin/boss.js favorites remove "$job" --execute --json
```

只执行需要的那一个动作。批量授权按已明确目标逐项执行；不要从“找合适岗位”推导出自动收藏，也不要顺带开聊或投递。

- `executed=true` 且有成功回执才报告本次变更成功。
- `unchanged=true` 表示已处于目标状态，本次没有重复提交；它可以同时带 `executed=false`。
- 退出码 0 也可能只是预览或无需变更，不能据此声称写入成功。
- 批量报告分别列出成功、已满足、失败或未执行的项；任一项状态不明时暂停剩余写入，避免重跑整批。

## 错误与恢复

JSON 错误输出在 stderr，形如 `{"ok":false,"error":{"code","message","details"}}`。保留 `error.code` 和有用的 `details`；不要把错误解析成空收藏列表。

- `AUTH_REQUIRED`：停止，指导本人正常登录；保持账号/profile 一致。
- `VERIFICATION_REQUIRED`，包括站点 `code=37`：停止，不自动刷新、重试或改参数绕过。查看 CLI 保留的浏览器页面，人工验证由本人完成。
- `BROWSER_RESTART_REQUIRED`：只重启对应 profile 的专用浏览器窗口，再正常登录，不结束全部浏览器进程。
- `RATE_LIMITED`、网络或超时错误：停止本轮操作，不循环重试。
- `STALE_JOB_CONTEXT`：可在任务范围内重新搜索或读取收藏一次，取得同一目标的最新链接后重新预览；不要手改缓存或复用其他账号上下文。
- `JOB_MISMATCH`、`SITE_CHANGED` 或站点业务拒绝：停止，核对目标和真实页面，不猜测参数继续提交。
- `DELIVERY_UNCONFIRMED`：收藏请求可能已经提交。不要再次执行 add/remove；先只读核对该职位 `relationship.favorite` 或浏览器中的收藏状态。仍无法确认就报告未确认，不用重复写入“验证”。

本项目收藏写入有本地隔离测试，但当前 README 未宣称真实账号写入已验证。只依据本次实际返回报告结果，不将测试通过当作线上成功。
