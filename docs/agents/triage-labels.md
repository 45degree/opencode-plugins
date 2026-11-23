# 分诊标签

技能提及分诊角色时，将对应值写入本地文件的 `Status:` 字段。

| 分诊角色 | 状态值 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 等待维护者评估 |
| `needs-info` | `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 要求明确，代理可独立实施 |
| `ready-for-human` | `ready-for-human` | 需要人工实施 |
| `wontfix` | `wontfix` | 不予处理 |

调整分诊用语时，编辑「状态值」列。
