# PackyAPI

将 PackyAPI 模型接入 OpenCode V2。每把 API key 可对应一个独立的模型服务商。

## 安装

按下方示例将 GitHub 插件地址和选项一起加入 `opencode.json`。

## 配置

为每把 API key 添加一个条目，填写唯一的 `id` 和显示名称 `name`。

```json
{
  "plugins": [
    {
      "package": "github:45degree/opencode-plugins#main::path:packyapi",
      "options": {
        "providers": [{ "id": "packy-work", "name": "Packy Work" }]
      }
    }
  ]
}
```

在 OpenCode 中运行 `/connect`，选择对应服务商并输入 API key。自定义网关可通过 `options.baseURL` 设置。
