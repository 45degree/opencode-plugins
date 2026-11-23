# OpenCode 插件生命周期、cleanup 与 storage 研究

## 结论摘要

- **OpenCode `v2.2.7` 的 Promise 插件支持异步清理函数**：`@opencode/plugin` 类型声明允许 `setup` 返回 `Promise<Cleanup | void>`，而运行时适配器在插件 scope 关闭时执行 `Promise.resolve(cleanup())`。健康插件正常从注册表卸载或替换时，OpenCode 通过 `Scope.close` 关闭其 scope，并等待该关闭过程。
- **不能把上述行为扩展成所有 cleanup 都会被 join 的保证**：插件 transform 回放失败后，插件被标记失败，其 scope cleanup 在单独 fork 的后台 worker 中处理；v2.2.7 有测试名直接断言 reload 与 teardown 不等待该 queued cleanup。服务完全关闭时，健康插件 scope 在 registry close 内被关闭，属于等待路径；但异常插件上述队列任务不保证被 teardown join。
- **server restart**：CLI `service restart` 的实现是 stop 旧服务再 ensure 新服务。旧进程内部的 Effect scope 关闭会沿正常 shutdown 路径执行插件 finalizers；但未找到 CLI 对“所有 cleanup 均完成后才重启”的端到端测试或独立超时契约。因健康插件 finalizer 在 scope close 中执行，源码路径表明 shutdown 会等待这些 finalizer；failed-plugin queued cleanup 是例外，不可保证。
- **插件配置变化/替换**：插件定义 revision 包含配置 operation；supervisor 重新 activate 后，健康旧 revision 在 replacement setup 前通过 `Scope.close` 卸载。健康 cleanup 因而等待完成。配置文件触发 watcher/重载；不是强制重启服务。
- **仅 `provider.reload()`**：这是 provider transform registry 的 reload/invalidation，不会卸载插件 scope，不会重新执行 plugin `setup`，也不调用其 cleanup。若模型清单加载要在 cleanup 等待，则应由 `setup` 返回 cleanup 管理该刷新 Promise，并在 cleanup 中停止接收新任务、await 当前刷新，避免把等待职责误寄托在 `provider.reload()` 上。
- **cleanup 超时**：在核验的 OpenCode v2.2.7 插件 scope close 和 async cleanup adapter 路径中没有发现插件 shutdown cleanup 的超时包装。源码没有建立一个可依赖的固定超时上限。OS 强杀、SIGKILL、崩溃/断电不在此保证范围。
- **storage 写入**：官方文档将 `ctx.storage` 定义为 plugin-scoped durable JSON API，`set` 返回 `Promise<void>`。v2.2.7 的实现直接将其委托到 server KV service，KV `set` 执行 SQLite upsert 并在完成后 resolve。因此 cleanup 中 `await ctx.storage.set(...)` 的设计可用；只要 cleanup 正在被运行且服务 scope/数据库仍存活，写入 API 可执行并 await。若进程被硬杀、cleanup 未被 join、或 cleanup 自行超时/抛错，不保证写入成功。

## 证据版本和方法

- 用户现有 `packyapi/package.json` 固定 `@opencode/plugin` `2.2.7`。
- OpenCode 官方源码仓库：`anomalyco/opencode`。
- 核验的 tag：`v2.2.7`，commit `fedc6f208aa2bd54c1019227214568083f6380ad`。
- 后续可核实版本：`v2.3.2`，commit `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`。该版本仍保留 cleanup 关键语义，且替换路径新增了对 cleanup finalizer 失败的捕获记录；queued failed-plugin cleanup 仍通过 fork 处理，测试仍明确表达 teardown 不 join queued cleanup。
- 方法：读取上述官方 tag 对应仓库中的源码与测试；对照 OpenCode 当前官方文档。源码永久链接固定到 tag/commit，避免 `dev` 文档与旧目标版本混淆。

命令记录（研究环境为 macOS zsh；成功命令退出状态 0）：

```sh
git ls-remote --tags https://github.com/anomalyco/opencode.git 'refs/tags/v2.*'
# exit 0；确认 v2.2.7 与 v2.3.2 tags
git clone --filter=blob:none --no-checkout https://github.com/anomalyco/opencode.git /private/var/folders/w2/l_5jzbx96y11lr2z7jrc6wwm0000gn/T/opencode/upstream-opencode
# exit 0
git -C /private/var/folders/w2/l_5jzbx96y11lr2z7jrc6wwm0000gn/T/opencode/upstream-opencode checkout v2.2.7
# exit 0
git -C /private/var/folders/w2/l_5jzbx96y11lr2z7jrc6wwm0000gn/T/opencode/upstream-opencode fetch --depth=1 origin tag v2.3.2
# exit 0
```

实际核对的关键源码文件：

