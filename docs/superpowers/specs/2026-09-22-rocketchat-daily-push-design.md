# Rocket.Chat 每日增量推送设计

## 背景与目标

本仓库是 `xuanli199/weekly` 的 fork，内容由上游人工整理到 `docs/<期数>.md`，并非每日新闻采集器。
本功能每天检查一次上游 `main`，仅在上游出现新的或修订过的周刊内容时，将增量摘要推送到内网
Rocket.Chat 的 `#general` 频道。

定时检查时间固定为北京时间每天 09:00。无内容变化时保持静默。功能不自动生成新闻、不自动合并
上游提交，也不修改 fork 的工作分支。

## 运行架构

自动化运行在能够访问 Rocket.Chat 内网地址的当前 Linux 服务器上，由 systemd 管理：

1. `weekly-rocketchat.service` 是一次性任务，每次执行一个 Node.js 脚本。
2. `weekly-rocketchat.timer` 使用 `OnCalendar=Asia/Shanghai *-*-* 09:00:00` 每日触发，并开启
   `Persistent=true`，服务器错过执行时间后会在下次启动时补跑。
3. 脚本在仓库中执行 `git fetch upstream main`，只刷新远端引用，不 checkout、merge、rebase 或 push。
4. 脚本比较持久化状态中的最后成功提交与 `upstream/main`，生成增量消息。
5. Rocket.Chat 明确返回成功后，脚本以原子替换方式推进状态文件。

代码保存在 fork 内，运行时状态和密钥保存在仓库外：

- 推送程序：`scripts/weekly-rocketchat.mjs`
- systemd 模板：`deploy/weekly-rocketchat.service`、`deploy/weekly-rocketchat.timer`
- 运行状态：`/var/lib/weekly-rocketchat/state.json`
- 私密配置：`/etc/weekly-rocketchat.env`，权限 `0600`

## 增量检测

状态文件至少记录：

- `lastSuccessfulCommit`：最后一次成功处理的 `upstream/main` 提交；
- `updatedAt`：状态更新时间；
- `schemaVersion`：状态结构版本。

首次正式执行时，如果没有状态文件，脚本把当前 `upstream/main` 作为基线并退出，不发送 118 期历史
内容。安装流程另行执行一次 `--test-webhook`，发送明确标注为“自动推送链路测试”的消息；测试不改变增量
状态。

常规执行流程：

1. fetch 上游并解析新旧提交；
2. 使用 `git diff --name-status` 找出 `docs/[0-9]+.md` 的新增、修改和删除；
3. 新增文件按“新一期”处理；修改文件按“内容更新”处理；删除文件只报告期数和删除事实；
4. 使用 `git show <commit>:<path>` 直接读取两个提交中的内容，不改变工作树；
5. 对修改文件按二级标题切分条目，比较规范化后的条目文本，只推送新增或有变化的条目；
6. 若最后成功提交已不再是上游祖先，视为上游改写历史并安全失败，不猜测增量，也不推进状态。

README 的目录更新不单独推送，避免与对应周刊文件重复。非数字 Markdown、站点配置和构建文件不进入
消息。

## 内容解析与消息格式

周刊标题从一级标题读取，条目以 `##` 二级标题为边界。每个条目提取：

- 条目标题；
- 第一段有效说明，压缩空白并限制长度；
- 条目中的最后一个 HTTP(S) 链接，通常为项目主页；
- 所属期数及日期范围。

单期消息示例：

```text
【每周科技补全 · 新一期】第 119 期（日期范围）

1. 项目名称
   简介……
   https://example.com

来源：https://github.com/xuanli199/weekly/blob/main/docs/119.md
```

一次运行发现多期或大量条目时，按 Rocket.Chat 消息长度预算分成多条，并加上 `1/N` 序号。拆分只发生
在条目边界，不截断链接。消息采用普通 `text` 载荷，避免依赖特定 Rocket.Chat 客户端的附件渲染。

## Rocket.Chat 接入与密钥

使用已经绑定 `#general` 的 Incoming Webhook。Webhook URL 只通过环境变量
`ROCKETCHAT_WEBHOOK_URL` 注入，绝不写进仓库、日志、状态文件、进度记录或命令行参数。

请求使用 HTTPS、JSON `POST` 和有限超时。程序只记录 HTTP 状态、Rocket.Chat 返回的非敏感错误摘要及
本次处理的提交范围，不记录完整请求 URL。Webhook 返回非 2xx、网络超时或返回体表示失败时，本次执行
失败且不推进状态。

由于 Webhook 曾经通过聊天传递，部署验证完成后应在 Rocket.Chat 中重新生成一次 token，并只更新
`/etc/weekly-rocketchat.env`。

## 失败处理与可观测性

- git、解析或网络阶段任一失败，进程以非零状态退出，交由 systemd journal 留存结果；
- 不推进状态意味着下一次定时运行会重试同一批增量；
- 为避免“消息已送达但响应丢失”造成的极小概率重复，消息中加入稳定的提交短 SHA；重复消息可以识别，
  但不依赖读取 Rocket.Chat 历史来去重；
- 单个文档格式异常不会发送残缺内容，整次任务失败并等待修复；
- 设置连接和整体请求超时，任务不会无限挂起。

## 测试与验收

自动测试覆盖：

- 新文档、修改文档、删除文档的差异分类；
- Markdown 标题、条目、简介和链接提取；
- README 和非周刊文件被忽略；
- 首次基线不发送历史内容；
- 多条消息分片；
- Webhook 成功才更新状态，失败保持原状态；
- 上游历史改写时安全失败；
- 日志不会泄漏 Webhook URL。

部署验收顺序：

1. 在临时目录和模拟 Webhook 上运行自动测试；
2. 安装 env、service 和 timer，检查文件权限及 systemd 配置；
3. 运行 `--test-webhook`，确认 `#general` 收到一条测试消息；
4. 建立当前上游提交基线；
5. 用本地构造的提交差异做 dry-run，核对消息内容但不向正式频道发送；
6. 确认 timer 的下一次触发时间是北京时间 09:00。

## 明确不做

- 不抓取 Bilibili、飞书或互联网新闻来生成每日内容；
- 不自动同步、合并或推送 fork；
- 不在无更新时发送“今日无更新”；
- 不读取 Rocket.Chat 消息历史；
- 不提供 Web 管理界面或数据库。
