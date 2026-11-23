# PackyAPI 插件

面向 OpenCode 2.2.7 的 V2 服务端插件：每把 PackyAPI API key 对应一个独立 provider，并分别发现模型。根据上游标记使用 Responses、Anthropic、Gemini 或 Chat Completions 协议，不通过调用失败来探测或切换协议。

## 使用流程

配置加载所需的本插件 `dist/` 预构建产物已随仓库提供，使用者无需安装依赖或执行构建；仅当修改本插件源码时才需要下面的开发构建步骤。

1. 在 `opencode.json` 中通过 `plugins` 注册本插件并声明 options。`package` 指向本插件目录（即本 README 所在目录）的路径，可相对 `opencode.json` 所在项目根，也可用绝对路径。在 options 中配置统一 `baseURL` 和 `providers` 列表；每把 key 一个条目，ID 稳定可读：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode/plugins/packyapi",
      "options": {
        "baseURL": "https://www.packyapi.ai",
        "providers": [
          { "id": "packy-work", "name": "Packy Work" },
          { "id": "packy-personal", "name": "Packy Personal" }
        ]
      }
    }
  ]
}
```

`baseURL` 可选，默认官方网关 `https://www.packyapi.ai`。接受网关根、以 `/v1` 或 `/v1beta` 结尾的形式与尾随斜杠；代理前缀（如 `https://gw.example.com/proxy/v1`）会保留。整组 provider 共享这一网关，各 provider 仍用各自 key。写入非法或非 http(s) 地址会明确报配置错误，错误信息不回显该地址。

手工模型参数已移除：`defaults` 与 `overrides` 不再是有效选项，传入会明确报错而不是被忽略。模型限制与能力继承自 OpenCode 已加载的原生模型目录（见下文「模型元数据来源」）。

2. 通过原生连接入口为每个 provider 添加 key：`opencode auth login` 后选择对应 provider（或在 TUI 的 /connect 里完成）。key 由 OpenCode 凭据管理保存，本插件配置不保存密钥明文，也不会另建凭据文件。

3. 插件加载后通过各自 key 查询统一网关的 `/v1/models`，使用 Bearer 认证。在原生模型列表中以 `packy-work/model-id` 的形式选择；两个 provider 下的同名模型各自独立存在。

4. 新增凭据、切换活动凭据时，插件监听宿主事件自动刷新对应 provider 的目录；刷新发现活动凭据已更换时，旧目录立即废弃。也可运行原生命令 `/packyapi-refresh` 手动刷新；该命令只做目录发现，不发起任何模型调用。

## 模型元数据来源

插件按模型 ID 相似度选择参考元数据，不验证 PackyAPI 对应模型的实际能力与限制。每个 PackyAPI 模型 id 与宿主**全部**模型目录（含未启用 provider，排除本插件自身 provider）做模糊匹配，使用 fast-fuzzy（全字符串编辑相似度，`useSellers: false`、保留符号、忽略大小写），取分数最高且达到固定阈值 **0.8** 的候选：

- 同分按来源 `providerID:modelID` 字典顺序稳定打破，不依赖目录迭代顺序。
- 精确同名自然得最高分 1。
- 候选池为空或最高分低于 0.8 时沿用宿主默认限制与能力：上下文 200000、输出上限 32000，支持工具、文本和图片输入及文本输出。默认值不是 PackyAPI 实测规格。
- 显示名称始终保留上游 display_name 或 id，不使用匹配来源的名称；匹配分数不会改变实际调用 ID。
- 每次继承输出固定格式诊断（来源 provider、模型 ID 与分数），并明确该元数据不是实际通道能力的保证。
- 永不继承：价格（cost 保持未知）、身份字段（id/providerID/modelID/canonical）、`package`、settings、headers、body、compatibility、变体路由参数、`enabled`（启用只由协议筛选决定）。
- 宿主目录更新后无需重新请求 PackyAPI：provider 状态每次重建时依据最新原生源重新组装。

## 协议映射

每个模型按上游 `supported_endpoint_types` 选择协议路线，优先级：`openai-response` > `anthropic` > `gemini` > `openai`（chat）。同时报告 gemini 与 openai 时优先原生 gemini。各协议的模型级 `package` 与 `settings.baseURL` 显式设置，混合协议在同组 provider 下各自走正确端点：