- `packages/plugin/src/promise/plugin.ts`
- `packages/plugin/src/promise/adapter.ts`
- `packages/core/src/plugin.ts`
- `packages/core/src/plugin/module.ts`
- `packages/core/src/plugin/supervisor.ts`
- `packages/core/src/plugin/host.ts`
- `packages/core/src/kv.ts`
- `packages/core/src/state.ts`
- `packages/core/test/plugin.test.ts`
- `packages/core/test/plugin-failure.test.ts`
- `packages/server/src/process.ts`
- `packages/cli/src/commands/handlers/service/restart.ts`

没有运行 upstream 测试套件；本报告的验证是源码与已有测试断言的静态核验，不宣称本地重跑测试。

## 逐项分析

### 1. Async cleanup API 和 adapter

v2.2.7 `packages/plugin/src/promise/plugin.ts` 第 62-67 行声明：

```ts
export type Cleanup = () => Promise<void> | void
export interface Plugin {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}
```

`packages/plugin/src/promise/adapter.ts` 第 666-669 行将 setup 结果作为 scoped acquire resource，release 时执行 cleanup：

```ts
yield* Effect.acquireRelease(
  Effect.promise(() => Promise.resolve(plugin.setup(context2))),
  (cleanup) => (cleanup ? Effect.promise(() => Promise.resolve(cleanup())) : Effect.void),
)
```

结论是 API 接受 async cleanup，而且 cleanup 的 Promise 被纳入资源 release effect，而非 fire-and-forget。

官方文档当前 lifecycle 说明同样明确说 `setup` 可返回 cleanup function，插件 unload 时执行。文档只定义生命周期语义，没有承诺 shutdown timeout 或所有异常状态均 join。

### 2. 插件替换、配置变化与 cleanup 等待

v2.2.7 `packages/core/src/plugin.ts` 第 137-150 行在计算变动插件 suffix 后，逆序遍历旧 scope；健康 activation 会执行：

```ts
if (slot.activation && !slot.activation.failure)
  yield* Scope.close(slot.activation.scope, Exit.void)
```

这段 effect 是 activation/replacement 流程的一部分，不是 fork，故健康插件的 async cleanup 完成后才继续加载 replacement。

`packages/core/src/plugin/module.ts` 第 135 行以 `[operation, server revision]` 构造插件 revision；`operation` 包含配置源和 options。`packages/core/src/plugin/supervisor.ts` 监听配置/plugin source changes 并重新解析/activate，所以配置选项或插件定义变化可导致旧 revision 被卸载、新 revision 被加载。若操作没有导致实际 revision/order 改变，注册表可保留现有 activation，不会为了每个无效变化强行重载。

版本 `v2.3.2` 替换实现仍关闭旧 scope，但额外 catch cleanup finalizer failure 并 log error（`packages/core/src/plugin.ts` 第 145-153 行）。这是可核实后续版本的差异：失败不会阻止其余 replacement，但 cleanup 抛错当然不代表业务副作用成功。

### 3. 正常 server shutdown、restart 与故障 cleanup

`packages/core/src/plugin.ts` 第 250-260 行的 `close` 在 registry lock 内调用：

```ts
yield* State.shutdown(Scope.close(scope, exit))
```

插件 scope 是 registry 主 scope 的子 scope，因此关闭主 scope 会处理仍在活动状态插件的 finalizers。Promise adapter 的 cleanup 正是 plugin scope 的 acquired resource finalizer。对于正常健康插件，这条关闭路径会等待 finalizer effect 完成。

CLI `packages/cli/src/commands/handlers/service/restart.ts` 第 11-17 行执行 `Service.stop(options)`，随后 `Service.ensure(options)`；server process 的 application scope shutdown 会触发该 scope 中的层资源关闭。由此可支持“健康插件 async cleanup 在正常 scope shutdown 中参与等待”的源码结论。

但必须区分 transform failure：

- transform 出错后，registry 将 failure scope 放入 queue。
- `packages/core/src/plugin.ts` 第 219-233 行将 `Scope.close(item.scope, Exit.void)` 以 `Effect.forkScoped` 后台启动，并注释说明不能在 activation lock/readiness hold 下 join finalizers。
- `packages/core/test/plugin-failure.test.ts` 第 71-72 行的测试名称是 `does not join queued failed-plugin cleanup during reload/teardown`。该测试第 127-136 行用 250ms timeout 验证 activation 可结束，而 finalizer 后续释放后才确认 cleanup 完成。

因此不能对“任意 plugin cleanup”做无条件完成承诺：healthy plugin replacement/normal scope close 是 join 路径，queued cleanup for failed plugins 明确不是。

### 4. Shutdown timeout 限制

在 v2.2.7 plugin registry close、Promise adapter cleanup 和 server process scope close 这些执行路径中，没有找到针对插件 finalizer 的定时器或 `timeout` operator。`250 millis` 出现在测试中是测试断言边界，不是产品 shutdown timeout。

