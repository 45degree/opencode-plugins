# Claude MCP 配置

插件在加载时读取 Claude 格式的 MCP 配置，并通过 OpenCode V2 的 `ctx.mcp.transform` 注册服务：项目目录读取 `.mcp.json`，全局目录读取 `mcp.json`。插件不改写配置文件，也不监视文件变化。修改后需重新加载插件。

## 手动加载

```json
{
  "plugins": [
    {
      "package": "./plugins/claude-mcp",
      "options": {
        "readProject": true,
        "globalDirectories": ["~/.config/mcp", "~/shared-mcp"]
      }
    }
  ]
}
```

`package` 指向包根，加载构建产物 `dist/index.js`。仓库已包含该产物，直接使用无需安装或构建。

`readProject` 默认 `true`，读取 `ctx.location.directory/.mcp.json`，不搜索父目录。`globalDirectories` 默认空数组；每个目录读取其中的 `mcp.json`。目录支持绝对路径、`~` 和 `~/...`；相对路径以 `ctx.location.directory` 为基准。全局目录按数组顺序合并，后面的同名服务覆盖前面；项目服务覆盖全局服务。OpenCode 原有服务（包括已禁用服务）优先，不会被插件覆盖。覆盖按整个服务对象进行。

配置文件顶层必须包含对象 `mcpServers`。stdio 服务支持可选 `type: "stdio"`、必需 `command`、可选 `args` 和 `env`；`env` 映射到 OpenCode 的 `environment`，command 与 args 合为命令数组，工作目录固定为 `ctx.location.directory`。省略 `type` 时按 stdio 处理。HTTP 服务使用 `type: "http"` 或 `type: "streamable-http"`、必需 `url` 和可选 `headers`。展开变量后，URL 必须是带主机名的绝对 HTTP 或 HTTPS URL。SSE、WebSocket 和其他传输类型会警告并跳过。

插件展开 `command`、`args`、`env`、`url` 和 `headers` 中的 `${VAR}` 与 `${VAR:-default}`。已设置但为空的变量展开为空字符串。未设置且无默认值时记录警告并保留占位符；不会在展开后的环境变量上再次展开。其他 Claude 专用扩展不处理。

文件不存在时跳过。文件读取失败、JSON 错误、`mcpServers` 格式错误或单个服务无效时记录警告；无效服务不影响其他服务。警告使用 `[claude-mcp]` 前缀，只包含配置路径、服务名和固定原因，不包含配置内容、命令、URL、请求头、环境变量名或环境变量值。选项类型错误会使插件加载失败并给出明确错误；显式传入 `null` 不会使用默认值。

加载项目 MCP 命令会允许 OpenCode 启动并连接这些进程。只从可信项目加载 `.mcp.json`；其中的命令会以当前用户权限执行。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm run build:dist
pnpm run typecheck
pnpm test
```

`pnpm run build:dist` 直接调用 esbuild，把 `src/entry.ts` 打包为压缩的 `dist/index.js`，不需要自定义构建脚本。修改源码后，将源码与重新生成的产物一起提交。`entry/index.ts` 保留为原加载路径的转发入口，指向同一实现。
