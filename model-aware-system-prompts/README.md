# model-aware-system-prompts

OpenCode V2 服务端插件。每次模型请求发出前，用 Nunjucks 渲染系统提示词的各个文本段，模板按本次请求的 provider、模型和 agent 选择指令。

包内自带 `dist/index.js`，构建后自包含（含模板引擎），不依赖包外的运行时模块。

## 行为

- 加载即注册 `context`、`title`、`compaction`、`generate` 四个 session hook，没有单独的启用开关。`context` 覆盖工具调用后的续跑。
- 只修改 hook 事件里的 `event.system`。逐个处理文本段，保留顺序、段边界、元数据和非文本段；消息、工具定义、请求选项、提示词源文件都不动。
- 不区分内容来源。只要进到 `event.system` 的文本段，都会交给模板引擎。

## 模板语法

块分隔符是 `<!-- {%` 和 `%} -->`，条件标签可以写进 HTML 注释，Markdown 预览里不显形。其余语法全部是原生 Nunjucks，本插件没有自定义解析器。

```markdown
通用指令。
<!-- {% if model == "gpt-example" %} -->
先给结论。
<!-- {% else %} -->
备用指令。
<!-- {% endif %} -->
```

模板上下文按请求构造：

| 变量 | 含义 |
| --- | --- |
| `provider` | 本次请求的 provider ID |
| `model` | 本次请求的模型 ID |
| `agent` | 本次请求的 agent ID；请求没有 agent 时为 `null`（例如标题生成） |

`matches(value, pattern, flags?)` 用 JavaScript `RegExp` 语义返回布尔值，每次调用都新建正则对象，匹配状态不会带到下一个请求。

```markdown
<!-- {% if matches(model, "^gpt", "i") %} -->
GPT 系列指令。
<!-- {% endif %} -->
```

## 失败时的表现

单个文本段渲染失败（模板语法错误、无效的正则模式或 flags）时，该段保留原文，其余段继续渲染。诊断只输出请求类型、段号和可用的行号，不含提示词或模板正文，形如：

```
[model-aware-system-prompts] render failed kind=context segment=0 line=2
```

## 在受信任的项目里加载

OpenCode 会从全局 `plugins/` 目录发现本包。仓库的全局配置默认禁用它。要在一个你完全信任的项目里启用，在该项目的 `opencode.json` 中按插件 ID 重新启用：

```jsonc
{
  "plugins": ["model-aware-system-prompts"]
}
```

如果本包不在 OpenCode 的自动发现路径中，请在可信项目里将其目录路径加入 `plugins`。插件加载即生效，没有按会话关闭的手段。`dist/THIRD-PARTY-LICENSES` 保存打包依赖的许可声明。

## 信任边界

Nunjucks 官方不提供沙箱。本插件不限制模板语法，也不区分内容来源：进入系统提示词的文本段全部交给引擎渲染，模板可以使用引擎支持的全部表达式和全局函数，本插件对其中可用的能力不做裁剪。安装并加载这个插件，等于信任所有可能进入系统提示词的模板来源。不要在包含不可信内容的工作区加载。

## 本地开发

```sh
pnpm install        # 生成独立 lockfile（pnpm v10）
pnpm test           # node --test，入口是插件公开的 setup 与 session hook
pnpm typecheck      # tsc --noEmit
pnpm build:dist     # esbuild 打包 dist/index.js，同时生成 dist/THIRD-PARTY-LICENSES
```