所以证据支持的表述是“未发现显式插件 cleanup timeout；healthy finalizer 可拖住正常 scope close”，而不是“永不超时”或“产品保证无限等待”。上层服务管理器、操作系统或外部 supervisor 的强制终止政策不由这些源码保证。本研究排除强制杀进程。

### 5. `provider.reload()` 与 `ctx.storage.set`

官方 Server 插件文档区分 provider transform/reload 和 plugin lifecycle：reload 让已注册 transform 在新读取时重放，不重新执行 plugin setup。官方文档对 model transform 亦说明 `reload()` 后重放 active transforms，但不会运行 plugin setup。

因此 `await ctx.provider.reload()` 不触发 cleanup，也不应被当成 lifecycle/shutdown barrier。

Storage 的官方文档将其定义为 plugin scoped durable JSON values，签名为：

```ts
interface StorageContext {
  set(key: string, value: Json): Promise<void>
}
```

v2.2.7 `packages/core/src/plugin/host.ts` 第 663-671 行按 plugin ID namespacing 后委托 `kv.set`。`packages/core/src/kv.ts` 第 49-55 行通过 SQLite insert/upsert 并等待 `.run()` 完成。因此 cleanup 内 `await ctx.storage.set(...)` 是可行的正常写入方式。语义是可调用、可 await 的持久 KV API，不等价于跨 crash 的绝对落盘承诺；硬杀或 cleanup 未运行/被取消、数据库关闭错误均可能使其未完成。

## 生命周期情形矩阵

| 情形 | 会不会调用 cleanup | async cleanup 是否被 await | 可依赖结论 |
| --- | --- | --- | --- |
| 健康插件被 config/options/revision 替换或移除 | 是 | 是，旧 scope close 是 activation 流程 | 成功 cleanup 阻塞替换继续；cleanup 抛错的处理版本间略有变化 |
| 健康插件所在 server 正常关闭 | 是 | scope finalization 等待 | 未发现 cleanup 专属超时；不等于无限制承诺 |
| CLI service 正常 restart | 旧服务 shutdown 会关闭 scope | 健康插件 cleanup 沿 shutdown scope 等待 | 源码路径成立；不是 end-to-end restart cleanup 测试 |
| 插件 transform 故障后排队 disabled cleanup | 是 | 不由 activation/teardown join；后台 fork | v2.2.7 测试明确验证 reload/teardown 不等待 queued cleanup |
| `ctx.provider.reload()` / `ctx.model.reload()` | 否 | 不适用 | 只重放对应 transform，不重跑 setup 或 cleanup |
| SIGKILL、崩溃、断电 | 不保证 | 不保证 | 明确排除 |

## 官方一手来源

### 源码永久链接

- [v2.2.7 `packages/plugin/src/promise/plugin.ts`](https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/plugin/src/promise/plugin.ts#L62-L71) - async `Cleanup` 类型。
- [v2.2.7 Promise adapter](https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/plugin/src/promise/adapter.ts#L660-L670) - cleanup 通过 `Effect.acquireRelease` 执行。
- [v2.2.7 registry replacement/close](https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/core/src/plugin.ts#L137-L150) - 替换时关闭健康 plugin scope；[close 实现](https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/core/src/plugin.ts#L250-L260)。
- [v2.2.7 failed plugin queued cleanup](https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/core/src/plugin.ts#L219-L233) - failed scope cleanup fork。
- [v2.2.7 failure lifecycle tests](https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/core/test/plugin-failure.test.ts#L71-L138) - reload/teardown 不 join queued cleanup；[shutdown test](https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/core/test/plugin-failure.test.ts#L261-L305)。
- [v2.2.7 server process scope](https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/server/src/process.ts#L91-L148) - application scope 和 restart/shutdown effect。
- [v2.2.7 service restart command](https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/cli/src/commands/handlers/service/restart.ts#L9-L18)。
- [v2.2.7 plugin storage bridge](https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/core/src/plugin/host.ts#L663-L690)。
- [v2.2.7 KV SQLite write](https://github.com/anomalyco/opencode/blob/fedc6f208aa2bd54c1019227214568083f6380ad/packages/core/src/kv.ts#L27-L58)。
- [v2.3.2 replacement behavior](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/core/src/plugin.ts#L137-L156) - cleanup finalizer errors logged then replacement continues。
- [v2.3.2 failed-cleanup test](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/core/test/plugin-failure.test.ts#L71-L138)。

### 官方文档

- [Building plugins - Server lifecycle, transforms, reload and storage](https://opencode.ai/docs/build/plugins/server/) - setup/unload cleanup、transform reload 语义、durable plugin-scoped JSON storage。
- [Plugins - configure/reload](https://opencode.ai/docs/plugins/) - plugin config and watched changes reload behavior。

文档是当前站点版本，可能随开发演进；针对固定 `2.2.7` 的行为结论以 pinned tag 源码与测试为准。
