# Rocket.Chat Daily Incremental Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每天北京时间 09:00 检查 `xuanli199/weekly` 的上游增量，并仅在周刊内容新增、修改或删除时可靠地推送摘要到 Rocket.Chat `#general`。

**Architecture:** 仓库内提供无第三方运行依赖的 Node.js CLI；纯函数模块负责 Markdown 解析、差异分类和消息分片，CLI 模块负责 Git、状态文件和 Webhook I/O。systemd oneshot service + timer 调度任务，密钥与状态保存在仓库外，成功发送后才原子推进提交游标。

**Tech Stack:** Node.js ESM、Node 内置 `node:test`、Git CLI、Rocket.Chat Incoming Webhook、systemd

**Spec:** `docs/superpowers/specs/2026-09-22-rocketchat-daily-push-design.md`

## Global Constraints

- 每天北京时间 09:00 检查；无周刊变化时静默。
- 只执行 `git fetch upstream main` 和只读 Git 查询，不 checkout、merge、rebase 或 push。
- 首次运行只建立当前 `upstream/main` 基线，不补发历史内容。
- 只有 Webhook 明确成功后才推进状态；失败必须保留原游标供下次重试。
- Webhook URL 仅来自 `ROCKETCHAT_WEBHOOK_URL`，不得出现在仓库、状态、日志或命令行参数中。
- 运行状态固定为 `/var/lib/weekly-rocketchat/state.json`，私密配置固定为 `/etc/weekly-rocketchat.env` 且权限 `0600`。
- README、非数字 Markdown 及站点构建文件不产生频道消息。
- 不增加运行时 npm 依赖，不实现网络新闻抓取、fork 自动合并、Rocket.Chat 历史读取或管理界面。

## Review Focus

- 文档含 CRLF、额外空行或中文/英文标题时，解析结果应稳定且不产生空条目；Task 1 覆盖。
- 修改后的文档删除原有条目时，应把删除事实表现出来，不能被误判为“无变化”；Task 1 覆盖。
- `lastSuccessfulCommit` 存在但不是当前上游祖先时，应失败且不写状态；Task 2 覆盖。
- Webhook 返回 HTTP 2xx 但 JSON 明确 `{success:false}` 时，应视为失败且不写状态；Task 3 覆盖。
- 消息刚送达但本机在写状态前中断时，下次可能重复；每条消息必须携带稳定短 SHA 以便识别；Task 1 和 Task 3 覆盖。

---

## File Structure

- `scripts/weekly-rocketchat-lib.mjs`：纯函数；解析周刊、比较条目、构建和分片消息。
- `scripts/weekly-rocketchat.mjs`：CLI 与副作用边界；Git 查询、状态读写、HTTP 请求、命令模式。
- `scripts/weekly-rocketchat.test.mjs`：使用临时 Git 仓库和本地 HTTP server 的全量自动测试。
- `deploy/weekly-rocketchat.service`：oneshot service 模板。
- `deploy/weekly-rocketchat.timer`：北京时间每日调度模板。
- `README.md`：运行模式、安装、轮换 Webhook、诊断与卸载说明。
- `progress.md`：每个可验证阶段后的交接状态。

### Task 1: Markdown 增量模型与消息生成

**Files:**
- Create: `scripts/weekly-rocketchat-lib.mjs`
- Create: `scripts/weekly-rocketchat.test.mjs`
- Modify: `package.json`
- Modify: `progress.md`

**Interfaces:**
- Consumes: UTF-8 Markdown 字符串、Git name-status 结果、旧/新文档映射。
- Produces: `parseWeekly(markdown, path)`, `classifyChangedPaths(nameStatus)`, `diffWeekly(oldDoc, newDoc)`, `buildMessages(changes, options)`。

- [ ] **Step 1: 为解析和差异分类写失败测试**

在 `scripts/weekly-rocketchat.test.mjs` 使用 `node:test` 写表驱动测试，至少固定以下输入输出：

