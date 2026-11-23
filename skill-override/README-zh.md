# Skill Override

调整 OpenCode V2 技能的描述和自动调用设置，无需修改 `SKILL.md`。

## 安装

运行以下命令，从 GitHub 安装到全局 OpenCode 配置。

```sh
opencode plugin add 'github:45degree/opencode-plugins#main::path:skill-override'
```

## 配置

在 `~/.config/opencode/skill-override.json` 写全局设置，或在项目内的 `.opencode/skill-override.json` 写项目设置。用技能名作为键：

```json
{
  "commit": {
    "description": "按仓库规范编写提交信息",
    "autoinvoke": false
  }
}
```
