![Codex Remote Proxy Banner](./assets/banner.png)

# Codex Remote Proxy 中文文档

Codex Remote Proxy（CRP）让 Codex 保持 ChatGPT 登录态，同时把模型请求转发到当前选中的 OpenAI 兼容提供商。Codex 始终使用内置的 `OpenAI` 提供商身份，因此切换上游不会改变已有 OpenAI 线程的归属。

[English](./README.md)

> 发布状态：npm 当前版本是 `0.3.0`，已经包含 Supervisor 和 `crp ui`。`0.3.0` 之后的变更仍需通过确定性测试、平台门禁和人工审查才会发布。

## 安装

需要 Node.js 22.13 或更高版本。

```bash
npm install -g @cluic/codex-remote-proxy
```

普通用户的主要入口是：

```bash
crp ui
```

不做全局安装也可以运行：

```bash
npx @cluic/codex-remote-proxy ui
```

`crp ui` 会启动或发现本地 Supervisor，并打开管理界面。界面首次启动始终使用 English，并可通过语言选择器切换为简体中文；浏览器只会保存用户明确选择的语言，因此选择中文后后续启动会保持中文。

当前开发版界面使用 `node/ui-src/` 中的 React、TypeScript 与 Vite 实现。这些工具只参与构建；发布包和 Admin Server 仍然只交付 `ui/index.html`、`ui/app.js` 与 `ui/styles.css`，不需要前端运行时服务器，也不包含远程字体、CDN、遥测、source map 或动态 chunk。

## 可以管理什么

本地管理界面覆盖完整的日常流程：

- 创建具名提供商；
- 通过只写输入框填写凭据；
- 测试 OpenAI Responses API 兼容性；
- 直接在提供商卡片上切换符合条件的提供商；
- 替换非当前提供商的凭据或删除非当前提供商；
- 启动、停止、重启和查看代理 Worker；
- 在总览中查看匿名的 24 小时或 7 天请求、结果、已观测 Token、模型、Provider 与有界延迟 Metrics；
- 查看已脱敏的控制面 Activity 和只读系统事实；
- 生成只包含创建状态、生成时间和已脱敏事件数量的内存诊断摘要。

侧边栏会显示不可操作的 `转发记录 / 即将上线` 占位项。本 MVP 不提供转发记录路由、请求/响应查看器、Capture 控件或模拟流量数据；总览 Metrics 是独立于可选 Capture 的匿名聚合状态。24 小时和 7 天序列使用固定 UTC 小时桶。只有成功的 Responses 终态事件或已完成 JSON 响应才计为成功；如果存在丢弃的指标更新，界面会把成功率标记为不可用，而不是展示看似精确的百分比。Provider 和模型分布始终保留明确的合并余量。

提供商切换只影响新请求。已经在处理中的请求继续使用其开始时捕获的提供商快照，包括模型策略。`passthrough` 模式保留客户端模型；`override` 模式只替换 JSON 顶层 `model` 值。显式 activation 路由同时也是生产切换操作：Worker 运行时应用新快照，Worker 停止时会启动它。首次选中有意不同：兼容性测试成功后，Setup、CLI 和普通 Providers 页面都会在尚无当前 Provider 时通过 first-wins compare-and-set 选中候选，Worker 保持停止。

代理透传会按背压流式转发请求和响应字节，不会自动解压请求体。模型覆盖只在 8 MiB 有界范围内改写 JSON；发生改写时会尽可能保留 gzip、deflate、Brotli 和原生 zstd 编码，并移除已经失效的正文完整性/签名头。Node 没有原生 zstd 压缩能力时，经过验证的单帧 zstd 覆盖请求会在改写后以 identity 转发；非覆盖流量中无法安全检查的 zstd 帧仍保持字节完全一致。客户端取消连接会终止对应的上游工作。