```js
test('parseWeekly handles CRLF and extracts the last URL', () => {
  const doc = '# 【119】2026年9月6日-2026年9月12日\r\n\r\n## 1.Tool A\r\n\r\n第一段简介。\r\n\r\nhttps://example.com/a\r\n';
  assert.deepEqual(parseWeekly(doc, 'docs/119.md'), {
    issue: '119',
    title: '【119】2026年9月6日-2026年9月12日',
    sourcePath: 'docs/119.md',
    entries: [{ key: '1.Tool A', title: '1.Tool A', summary: '第一段简介。', url: 'https://example.com/a', body: '第一段简介。\n\nhttps://example.com/a' }],
  });
});

test('classifyChangedPaths ignores README and non-numbered docs', () => {
  assert.deepEqual(classifyChangedPaths('M\tREADME.md\nA\tdocs/119.md\nM\tdocs/about.md\n'), [
    { status: 'A', path: 'docs/119.md', oldPath: null },
  ]);
});

test('diffWeekly reports changed, added, and removed entries', () => {
  const changes = diffWeekly(oldWeekly, newWeekly);
  assert.deepEqual(changes.map(({ kind, title }) => ({ kind, title })), [
    { kind: 'changed', title: '1.Tool A' },
    { kind: 'removed', title: '2.Tool B' },
    { kind: 'added', title: '3.Tool C' },
  ]);
});
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `node --test scripts/weekly-rocketchat.test.mjs`

Expected: FAIL，报模块不存在或导出函数不存在。

- [ ] **Step 3: 实现最小纯函数模块**

`scripts/weekly-rocketchat-lib.mjs` 导出以下稳定接口：

```js
export function parseWeekly(markdown, sourcePath) {}
export function classifyChangedPaths(nameStatusText) {}
export function diffWeekly(oldWeekly, newWeekly) {}
export function buildMessages(changes, { commit, repositoryUrl, maxLength = 6000 }) {}
```

具体规则：统一 CRLF；一级标题必须存在且文件名必须匹配 `docs/(\d+)\.md`；按 `##` 切条目；跳过空白；简介取第一个非空、非 URL 段落并压缩空白；URL 取条目最后一个 HTTP(S) URL；条目 key 使用规范化标题。解析异常抛出包含路径但不含文档全文的错误。

- [ ] **Step 4: 为消息分片和 SHA 标记写失败测试**

```js
test('buildMessages splits only between entries and marks every part with the commit', () => {
  const messages = buildMessages(manyChanges, {
    commit: '1234567890abcdef',
    repositoryUrl: 'https://github.com/xuanli199/weekly',
    maxLength: 420,
  });
  assert.ok(messages.length > 1);
  assert.ok(messages.every((message, index) => message.includes(`${index + 1}/${messages.length}`)));
  assert.ok(messages.every((message) => message.includes('1234567')));
  assert.ok(messages.every((message) => message.length <= 420));
  assert.ok(messages.every((message) => !message.endsWith('https://')));
});
```

- [ ] **Step 5: 实现消息格式与安全分片并跑绿灯**

Run: `node --test scripts/weekly-rocketchat.test.mjs`

Expected: PASS；新增、修改、删除分别显示“新一期”“内容更新”“内容删除”，每部分带短 SHA 和源文件链接，任何单条超过预算时以明确的省略说明缩短简介但保留标题与链接。

- [ ] **Step 6: 添加测试脚本并提交**

在 `package.json` 增加：

```json
"test:rocketchat": "node --test scripts/weekly-rocketchat.test.mjs"
```

更新 `progress.md` 后运行：

```bash
pnpm test:rocketchat
git diff --check
git add package.json scripts/weekly-rocketchat-lib.mjs scripts/weekly-rocketchat.test.mjs progress.md
git commit -m "feat: parse weekly content for Rocket.Chat"
```

### Task 2: Git 游标与原子状态机

**Files:**
- Create: `scripts/weekly-rocketchat.mjs`
- Modify: `scripts/weekly-rocketchat.test.mjs`
- Modify: `progress.md`

