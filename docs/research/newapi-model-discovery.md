# New API 模型发现契约

## 结论

New API 的 `GET /v1/models` 是带 Bearer API Key 的 OpenAI 模型列表接口。模型集合并非实例全局清单：服务端根据请求凭证解析分组，列出该分组启用且对凭证可见的模型。因此各个 New API 分组应分别使用其自身配置的 API Key 查询，发现结果就是该 Key 可见的模型集合；不可将其他 Key、分组或公开价格目录当作替代来源。

在核对的官方 `main` 源码中，标准模型项携带 `id`、`object`、`created`、`owned_by`、`supported_endpoint_types`。列表外层遵循 OpenAI 兼容的 `data` 数组形式。空集合应作为成功的空 `data` 列表处理，而非“模型项缺失”或自动猜测模型。`supported_endpoint_types` 表示协议能力；若字段缺失或为空，协议未知，不应从模型名称、`owned_by` 或 New API 的 OpenAI 兼容性推断具体协议。

这与 `packyapi/src/upstream.ts` 的解析契约一致：要求对象中有 `data` 数组、每项有非空字符串 `id`；`display_name` 是可选字段；`supported_endpoint_types` 缺失映射为 `undefined`，数组中只保留字符串。代码将缺失、空数组和不支持的 marker 分别解释为“未报告”“报告无 endpoint”“没有可支持的协议标记”，不会猜协议。New API 标准模型 DTO 没有 `display_name`，所以它自然保持未定义。适配 New API 时不应把缺少 `display_name` 当成响应无效。

`packyapi/src/upstream.ts` 当前允许协议优先级 `openai-response`、`anthropic`、`gemini`、`openai`；New API 的 endpoint 类型由服务端模型元数据计算，不能仅据 OpenAI 兼容列表断言每个模型支持 Responses。应只启用上游明确报告且插件确实支持的 endpoint 类型。`supported_endpoint_types` 未知或空时，按现有契约不启用。

## 上游实现细节

- `controller/model.go` 的 `ListModels` 根据 token group 解析 owner groups，再通过 `service.GetGroupsEnabledModels` 取得模型；token 限定模型列表和计费配置也可能进一步过滤。
- `buildOpenAIModel` 为模型设置 `id`、`object: "model"`、`created`、`owned_by`，并调用 `model.GetModelSupportEndpointTypes(modelName)` 填充 `supported_endpoint_types`。
- endpoint 类型数据来自 New API 管理的模型元数据/支持端点，而不是客户端应自行推导的模型名启发式。
- 官方 README 的请求示例使用 `GET /v1/models` 和 `Authorization: Bearer ${NEW_API_KEY}`。

## 与现有解析器的逐项对照

| 响应要素 | New API 官方源码 | `upstream.ts` 要求/行为 | 判断 |
| --- | --- | --- | --- |
| 外层列表 | OpenAI 兼容模型列表，返回 `data` | 必须是对象且 `data` 为数组 | 匹配 |
| 模型 ID | `id` | 必须为非空字符串 | 匹配 |
| 展示名 | DTO 不提供 `display_name` | 可选，缺失为 `undefined` | 兼容 |
| 协议字段 | `supported_endpoint_types`，由模型 endpoint 元数据产生 | 缺失为未知；仅识别已支持 marker | 不应推断 |
| 空模型 | 列表可为空 | `data: []` 返回成功且零模型 | 正常空结果 |

## 版本与证据边界

核对日期：2026-11-23。源码链接指向 `QuantumNous/new-api` 的 `main` 分支，属于可变引用；本次在线检索未能独立取得 Git commit SHA，因此不声称某个固定发布版本。实现/验收前应以部署目标对应的 New API tag 或 commit 再核一次，尤其检查空列表序列化和 endpoint 类型枚举。

没有访问任何私有实例或凭证。以上结论来自官方公开仓库源码及 README。对于错误响应形态，本票关注成功模型列表契约；客户端仍应将非 2xx、无效 JSON 和不符合结构的成功响应作为错误，而非覆盖缓存为空。

## 官方来源

- [controller/model.go: ListModels / buildOpenAIModel](https://github.com/QuantumNous/new-api/blob/main/controller/model.go) - 分组模型过滤及 endpoint 字段填充。
- [relaykit/dto/pricing.go: OpenAIModels](https://github.com/QuantumNous/new-api/blob/main/relaykit/dto/pricing.go) - OpenAI 模型响应 DTO 字段。
- [model/pricing.go: GetModelSupportEndpointTypes](https://github.com/QuantumNous/new-api/blob/main/model/pricing.go) - endpoint 元数据读取入口。
- [README.zh_CN.md](https://github.com/QuantumNous/new-api/blob/main/README.zh_CN.md) - 使用 New API Key 查询 `/v1/models` 的官方示例。
- [PackyAPI upstream.ts](../../packyapi/src/upstream.ts) - 仓库内比较的解析契约（相对本报告所在仓库路径）。
