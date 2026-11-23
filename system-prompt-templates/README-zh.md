# System Prompt Templates for OpenCode

让 OpenCode V2 的系统提示词按模型、服务商或代理切换内容。

## 安装

在可信项目的 `opencode.json` 中添加 GitHub 插件地址：

```json
{
  "plugins": ["github:45degree/opencode-plugins#main::path:system-prompt-templates"]
}
```

## 配置

插件没有配置项。直接在系统提示词中写 Nunjucks 条件，例如：

```markdown
<!-- {% if model == "gpt-5" %} -->
先给结论。
<!-- {% endif %} -->
```
