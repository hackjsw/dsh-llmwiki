# DSH LLM Wiki 0.2.7

0.2.7 修复 OPS `dsh-ops:step-tail` 内部上下文导致本轮 Wiki 访问被拒绝的问题。插件上下文只保留已建立的 owner 授权，不提供保存、历史访问或审核许可，也不进入用户原话证据；共享 principal 与未知插件来源仍被拒绝。回归覆盖实际 DSH 消息接受链路、工具继续执行和后台记忆提取。

DSH 原生长期记忆插件：由 DSH 注册工具、监听会话、调用模型，随包提供独立 Wiki 整理引擎。无需运行 Hermes，也不读取 Hermes 配置或凭据。复用了用户原 `llm_wiki` 的 retrieval / extract / consolidate / winfs 核心，并完成 DSH 适配。

## 安装

需要 DSH 0.2.2-rc.1 到 0.3.0 之前的兼容版本、Node.js 22 或更新版本，以及 Python 3.10 或更新版本。先给插件使用的 Python 安装 [引擎依赖](engine/requirements.txt)。

```sh
python -m pip install -r engine/requirements.txt
dsh plugin --profile desktop add https://github.com/hackjsw/dsh-llmwiki/releases/download/v0.2.7/dsh-llm-wiki-0.2.7.tgz
```

