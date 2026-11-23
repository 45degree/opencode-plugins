# 工单跟踪：本地 Markdown

## 文件约定

- 每个功能使用一个目录：`.scratch/<feature-slug>/`。
- 规格写入 `spec.md`。每张实施工单单独写入 `issues/<NN>-<slug>.md`，从 `01` 开始编号。
- 在规格或工单顶部附近用 `**Status:**` 记录状态。分诊状态见 `triage-labels.md`；实施完成后设为 `closed`。
- 将评论和讨论记录追加到文件底部的 `## Comments` 小节。

## 发布和查找

- 按文件约定发布，目录不存在时创建。
- 按给定路径读取工单。只提供编号时，在对应功能目录内查找；无法唯一确定就询问。

## Wayfinder

- 地图写入 `.scratch/<effort>/map.md`，记录笔记、已有决定和待查问题。
- 子工单写入同目录下的 `issues/<NN>-<slug>.md`，从 `01` 开始编号，正文写明待解决的问题。
- 用 `Type:` 区分 `research`、`prototype`、`grilling`、`task`。用 `Blocked by: NN, NN` 记录依赖编号；依赖全部为 `resolved` 后才能领取。
- 按编号领取第一张未领取、未解决且无阻塞的工单。先保存 `Status: claimed`，再开始工作。
- 解决后，在 `## Answer` 追加答案，将 `Status:` 设为 `resolved`，再把结论摘要和工单链接追加到地图的已有决定小节。
