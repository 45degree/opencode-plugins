# New API Provider

在 OpenCode V2 中接入多个 New API 实例。每个分组使用独立的 API Key。

## 安装

在 `opencode.json` 的 `plugins` 数组中添加下面的插件项。

## 配置

```json
{
  "plugins": [
    {
      "package": "github:45degree/opencode-plugins#main::path:newapi-provider",
      "options": {
        "cache": true,
        "providers": [
          {
            "base_url": "https://www.packyapi.ai",
            "groups": [{ "id": "packy-work", "name": "Packy Work" }]
          }
        ]
      }
    }
  ]
}
```

- `providers`：每个实例填写 `base_url` 和至少一个分组。地址支持代理路径前缀，例如 `https://newapi.example.com/proxy`。分组 `id` 在整份配置中唯一。
- `cache`：默认 `true`。有有效缓存就先显示旧列表，后台更新供下次启动使用；否则在线获取。`false` 时每次启动都在线获取，不读写缓存。

在 OpenCode 中用 `/connect` 为各分组配置 API Key。
