# Claude MCP

在 OpenCode V2 中使用 Claude 格式的 MCP 配置。

## 安装

运行以下命令，从 GitHub 安装到全局 OpenCode 配置。

```sh
opencode plugin add 'github:45degree/opencode-plugins#main::path:claude-mcp'
```

## 配置

默认读取项目目录下的 `.mcp.json`。要额外读取 `~/.config/mcp/mcp.json`，在 `opencode.json` 的 `plugins` 中配置：

```json
{
  "plugins": [
    {
      "package": "github:45degree/opencode-plugins#main::path:claude-mcp",
      "options": {
        "globalDirectories": ["~/.config/mcp"]
      }
    }
  ]
}
```

只加载可信的 MCP 配置。