可选 Capture 对请求体和响应体各自最多保存 1 MiB，同时保留实际观测总字节数。存在已配置保护值时，截断正文、已声明或检测到的压缩正文，以及包含明文或可恢复编码保护值的正文都会记录为 `empty-truncated`；能够完整筛查的文本/二进制记录仍使用明确的 UTF-8/base64 编码。配置的 API key 和额外请求头值不会进入 Capture header、正文、URL/ID 元数据或 debug 日志。Metrics 的缓冲正文检查独立限制为 8 MiB，SSE 使用有界事件做增量检查，两者都不会隐式开启 Capture。

## 固定的 Codex 配置

CRP 只需引导配置一次，并持续保持以下不变量：

```toml
model_provider = "OpenAI"
```

```text
http://127.0.0.1:15100
```

提供商切换发生在 CRP 内部。日常切换时不要为每个上游创建不同的 Codex `model_provider`，也不要修改固定代理地址。

在全新 HOME 中，显式运行 `crp start` 会私有且原子地创建缺失的 `.codex` 目录和 `config.toml`，不会为原本不存在的文件创建备份。在支持的 POSIX 系统上，新目录权限为 `0700`，新文件权限为 `0600`。再次执行引导会保持文件字节完全不变。已有配置只有在内容确需改变时才会生成相邻私有备份，其无关设置、换行符和权限都会保留。

修改已有的 Codex 层 provider 绑定前，必须先完全退出 Codex。Bootstrap 会从同一份加锁配置快照读取根 `model_provider` 及其受支持的 `base_url` 绑定。无效 UTF-8 或 selected-provider 绑定畸形/歧义会在备份、journal 和配置写入前失败；该 scanner 只校验相关绑定，不是完整 TOML validator。有效 URL 不同或缺失时才发现历史写集；只有非空写集会创建私有 rollout 快照、排他 SQLite 逻辑备份和 `.codex/.crp-history-repair` 前向恢复 journal，已对齐的历史走无 journal 的 config-only 提交。随后 CRP 发布固定配置，并只修改 active/archive rollout 中 `session_meta` 的 provider 元数据及受支持 SQLite 中的 `threads.model_provider`。修复 pending 或存在 config lock 时 Codex 都不是 ready，provider activation、Worker start/restart 和崩溃自动恢复都会被阻止；下一次 bootstrap 会继续修复。加密历史内容绝不会被改写；CLI 会输出静态警告，因为部分加密消息仍可能不可用。

CRP 内部的 provider add/test/activate/热切换绝不会触发该修复。按照仅比较 URL 的触发要求，如果 provider 名改变但有效 URL 相同，则不会重写历史元数据；迁移这类自定义布局需要单独人工审查。受管配置/历史备份可能包含本地私有状态，必须按原 Codex 目录同等保护。

## 凭据安全

公开 Supervisor 必须通过服务名 `org.cluic.codex-remote-proxy` 使用操作系统原生凭据存储：

- macOS Keychain；
- Windows Credential Manager；
- Linux 上兼容的 Secret Service。

如果原生后端无法构造或后续失败，公开启动与凭据操作会直接失败。当前 UI、CLI 和 Admin API 都没有文件存储授权或选择控件。底层私有文件适配器只允许受信任的依赖注入使用；公开 startup consent 属于未来 L3 工作，原生操作绝不会重放到该适配器。

界面不会读回已保存的密钥。编辑时密钥输入框始终为空，完整密钥不会出现在 API 读取结果、活动记录、诊断、状态文件或日志中。

## 本地浏览器安全

Admin 服务只绑定 `127.0.0.1:15101`，会拒绝不符合预期的 `Host` 和 `Origin`，禁用 CORS，并要求浏览器修改操作携带 CSRF 保护。

`crp ui` 会把私有的本地控制令牌放在 URL fragment 中。fragment 不会随 HTTP 请求发送；界面用它换取仅驻留内存的 CSRF 令牌和 HttpOnly、`SameSite=Strict` 会话 Cookie，随后移除 fragment 并清除本地令牌引用。令牌、凭据、提供商草稿、响应和错误都不会写入浏览器存储。