**Interfaces:**
- Consumes: Task 1 的四个导出；`git` 可执行文件；`--repo`, `--state-file`, `--dry-run`, `--init-baseline` 参数。
- Produces: `runGit(args, options)`, `readState(path)`, `writeStateAtomic(path, state)`, `collectChanges(options)`, `main(argv, deps)`。

- [ ] **Step 1: 写临时 Git 仓库集成测试**

测试 helper 在 `os.tmpdir()` 下创建 bare upstream 和工作仓库，提交 `docs/118.md` 后验证：

```js
test('first normal run creates a baseline without messages', async () => {
  const result = await main(['--repo', repo, '--state-file', stateFile], fakeDeps);
  assert.equal(result.mode, 'baseline-created');
  assert.deepEqual(fakeDeps.sent, []);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).lastSuccessfulCommit, head);
});

test('a non-ancestor cursor fails without replacing state', async () => {
  await writeFile(stateFile, JSON.stringify({ schemaVersion: 1, lastSuccessfulCommit: orphan }));
  await assert.rejects(() => main(args, fakeDeps), /not an ancestor/);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).lastSuccessfulCommit, orphan);
});
```

同时覆盖：新增一期、修改一期、删除一期、只有 README 变化、状态 JSON 损坏、Git 命令失败、路径含重命名状态。

- [ ] **Step 2: 运行聚焦测试确认红灯**

Run: `node --test --test-name-pattern='baseline|ancestor|README|state' scripts/weekly-rocketchat.test.mjs`

Expected: FAIL，CLI 导出尚不存在。

- [ ] **Step 3: 实现 Git 与状态边界**

实现要求：

```js
export async function runGit(args, { cwd, spawn = defaultSpawn } = {}) {}
export async function readState(path) {}
export async function writeStateAtomic(path, state) {}
export async function collectChanges({ repo, fromCommit, toCommit = 'upstream/main', git = runGit }) {}
export async function main(argv = process.argv.slice(2), deps = productionDeps) {}
```

`writeStateAtomic` 在状态目录创建同文件系统临时文件，写入、`chmod 0600` 后 rename；任何异常清理临时文件。`collectChanges` 先执行 `merge-base --is-ancestor`，再读取 `diff --name-status` 与 `git show`。所有 Git 参数用 `spawn` 参数数组传递，不拼 shell 字符串。

- [ ] **Step 4: 实现模式和退出语义**

- 默认：fetch → 无状态则建基线 → 有状态则收集增量 → 返回待发送消息；
- `--init-baseline`：明确重置到当前上游提交但不得发送；
- `--dry-run`：打印脱敏后的消息但绝不调用 Webhook、绝不更新状态；
- 未知参数、缺少仓库或损坏状态：stderr 给出可操作错误并非零退出；
- 日志只显示上游 SHA、文件数、消息数，不打印环境变量或请求 URL。

- [ ] **Step 5: 运行测试并提交**

```bash
pnpm test:rocketchat
git diff --check
git add scripts/weekly-rocketchat.mjs scripts/weekly-rocketchat.test.mjs progress.md
git commit -m "feat: track upstream weekly changes safely"
```

Expected: 全部 PASS；测试结束后临时仓库被清理。

### Task 3: Webhook 传输与成功后提交游标

**Files:**
- Modify: `scripts/weekly-rocketchat.mjs`
- Modify: `scripts/weekly-rocketchat.test.mjs`
- Modify: `progress.md`

**Interfaces:**
- Consumes: `ROCKETCHAT_WEBHOOK_URL`、Task 2 产生的消息与目标提交。
- Produces: `postWebhook(url, text, options)`, `sendMessages(messages, options)`；CLI 新增 `--test-webhook`。

- [ ] **Step 1: 写本地 HTTP server 失败测试**

测试只把随机本地 URL 传给函数，不使用真实 Webhook：

```js
test('HTTP 200 with success false is rejected and state is unchanged', async () => {
  server.respond(200, { success: false, error: 'rejected' });
  await assert.rejects(() => main(args, deps), /rejected/);
  assert.equal((await readState(stateFile)).lastSuccessfulCommit, oldHead);
});

test('state advances only after every message succeeds', async () => {
  server.respondSequence([{ status: 200, body: { success: true } }, { status: 503, body: {} }]);
  await assert.rejects(() => main(args, deps), /503/);
  assert.equal((await readState(stateFile)).lastSuccessfulCommit, oldHead);
});
```