| 协议 | package | 推理根 | 认证 |
| --- | --- | --- | --- |
| openai-response | `@opencode/ai/providers/openai-compatible/responses` | `<gateway>/v1` | Bearer |
| anthropic | `@opencode/ai/providers/anthropic` | `<gateway>/v1` | x-api-key |
| gemini | `@opencode/ai/providers/google` | `<gateway>/v1beta` | x-goog-api-key |
| openai | `@opencode/ai/providers/openai-compatible` | `<gateway>/v1` | Bearer |

`<gateway>` 为归一化后的网关根（含代理前缀）。没有任何已知协议标记的模型不启用，原因写入诊断输出；不做失败后协议回退，也不跨协议重试。

## 协议筛选

只启用上游 `supported_endpoint_types` 至少包含一种已知协议标记的模型（见上方映射）。协议缺失或全部未知的模型不会出现在可调用列表，原因写入诊断输出。

## 价格

上游不提供价格数据，插件也不猜测，也不从原生目录源继承价格：模型注册为未知价格（cost 为空）。TUI 不显示价格不等于免费；会话统计里没有估价，不代表调用免费。已知宿主限制：若开启按免费过滤模型的选项（disableFree），空 cost 的模型会被过滤，这类模型将不可选。

## 刷新与目录语义

- 触发点：插件加载、活动凭据变化（`credential.switched`）、新凭据加入（`credential.updated`）、手动 `/packyapi-refresh`。首版不轮询。
- 同一 key 查询失败时保留本次运行最近一次成功目录并报告失败；重载后的首次失败报告暂无目录，不会恢复旧结果。
- 成功返回空目录会清空模型（正确反映权限收回）；目录移除的模型后续调用由宿主报错，插件不自动换模型或 key。
- 刷新结果绑定来源连接（`sourceConnection`）；key 轮换前发出的迟到查询结果会被丢弃，不会覆盖新 key 的目录。
- provider 之间相互独立：一个 provider 认证失败、超时或异常不影响其他 provider 的发现与调用。
- 不轮换 key、不做跨 provider 重试、不自动切换模型；推理执行与重试由 OpenCode 核心负责。

## 边界与未验证项

- 模型目录只表示该 key 查询到的可见性，不代表推理可用、底层模型身份或流式与工具能力已验证。
- 已用独立的真实 OpenCode 2.2.7 SDK 内存宿主、假 key 和模拟 HTTP 验证原生连接后的目录发现、两 provider 的推理凭据隔离、活动凭据切换、手动刷新不调用模型、目录移除后调用报错，以及宿主卸载注册时保留凭据。此结果不代表真实 PackyAPI 推理已验证。
- 所有 provider 共用 `options.baseURL`；不支持在单个 provider 下指定另一网关。
- 模型目录仅存内存，不落盘、不持久化密钥派生标识；key 不出现在日志、错误或任何 ID 中。

## 开发

使用者无需安装或构建：仓库已包含预构建产物 `dist/`（压缩的单文件 ESM bundle 与声明类型），把本目录作为 plugins 入口即可；`dist/THIRD-PARTY-LICENSES` 是随产物分发的第三方许可（fast-fuzzy 及其依赖）。

开发者在修改 `src/` 后需要重新构建：

```sh
pnpm install        # 安装依赖（@opencode/plugin 锁定 2.2.7；esbuild/typescript/tsx 为构建与测试工具，fast-fuzzy 源依赖仅供开发）
pnpm run typecheck  # tsc --noEmit
pnpm run build:dist # 内联 bundle + 声明类型 + 第三方许可，输出 dist/
pnpm test           # node --import tsx/esm --test tests/*.test.ts
```

构建产物为压缩（minified）ESM 且可复现：连续两次 `pnpm run build:dist` 输出内容一致。`@opencode/plugin`、`effect` 与 Node/Bun 内置模块不打进产物，由宿主运行时注入；普通依赖（fast-fuzzy 及其依赖链）已内联，使用者机器上不需要插件的 node_modules。

测试使用假 key 与模拟上游（含本地 HTTP 服务驱动的真实 Responses 适配器），不调用真实收费模型。真实 PackyAPI 联调需另行授权并使用独立测试凭据。