如果会话仍有效但刷新后的页面没有启动 fragment，界面会先进入仅 GET 工作区。用户可以在该认证 Cookie 会话仍有效时显式恢复管理权限；CRP 会强制精确同源请求和非简单恢复请求头，旋转会话 ID 与 CSRF，且不会延长原始到期时间。会话过期后仍需重新运行 `crp ui`。启动交换失败，或后续业务会话/CSRF 鉴权失败，都会使当前标签页进入终止状态。

## CLI

凡是需要输入凭据，优先使用管理界面。Supervisor 同时提供以下命令：

```text
crp ui [--no-open] [--json]
crp start [--json]
crp status [--json]
crp stop [--json]
crp restart [--json]
crp shutdown [--json]
crp provider list [--json]
crp provider add --name <NAME> --base-url <URL> --api-key <KEY> [--model <MODEL>] [--json]
crp provider models (--id <ID> | --name <NAME>) [--json]
crp provider test (--id <ID> | --name <NAME>) --model <MODEL> [--json]
crp provider activate (--id <ID> | --name <NAME>) [--json]
crp provider delete (--id <ID> | --name <NAME>) [--json]
```

正式推荐的入口只有两个：普通设置和日常管理使用 `crp ui`，无界面 CLI 启动使用 `crp start`。`ui` 会启动或发现 Supervisor 并打开管理页面；`start` 会启动或发现 Supervisor、引导固定的 Codex 配置，并启动代理 Worker。

所有 CLI 人类可读路径都支持 English 和简体中文。无论 `CRP_LOCALE`、`LC_ALL`、`LC_MESSAGES`、`LANG` 或终端语言是什么，默认始终输出 English。一个全局 `--locale en|zh-CN` 可以出现在命令行任意位置；只有显式提供 `--locale zh-CN` 时才输出中文。选择只对当前进程生效且不会持久化。语言只影响人类可读输出。使用 `--json` 时，失败不会写入 stdout，并且只向 stderr 写入一个语言无关的错误文档。

## 许可证

本项目采用 [MIT License](./LICENSE)。

不使用 `--json` 时，`provider list` 会展示提供商数量，以及每个提供商的当前标记、名称、ID、移除 query/hash 后的基础地址、测试状态、模型模式/覆盖值和凭据配置状态。`status` 会展示 Supervisor PID/启动时间、Worker phase/PID/generation/listening/in-flight 状态、当前提供商、Codex 状态、固定的 `OpenAI` 身份和 `15100` 代理地址，而不是只输出笼统提示。动态终端文本会限制长度并转义控制字符、escape 和双向文本控制符；凭据引用、额外请求头和完整密钥绝不展示。

根帮助使用对齐的命令说明，并统一展示 usage、options 和 examples。每个受支持的一级命令、`provider` 命令组及每个 provider action 都支持精确位置的 `-h`/`--help`；帮助在本地解析，不会启动或发现 Supervisor。帮助标志只在准确的 argv 位置生效，尾随或错位输入仍返回校验错误，不会被静默忽略。

`crp stop` 只停止监听 `127.0.0.1:15100` 的代理 Worker；Supervisor 和 `127.0.0.1:15101` 管理 API 会继续运行。需要停止 Worker 并完全退出 Supervisor 时使用 `crp shutdown`。因此 `stop` 后 Supervisor 仍在运行是预期行为，详细的 `status` 输出会区分这两个进程。

人类可读成功文案也保持这些区别：`shutdown` 明确确认 Supervisor 和 Worker 都已停止。`crp start` 会用稳定阶段标识失败：`supervisor_start`、`codex_bootstrap` 或 `proxy_start`；Codex 未 ready 时，`restart` 也会先执行必需的 bootstrap。显式 activation/start/restart 和 Worker 崩溃自动恢复共用同一个 FIFO Codex readiness gate。bootstrap 失败或仍 pending 时不会继续生命周期修改。配置一旦成功发布，后续不确定性不会回滚：有历史写集时保留 pending journal，无历史写集时单独报告 config-only committed-degraded，且不谎称存在 pending repair。