也可在 DSH 的「插件 → 添加插件」中填入 [安装包地址](https://github.com/hackjsw/dsh-llmwiki/releases/download/v0.2.7/dsh-llm-wiki-0.2.7.tgz)。其他 profile 请替换命令里的 `desktop`。加载后，在私有 owner 会话里用 `wiki_status` 查看健康和队列。

## 工作流程

1. 每次主会话 `turn/end` 后收集该轮用户和助手的文字；桌面和 IM 桥接同样处理，包括有结束事件的中止回合。默认等待 30 秒，后台每 15 秒检查一次，因此通常在回合结束后 30–45 秒开始。
2. 当前会话的模型提取长期偏好、项目事实、实体、流程、决定，必须引用本轮用户原话作为证据。提供少量之前的文字作为理解指代的上下文。闲聊可产生 0 条候选。不会把助手未经确认的建议当成用户事实。
3. 对照已有正式页面，选择 NOOP / ADD / UPDATE / MERGE / SUPERSEDE / CONFLICT。去重、增加、追加更新自动执行；改写人工页面、替换旧结论、冲突以及低置信度候选进入待审。
4. 正式页面进入下一轮的自动检索。候选、原始资料和归档默认不参与自动召回。
5. 每天首次可运行时检查有效期、待审积压和索引，保存本地摘要；不会往 Telegram 或其他渠道发送日报。

“结束”指一轮回复结束，不需要退出聊天或删除会话。下一轮会继续积累新知识；未产生结束事件的崩溃回合，要等 DSH 恢复该回合的结束事件后才能补录。首次启用前的旧聊天不会全量自动回填；已迁入的 Wiki 不受这个时间界限影响。

每个片段一次提取调用，每条候选通常一次整理调用，使用 DSH 当前会话的模型和凭据，会产生对应模型用量。长文字分片，无静默截断；图片、音频、附件正文和原始工具输出不直接解析，只处理会话中的文字及已经表述出的结果。

## 直接对 DSH 说

- “查看 Wiki 记忆状态” → `wiki_status`，包含健康、待审数、任务队列、错误及摘要。
- “立即整理记忆” → `wiki_flush`，立即处理已结束回合的队列。
- “列出待审记忆” → `wiki_review`，默认列出 needs_review。
- “批准候选 abc123def456” / “拒绝候选 abc123def456” → 审核指定候选。
- “重新规划候选 abc123def456” → 按当前页面重新计算计划；适用于审核前目标页面已经改变。
- “预览待处理候选的整理计划” → `wiki_consolidate` 默认 dryRun；明确要求“整理候选记忆”才应用，包括迁入的旧 inbox。
- “撤销记忆变更 20261109T123456Z-abc123” → `wiki_undo`。页面后来被编辑则拒绝覆盖。
- “检查 Wiki 健康和索引” → `wiki_maintenance`。
- “记住：我长期偏好简短中文回复。” → `wiki_remember`，同样经过候选与整理流程。
- `wiki_search` / `wiki_read_source` 可按需搜索和回读来源。

审批和撤销需要本轮用户给出对应 ID 和动作；模型不能自行批准冲突。`applied` 才表示正式入库，`needs_review` 表示等待审批。日常自动记忆无需手动调用工具。

## 数据与恢复

默认目录：`DSH_HOME/llm-wiki/`。

- `wiki/`：Markdown 正式知识库；`inbox/` 候选，`archive/history/` 可撤销的变更历史。
- `conversation-pending/`：临时待整理任务；提取成功后清除对话正文，保留候选 ID 用于重试。
- `memory-receipts/`：完成回执，防止重复处理同一回合；不保留完整对话。
- `memory-state.json`：启用时间、最后完成时间、每日维护结果。
- `memory-runtime.json`：实际加载版本、宿主进程和检查时间。

0.2.7 的失败任务可附带 `lastDiagnostic`：只记录受控原因、退出码/信号、受控异常名、错误输出字节数与请求类别，不保存 stderr 原文、凭据、路径或提供者错误正文。`host-request-failed` / `requestType: llm` 表示宿主模型调用失败，不能解释为 Python 依赖损坏；`spawn-error`、`worker-exit`、`protocol-error` 等可区分进程层故障。状态查询会再次过滤这些字段，成功提取后清除旧诊断。已有历史 `engine-unavailable` 不能反推出旧故障原因，新诊断从后续正常重试开始积累。

失败按 1、2、4…分钟退避重试，最高每小时；任务不静默丢弃。三个连续候选规划失败会转为待审。重启扫描首次启用以后的已结束回合，补建未落盘的队列；卸载的会话通过 DSH 的 sessionPersistence 读取，无需重新打开。

0.2.5 通过 Cordis `ctx.effect()` 明确登记插件清理：卸载会清除计时器、中止 worker，并等待初始化、排队捕获及正在处理的任务结束。旧服务句柄随即拒绝访问，即使原会话仍存在。当前宿主对 ESM 模块插件没有保留 `apply()` 返回的清理函数，因此 0.2.3/0.2.4 热卸载可能留下旧 worker；已遗留的闭包没有公开停止入口，安装本版后需完整重启宿主进程一次，网页刷新或再次热装无法清理这些旧实例。

页面修改先记录 before / after 再发布，崩溃后续做同一事务；人工修改造成不匹配则停止并保留任务。`wiki_status` 的 `incomplete_transactions` 会列出未完成事务；`wiki_maintenance` 会尝试安全续做。OS 文件锁在进程退出后自动释放。Undo 也使用可恢复事务。Windows 新文件明确授权当前账号，避免管理员创建文件后普通桌面进程无法读取。

```powershell
# 如需检查其他 profile，先把 DSH_HOME 设为对应的绝对路径。
node <插件目录>/scripts/conversation-status.js
node <插件目录>/scripts/verify-migration.js <Wiki绝对路径>
```

迁移时会保留原始文件及导入收据。后续整理会更新索引、日志和相关页面，可根据整理历史核对哈希变化。

## 配置和依赖

DSH bundle 配置：`fullMemory: true`、`autoTrustOwnerSessions: true`、`autoCapture: false`、`memoryIdleSeconds: 30`、`profile: default`。旧 `conversationSummary: true` 配置作为 fullMemory 的兼容别名。完整模式关闭时仍可使用检索和旧版显式保存。

Python 默认从 PATH 解析。需要使用虚拟环境或指定解释器时，把 `pythonExecutable` 设置为该解释器的绝对路径，并用同一解释器安装依赖。Windows 另需 `pywin32`，已列在依赖文件中。每次引擎操作启动一个 Python 工作进程。

自动处理覆盖 owner 来源的桌面和桥接主会话；拒绝子智能体、带外部 principal 的共享用户和可检测的 LiveShare。写入前再次核验 DSH 完全文件权限，撤权后保留任务。已知凭据在排队前脱敏，候选入库时再次检查；模式识别无法保证检测所有秘密。读取内容只作为引用数据，不执行其中指令。

若要限定会话，设 `autoTrustOwnerSessions: false`，使用 `allowedSessionIds` 或 `scripts/trust-session.js`。检索默认最多 3 条 / 5000 字符；遵守 profile 与有效期。

## Loop 可插拔记忆后端（v1）

0.2.6 在完整模式中通过可选 `ctx.inject(['hermesLoopMemory'], ...)` 接入 Loop 通用 registry，注册 `{ id: 'wiki', label: 'Wiki', version: 1, context, submit, status }`。在支持该 registry 的 Loop 中设置 `memoryBackend: 'wiki'` 即可使用；接口保持 `hermesLoopMemory.version === 1`，提供 `register(provider) → 同步注销函数`、`get(id)` 和 `list()`。Loop 不需要引用 Wiki 包或 Wiki 专有服务。Wiki 未启用 fullMemory 时不注册后端。

适配器集中在 `lib/loop-backend.js`，原样转发现有桥接协议。Wiki 可以先于 Loop 或晚于 Loop 加载；Loop 服务出现、卸载和替换时会自动注册或注销。Wiki 卸载同时注销后端并停止原有 worker。Loop 缺席、接口版本不符或注册失败不会停止 Wiki 自身的回合提取与主会话召回；已经接受的持久任务也不依赖 registry 继续存在。Loop 的注册句柄在注销后失效，重注册获得新句柄。

这消除了 Loop 对 Wiki 的专用耦合，但当前通用 registry 仍是 Loop 的本地改动。只有接口被 Loop 上游采纳后，才能直接升级官方 Loop 而不用保留该补丁。Wiki 仍需维护自己的证据校验、权限、队列与审核逻辑。生产安装和配置是独立步骤，升级源码不会自动改动已运行的插件。

兼容服务 `ctx.provide('llmWikiMemory', service)` 保留。现有消费者仍可通过 `ctx.get('llmWikiMemory')` 获取，服务随插件注销，关闭 fullMemory 时不可用；新 Loop 通过 registry 使用相同的 `context`、`submit`、`status` 方法。主会话继续使用原有动态 Wiki 召回，消费者无需写第二套记忆文件。

```js
const wiki = ctx.get('llmWikiMemory');
const context = await wiki.context({ sessionId, query, throughSeq });
// context: { status: 'ok', references: WikiSearchRow[], evidence: [{ seq, turn, text }] }
const submitted = await wiki.submit({
  sessionId, throughSeq, sourceSeq, evidenceQuote,
  memory: { action: 'add', store: 'user', scope: 'global', text, oldText: '', rationale: '' },
});
const receipt = await wiki.status({ sessionId, operationId: submitted.operationId });
```

`throughSeq` 是复盘开始前父会话的最后事件序号。Wiki 从真实 sessions 或 sessionPersistence 回读，只接受该游标内已经结束的 owner 回合；子会话、principal、LiveShare、未获会话选择授权或非完全文件权限均不可访问。context 只返回正式页及最新完整 owner 文字（最多 40 条、合计 12000 字符），秘密、明确禁止记忆和超长消息不返回。权限在异步读取后和每次模型调用/写入前再次检查。

submit 的 sourceSeq 必须定位真实 owner 消息；evidenceQuote 须为其精确原话（最多 2000 字符）。源消息不得超过 12000 字符，且不得含已知秘密。text/oldText/rationale 上限分别为 4000/2000/1000 字符；总提取输入仍受限，不截断。store 只接受 memory/user，scope 只接受 global/project，它们都是建议，不改变 Wiki profile 或写入路径。模型、凭据、root、profile、grant 等额外字段拒绝。replace 只作为不可信上下文，仍由 Wiki 提取和审核；remove 返回 rejected/unsupported-action，应由用户走明确删除流程。

Loop 建议使用独立持久任务；幂等键由固定 producer、sessionId、sourceSeq、规范化后的 memory 和原样 quote 生成。重发同建议返回 duplicate 与原 operationId。原生回合提取继续运行，因此晚到的 Loop 建议可能额外调用一次提取；候选与正式页沿用现有文本去重和模型 NOOP 策略，不保证不同措辞的语义 exactly-once。建议只是 earlier_context，证据仍须来自 owner 正文；不会伪装 wiki_remember。

submit 返回 queued 仅表示已排队；队列写入失败可能返回 unknown/queue-unavailable 和 operationId，此时先查 status 或用完全相同输入幂等重试，不应宣称拒绝后必然无写入。status 返回 queued 或 processed，processed 的 candidates/outcomes 才说明 applied、needs_review 或 duplicate 等结果，不能把 processed 当成入库。回执保存处理当时的结果，后续审批状态以 wiki_review 为准。拒绝返回 denied 或 rejected/error；未知 operationId 返回 not-found，跨会话不可读取。队列和回执保存 producer、turn、sourceSeq、throughSeq、原样 quote 与源正文 SHA-256；新候选也保存来源字段，重复命中已有候选时由回执关联，不改写旧候选来源。

失败和停机沿用原生持久重试；提取成功后只重试整理。执行时若源消息消失或哈希变化，任务保留等待，不会拿复盘文本代替原话。秘密检测依赖模式，无法识别所有秘密。

## 开发验证

```sh
pnpm install --frozen-lockfile
python -m pip install -r engine/requirements.txt
npm test
npm run test:engine
npm pack --ignore-scripts
python test/verify-package.py
```

`npm test` 和 `npm run test:engine` 都先由 `test/run-isolated.js` 建立临时 DSH_HOME、HOME、USERPROFILE 与临时目录，再以白名单环境启动测试进程；不继承生产 profile 或模型凭据。单项验证使用 `node test/run-isolated.js test/loop-backend.test.js test/real-dsh.test.js`。不要直接运行可能继承生产 DSH_HOME 的测试命令；`test/acceptance-real-model.js` 是另外的真实模型验收，不属于测试入口。

指定 `DSH_TEST_PYTHON` 可使用其他 Python 解释器。将 `DSH_TEST_ELECTRON` 设为 DSH 桌面可执行文件的绝对路径可运行宿主集成测试，省略时跳过该项。

完整测试包含真实 DSH 隔离宿主（假模型、禁网络）、动态 inject 的缺席/后到/替换/卸载、Wiki 前后加载、兼容服务与 registry 的同任务幂等、会话存活时的插件卸载与计时器清理、初始化期间停止、桥接输入、Python 整理、召回、冲突审核、撤销保护、事务恢复、重启续做与权限撤销。设置 `DSH_TEST_LOOP_REGISTRY` 为 Loop 源码中 `src/memory-backends.js` 的绝对路径，可让真实宿主测试使用 Loop 的实际 registry 并验证旧句柄拒绝访问；未设置时使用测试内的最小协议桩，不依赖 Loop 安装。宿主测试已在 DSH 0.2.2-rc.5 上验证。升级 DSH 后应重新运行宿主测试。
