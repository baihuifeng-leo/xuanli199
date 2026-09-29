# 当前进度记录

- 更新时间：2026-09-29
- 更新者：Claude Code
- 当前目标：每天北京时间 09:00（11:00 补推）往 Rocket.Chat `#general` 推送：① 今日热点新闻（每天）；② 玄离周刊有更新就推玄离，无更新就推 GitHub 今日热点。
- 已确认要求：消息排版要美观（用 Rocket.Chat attachments 卡片）；科技热点标出星标数；热点只在玄离无更新时推；简介经中转站 `https://www.cun.ai/v1`（OpenAI 兼容）用 `deepseek-v4-flash` 翻译；新闻源用 vikiboss/60s（MIT），读的是它在 GitHub 上的静态数据仓库 `60s-static-host`（公开 API 被 Cloudflare 拦了这台 IP）。
- 已完成（2026-09-29）：
  - `scripts/daily-news.mjs` 新闻卡片（15 条 + 微语），状态文件 `/var/lib/weekly-rocketchat/news-state.json`，每天推一次；数据未发布时静默，等 11:00 补推。
  - `scripts/github-trending.mjs` 改成卡片，每个项目显示「⭐ 星标 · 语言」（走 GitHub API）；状态里加了 `lastPushedDate`，每天只推一次。
  - 主脚本先推新闻，再跑周刊和热点；新闻失败不阻塞周刊，最后以非零退出码暴露。timer 增加 11:00；unit 已安装、daemon-reload 并重启 timer。
  - 43 项测试通过；dry-run 渲染正常。
  - 意外情况：重启 timer 时 Persistent 补跑了一次，真实推送了当天的新闻卡片（09:36 UTC）。热点因为没有新项目，没有推送。
  - 代码：前一轮已提交 `0ed19c0`，经 PR #1 合并到 main；本轮已提交并推到 main。
- 通知 debug 结论：Rocket.Chat 在 192.168.2.5（docker `rocketchat-rocketchat-1`，API 端口 3010，版本 8.7）。两个 incoming webhook（`xuanli199` 推 #general、`BOT-EC Daily Report` 推 #DailyReport）都以 **Leo.Bai 本人帐号** 发送，而 Rocket.Chat 不会把自己发的消息通知给自己，这就是 PC 和手机都没有通知的原因。Push gateway、默认通知偏好（all）、房间人数上限（100 > 8）都正常。集成配置已备份到 192.168.2.5:`/root/rc-backup/integrations-20260929.json`。
- 通知已修复：用户在后台新建了 `daily.bot`（bot 角色），两个 webhook 都改成以它发布；2026-09-29 发了测试消息，发送者是 daily.bot，用户确认 PC 和手机都收到通知。
- 下一步：无。每天 09:00 推新闻 + 玄离/热点（11:00 补推）。待办：轮换 Webhook 与中转站 API key（都曾出现在聊天里）。

## 历史

暂无。