Detached Supervisor 启动只使用一次性、严格白名单化的 IPC 错误。获准的迁移输入错误会在就绪超时前返回；畸形、未知或未获准的子进程消息统一转为通用 `SUPERVISOR_START_FAILED` 契约。

原兼容别名 `crp init`、`crp install` 和 `crp setup` 已删除。它们会在本地以 `CLI_COMMAND_REMOVED` 失败，不发现 Supervisor、不执行任何修改，并提示改用 `crp ui` 或 `crp start`。`check`、`capture on|off|status`、`guide` 和已弃用的本地入口命令 `install-cli` 仍可用；CLI 依然没有 provider update、Activity、Settings 或 diagnostics 操作。

`crp provider add` 要求使用只写的 `--api-key` 参数，并支持高级鉴权和路由选项。可选 `--model` 只作为测试输入；路由覆盖仍使用 `--model-mode override --model-override <MODEL>`。提供 `--model` 时，CRP 会先保存 provider，再执行 Responses 兼容性测试。这两个阶段有意不组成单一事务：兼容性结果失败或测试操作发生错误，都不会删除已保存的 provider，用户可以查看后重试。命令行密钥可能出现在 shell 历史或进程检查中，因此该路径仅适合受控自动化。

`provider test`、`activate`、`delete` 和 `models` 必须且只能提供一个选择器：`--id` 或 `--name`。名称通过公开 provider 列表做精确的大小写不敏感匹配。`provider models` 会向 `<base-url>/models` 发起带鉴权、禁止重定向的刷新；Admin API 另提供独立的缓存读取。模型发现有界，并会在进入缓存或输出前拒绝任何包含完整 credential 的模型 ID。它独立于 Responses 兼容性测试，因此模型端点缺失或不兼容不会修改 provider 的测试或激活状态，刷新失败也不会清除最后一次成功目录。

CLI 发起的兼容性测试（包括 `provider add --model`）只会在当前没有 Provider 时请求首次选中，普通 Web Providers 页面现在也会发出同样的请求。第一个成功候选在 Worker 已停止时通过原子 compare-and-set 胜出。选中只写入 `activeProviderId`，绝不会启动或重新配置 Worker，也不会调用受 readiness gate 保护的显式 activation 路由；界面会刷新服务端状态确认结果。仍需显式运行 `crp start`。未提供 `activateIfNone` 的 Admin 调用继续保持不自动选中。条件式 Web Setup 同样会选择该行为，并按 `保存 Provider -> 测试并 CAS 选中 -> 配置 Codex/修复历史 -> 启动 Worker` 执行。

## 从 0.2.2 升级

`0.3` 系列会在 Supervisor 首次启动时，把 pre-supervisor 扁平配置迁移到 provider registry schema 2。

1. 停止旧的托管代理。
2. 私下备份 `~/.codex-remote-proxy/` 和 `~/.codex/config.toml`；所有备份都应视为包含敏感信息。
3. 运行 `crp ui`。
4. 检查迁移得到的 `Default` 提供商，运行兼容性测试，并且只在测试通过后激活。

如果存在旧的 `config.json` 和运行时 `node/proxy-config.json`，迁移会读取它们。CRP 先创建防碰撞、字节完全一致的私有备份，再通过必需的原生凭据后端保存凭据，创建未激活且未测试的 schema-2 提供商，验证已经提交的 registry，最后才从旧文件中清除密钥字段。备份会保留。

如果多个旧配置源包含不同凭据，迁移会在创建备份、访问凭据存储、写入 registry 或修改任一源文件之前返回 `MIGRATION_INPUT_INVALID`。CRP 不会自动选择其中一个凭据；该冲突只能在经过操作员审查的真实 HOME 迁移中解决。