额外覆盖超时/AbortError、非 JSON 2xx 响应、日志脱敏、`--test-webhook` 不读写状态，以及消息 payload 只有 `text`。

- [ ] **Step 2: 运行测试确认红灯**

Run: `node --test --test-name-pattern='Webhook|HTTP|state advances|timeout|test-webhook' scripts/weekly-rocketchat.test.mjs`

Expected: FAIL，传输函数和测试模式尚不存在。

- [ ] **Step 3: 实现带超时的 Webhook POST**

```js
export async function postWebhook(url, text, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {}
export async function sendMessages(messages, options = {}) {}
```

使用 `AbortSignal.timeout(timeoutMs)`；发送 `{ text }`；要求 `response.ok`，并在返回 JSON 含 `success` 时要求其不为 `false`。错误只包含状态码和经过长度限制的响应错误字段，不能包含 URL。

- [ ] **Step 4: 把状态提交放在全部发送成功之后**

默认模式严格按以下顺序：构建全部消息 → 逐条发送 → 全部成功 → 原子写入目标 SHA。`--test-webhook` 发送固定文案“每周科技补全自动推送链路测试”，包含当前时间但不包含密钥，并跳过 fetch 和状态文件。

- [ ] **Step 5: 全量验证并提交**

```bash
pnpm test:rocketchat
git diff --check
git add scripts/weekly-rocketchat.mjs scripts/weekly-rocketchat.test.mjs progress.md
git commit -m "feat: deliver weekly updates to Rocket.Chat"
```

Expected: 全部 PASS；测试输出中不存在 `/hooks/` 或测试 token。

### Task 4: systemd 打包与操作文档

**Files:**
- Create: `deploy/weekly-rocketchat.service`
- Create: `deploy/weekly-rocketchat.timer`
- Modify: `README.md`
- Modify: `progress.md`

**Interfaces:**
- Consumes: 仓库绝对路径、`/etc/weekly-rocketchat.env`、`/var/lib/weekly-rocketchat/state.json`。
- Produces: 可由 systemd 直接校验和启用的 oneshot service/timer。

- [ ] **Step 1: 添加静态契约测试并确认红灯**

在现有测试中读取 unit 文件，断言：

```js
assert.match(service, /Type=oneshot/);
assert.match(service, /EnvironmentFile=\/etc\/weekly-rocketchat\.env/);
assert.match(service, /--state-file \/var\/lib\/weekly-rocketchat\/state\.json/);
assert.match(service, /NoNewPrivileges=true/);
assert.match(timer, /OnCalendar=Asia\/Shanghai \*-\*-\* 09:00:00/);
assert.match(timer, /Persistent=true/);
```

Run: `pnpm test:rocketchat`

Expected: FAIL，unit 文件尚不存在。

- [ ] **Step 2: 创建 service 和 timer**

service 使用专用系统用户 `weekly-rocketchat`、固定 `WorkingDirectory=/IQAir-Project/deliverables/xuanli199-weekly`、Node 绝对路径（部署时以 `command -v node` 核实）、`UMask=0077`、`NoNewPrivileges=true`、`PrivateTmp=true`、`ProtectSystem=strict`，并只开放状态目录写权限。Git 仓库需要由该用户可读，且 `.git/FETCH_HEAD` 和远端引用需要可写，因此用 `ReadWritePaths` 仅开放该仓库 `.git` 与状态目录。

- [ ] **Step 3: 补充 README 运维说明**

写明：功能边界、北京时间调度、创建专用用户、env 文件格式（只使用占位示例）、权限、安装 unit、daemon-reload、初始化基线、Webhook 测试、启用 timer、查看日志、dry-run、轮换 token 和完整卸载命令。所有示例不得出现真实 Webhook。

- [ ] **Step 4: 静态验证并提交**

