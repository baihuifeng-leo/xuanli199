# 当前进度记录

- 更新时间：2026-09-29
- 更新者：Claude Code
- 当前目标：每天北京时间 09:00 检查 `xuanli199/weekly`。有更新就推玄离；**无更新时改推「GitHub 今日热点」补位**，推到 Rocket.Chat `#general`。
- 背景：用户反馈「收不到每日推送」。排查结果是服务正常，上游自 2026-09-11 起没有新提交，按设计静默不推。
- 已确认要求：只在玄离无更新时推热点；项目简介翻译成中文；翻译走中转站 `https://www.cun.ai/v1`（OpenAI 兼容），模型 `deepseek-v4-flash`。
- 实现：新增 `scripts/github-trending.mjs`，数据源是 aneasystone/github-trending README 的「All language」段落（首次上榜项目 + 日期）。取近 3 天、尚未推过的项目，最多 10 条，合成 1 条消息；全部推过就静默。已推 URL 记在 `/var/lib/weekly-rocketchat/trending-state.json`，只保留最近 1000 条。翻译失败时退回英文，推送失败时不写状态。主脚本新增 `--trending-state-file` 参数，不传就不启用补位；玄离的状态先落盘，补位失败只影响退出码。
- 部署：AI 配置（`AI_API_*`、`AI_MODEL`）已追加到 `/etc/weekly-rocketchat.env`（root 600，不进仓库）；新的 service unit 已复制到 `/etc/systemd/system`，并已 daemon-reload。
- 验证：36 项测试通过（原 25 项 + 新 11 项）。以服务用户身份做了真实 dry-run，抓取、翻译、成稿均正常，dry-run 不写状态。
- 未完成：还没有真实推送过，首次真实推送在下一次定时触发时（北京时间 2026-09-30 09:00）；改动未提交 git（分支 `feature/rocketchat-daily-push`）。安全待办：Webhook 和中转站 API key 都在聊天里出现过，建议轮换，轮换后更新 env 文件即可。
- 下一步：用户确认明早推送效果；需要时提交并推送到现有 PR。

## 历史

暂无。