如果事务在提交前失败，CRP 会尝试恢复原始字节，并且只删除能够证明属于本次事务的 registry 与凭据状态；外部替换的文件不会被删除。出现 `MIGRATION_COMMITTED_DEGRADED`、`MIGRATION_COMMITTED_LOCK_DEGRADED` 或 `MIGRATION_ROLLBACK_DEGRADED`，表示最终状态不确定或需要修复：停止 CRP，不要连续重试，保留备份，并在修改文件前查看 Activity 中已脱敏的错误码。处于降级状态时，CRP 不会擅自用备份自动覆盖当前状态。

回退到 `0.2.2` 不是 schema 降级。必须先停止 CRP，再把完整的升级前私有备份作为一个整体恢复；不要只把密钥复制回某一个旧文件，也不要混用 schema-2 registry 与扁平配置。真实 HOME 上的迁移和回退仍属于 L3 操作，需要对应平台的人工审查。

## 开发验证

开发版 CLI 有两种用途不同的运行方式：

```bash
# 生产路径冒烟验证：读取真实 ~/.codex；执行写操作时也会修改真实
# ~/.codex 和 ~/.codex-remote-proxy。
cd node
npm run dev:cli -- check --json

# 普通确定性测试继续使用隔离目录，不得触碰真实 HOME。
npm test
```

如果通过 `runCli(..., { paths: getPaths(tempHome) })` 调用 CLI，包括之前
定义的本地 `crpdev` shell 包装器，那么 Supervisor、Provider registry 和
Codex bootstrap 都会有意作用于该临时 HOME。它适合安全测试 UI 与 CLI
功能，但不能证明真实 `~/.codex` 已被修改。只有在真实 HOME 操作得到明确
授权时，才使用 `npm run dev:cli -- <command>` 这个直接入口；现有配置迁移或
历史修复前必须完全退出 Codex。

```bash
cd node
npm ci
npm run lint
npm run typecheck:ui
npm run build:ui
npm run verify:ui-build
npm test
node scripts/run-test-group.mjs core-chain
npm run test:e2e -- --project=chromium --workers=1
npm audit --omit=dev
npm pack --dry-run --json --ignore-scripts
```

测试只使用临时 HOME、合成凭据、注入适配器和 loopback 模拟上游。不要让 Supervisor 启动或迁移测试操作真实 HOME。

串行 `core-chain` 门禁会覆盖真实 CLI、Admin 服务、registry/provider service、WorkerManager、fork 出的代理 Worker、固定端口、存在进行中请求时的提供商切换、重启、关闭和密钥扫描。该门禁会有意替换为内存凭据适配器和 loopback 上游，因此不能证明原生凭据读取或真实外部提供商链路。

M2E/V8 最终本地验证通过 exact `npm test` 463/463（`412` unit-core + `8` 隔离 capture + `42` 普通 integration + `1` 串行 core-chain）、Metrics 存储聚焦 6/6、33 个源文件 lint、UI 类型检查/构建/精确三文件同步验证、精确 33 文件白名单 package-content 3/3、Chromium 33/33（包含英中双语 1440/1024/390 响应式矩阵）、完整与生产依赖审计 0 漏洞，以及 `design-qa.md` 中的同状态视觉对比。测试不得触碰真实 Codex 历史、凭据或外部 provider；本机 macOS D2 原生 Keychain/真实上游结果仅是其已审查代码树的历史证据。

Supervisor 发现使用有界的 2 秒探活，普通 Admin 操作另用 30 秒超时，因此已经成功的 provider test 不会再被误报为 `SUPERVISOR_UNAVAILABLE`。代理目标通过结构化方式拼接，无论 base URL 是否带尾斜杠都只产生一个路径分隔符。

发布准备及仍待完成的外部门禁见 [node/RELEASING.md](./node/RELEASING.md)。