```bash
pnpm test:rocketchat
systemd-analyze verify deploy/weekly-rocketchat.service deploy/weekly-rocketchat.timer
git diff --check
git add deploy README.md scripts/weekly-rocketchat.test.mjs progress.md
git commit -m "docs: package weekly push as a systemd timer"
```

Expected: Node 测试全通过；systemd verify 无 error。

### Task 5: 本机部署与端到端验收

**Files:**
- Modify: `/etc/weekly-rocketchat.env`（不进 Git，权限 `0600`）
- Create: `/var/lib/weekly-rocketchat/`（不进 Git，专用用户拥有）
- Install: `/etc/systemd/system/weekly-rocketchat.service`
- Install: `/etc/systemd/system/weekly-rocketchat.timer`
- Modify: `progress.md`

**Interfaces:**
- Consumes: Task 4 的已验证 unit、用户提供的 Webhook、当前 `upstream/main`。
- Produces: 已启用的每日 timer、已建立的当前基线、`#general` 中一条测试消息。

- [ ] **Step 1: 部署前完整验证**

```bash
pnpm install --frozen-lockfile
pnpm test:rocketchat
pnpm build
git diff --check
git status --short --branch
```

Expected: 测试和 VitePress 构建通过；只有预期的 `progress.md` 阶段更新可未提交。

- [ ] **Step 2: 安装最小权限运行环境**

创建无登录 shell 的 `weekly-rocketchat` 系统用户和状态目录；通过不回显输入的方式把 Webhook 写入 `/etc/weekly-rocketchat.env`，设置 root 所有、`0600`。复制 unit 文件后运行 `systemd-analyze verify` 和 `systemctl daemon-reload`。任何诊断输出不得打印 env 内容。

- [ ] **Step 3: 发送一条正式测试消息**

Run: `systemctl start weekly-rocketchat.service` 前先使用 unit 等价环境执行 CLI `--test-webhook`。

Expected: 命令成功；`#general` 只出现一条明确标注的链路测试消息；journal 不含 `/hooks/`。

- [ ] **Step 4: 建立基线并验证 dry-run**

以专用用户运行 `--init-baseline`，确认状态文件权限和 SHA 等于 `upstream/main`。随后针对测试临时仓库运行 `--dry-run`，确认产生预期新一期摘要且正式频道没有第二条消息。

- [ ] **Step 5: 启用并检查 timer**

```bash
systemctl enable --now weekly-rocketchat.timer
systemctl is-active weekly-rocketchat.timer
systemctl list-timers weekly-rocketchat.timer --all
```

Expected: timer 为 active；下一次触发对应北京时间次日 09:00。

- [ ] **Step 6: 轮换已在聊天中出现过的 Webhook token**

在 Rocket.Chat 管理界面重新生成 Incoming Webhook token，将新 URL 通过同样的不回显方式替换 env 文件，再运行一次 `--test-webhook`。旧 URL 应返回失败，新 URL 成功。若 Rocket.Chat 版本不支持原地轮换，则新建同配置 integration、验证后删除旧 integration。

- [ ] **Step 7: 最终状态记录与提交**

更新 `progress.md`，记录 service/timer 状态、下一次触发时间、测试摘要和 token 已轮换（绝不记录 URL）。然后：

```bash
git add progress.md
git commit -m "docs: record weekly push deployment"
git status --short --branch
```

Expected: 工作树干净；Webhook 密钥未被 Git 跟踪；`git grep -n '/hooks/'` 只允许测试中的虚构值或文档对路径形态的泛化说明，不得匹配真实 integration ID 或 token。

## Final Verification

- [ ] `pnpm test:rocketchat` 全部通过。
- [ ] `pnpm build` 通过，原 VitePress 站点未回归。
- [ ] `systemd-analyze verify` 无 error。
- [ ] `systemctl is-active weekly-rocketchat.timer` 返回 `active`。
- [ ] 状态文件 SHA 等于当前 `upstream/main`，权限不宽于 `0600`。
- [ ] journal 和 Git 历史中不存在真实 Webhook URL。
- [ ] `#general` 收到且只收到预期的测试消息，日常无更新时保持静默。
