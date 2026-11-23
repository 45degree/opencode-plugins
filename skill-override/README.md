# Skill Override 配置

插件在加载时读取两处 `skill-override.json`，按技能名覆盖 OpenCode V2 技能的 `description` 和 `autoinvoke`：

- 全局：`~/.config/opencode/skill-override.json`（若 `XDG_CONFIG_HOME` 设为绝对路径，则为 `$XDG_CONFIG_HOME/opencode/skill-override.json`）
- 项目：`<项目目录>/.opencode/skill-override.json`，只读 `ctx.location.directory` 这一层，不向父目录查找

```mermaid
flowchart LR
  A["原始技能<br/>(registry)"] --> B["全局覆盖<br/>~/.config/opencode"]
  B --> C["项目覆盖<br/>.opencode/"]
  C --> D["最终技能"]
```

## 文件格式

根对象直接以技能名为键。键在运行时与 `SkillInfo.name` 精确匹配，区分大小写；同名技能会一起被覆盖。值只允许两个字段：

```json
{
  "写提交信息": {
    "description": "按仓库规范生成提交信息",
    "autoinvoke": false
  }
}
```

- `description`：字符串，替换展示给模型的描述。空字符串也生效。
- `autoinvoke`：布尔。`false` 走 OpenCode 原生隐藏，技能仍已注册、仍可按 ID 显式加载；不是硬性拦截。

不能修改 `name`、`id`、`path`、`content`，出现这些字段或其他未知字段时整个文件按无效处理。目录下的 `schema/skill-override.schema.json` 可用于编辑器或校验工具。

## 合并顺序

原始技能 -> 全局 -> 项目，按字段合并。上层文件里缺少的字段不覆盖下层结果，`false` 和空字符串算已提供，会覆盖。项目不存在的键不影响其他技能；配置里出现尚未注册的技能名不报警，该技能之后注册时（registry 重建回放变换）同样会被覆盖。

## 热更新

插件每 500ms 轮询一次两个文件，检测新建、修改、删除，包括原子替换和后来创建的 `.opencode` 目录。上一次刷新未完成时跳过本次轮询。合并结果与最后一次成功通知 registry 的结果不同时，调用 `reload()`；registry 重建后，后续模型步骤才能使用新值。`reload()` 失败时，在后续周期重试，连续相同错误只警告一次。结果已同步且文件没有变化时，不重复调用 `reload()`，也不产生日志。每次重建都从 registry 原始状态回放变换，不修改 `SKILL.md`，也不撤回已加载到对话中的技能内容。

## 变换顺序

OpenCode registry 按注册顺序在空集合上回放全部变换，磁盘技能由插件加载之后才注册的变换添加，因此本插件的变换可能位于技能源之前：回放时先应用覆盖、再被技能源的添加覆盖，结果等于未生效。插件因此在每轮检查中做对账：仅当配置了覆盖字段时读取最终技能列表；已匹配技能的 `description`/`autoinvoke` 与配置明确提供的值不符（`false` 与空字符串算已提供）时，才把本插件的变换 dispose 后重新注册到注册队列尾部，下一次重建按"技能源在前、覆盖在后"的顺序生效。没有匹配技能或最终值与规则一致时不重注册：`reload()` 或规则文件变化后，只要最终值已符合规则，就不会触发这种重排。

在无持续冲突且相关调用成功的前提下，该机制最终收敛，不承诺启动时刻原子生效：从插件加载到第一次对账完成之间，模型可能短暂看到原始值。若其他插件每轮都重注册并抢占同一字段，不保证收敛。重注册失败（宿主可能已添加变换但未返回句柄）时记录警告并暂停自动重注册，直到插件重新加载；dispose 失败保留句柄，下一轮重试。

## 错误处理

- 文件不存在：视为空覆盖，下层或原值自然恢复。
- JSON 无效、schema 无效、读取失败（如权限）：输出一次警告并保留该文件上一次的有效内容；相同内容不重复报警，内容变化后会再次校验。插件启动时文件即无效且无历史内容的，按空覆盖处理。
- 警告格式为 `[skill-override] <文件路径> <原因>`，不输出文件内容。

## 接入

由 `opencode.json` 的 `plugins` 字段加载，本插件无选项：

```json
{
  "plugins": [{ "package": "./plugins/skill-override" }]
}
```

包入口经 package.json `main`/`exports` 指向 `dist/index.js`，直接加载预构建产物，无需安装依赖或构建。`entry/index.ts` 源码入口保留，导出与产物相同。

## 开发

```sh
cd opencode/plugins/skill-override
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm test
```

依赖锁定用 pnpm-lock.yaml（由原 package-lock.json 迁移），仓库不含双锁。

## 构建

`pnpm run build` 直接调用 esbuild CLI（精确锁定 0.28.2），把 `entry/index.ts` 打包压缩为 `dist/index.js`：ESM、target es2022、platform node。产物确定，重复构建 hash 一致。运行时依赖只有 node 内置模块；宿主包 `@opencode/plugin`、`effect` 及其子路径标为 external，不会进产物。`dist/index.js` 提交入库，`dist/*.d.ts` 忽略且不生成。插件运行时不读取本目录内的资源文件，无随产物携带项。

设计与决策依据见 [SPEC.md](SPEC.md)。
