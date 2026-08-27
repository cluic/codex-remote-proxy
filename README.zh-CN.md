![Codex Remote Proxy Banner](./assets/banner.png)

# Codex Remote Proxy 中文文档

Codex Remote Proxy（CRP）让 Codex 保持 ChatGPT 登录态，同时把模型请求调度到带权重的 OpenAI 兼容提供商池。Codex 始终使用内置的 `OpenAI` 提供商身份，因此调整上游优先级不会改变已有 OpenAI 线程的归属。

[English](./README.md)

> 发布状态：以 npm 的 `latest` dist-tag 为准。普通产品更新使用 patch 版本；minor 或 major 版本必须先明确调整发布策略。

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

`crp ui` 会启动或发现本地 Supervisor，并打开管理界面。已保存的明确语言选择优先；否则按浏览器/系统语言偏好选择第一个受支持的中文或英文，均不匹配时默认英文。推断出的语言不会写入浏览器存储。

当前开发版界面使用 `node/ui-src/` 中的 React、TypeScript 与 Vite 实现。这些工具只参与构建；发布包和 Admin Server 仍然只交付 `ui/index.html`、`ui/app.js` 与 `ui/styles.css`，不需要前端运行时服务器，也不包含远程字体、CDN、遥测、source map 或动态 chunk。

## 可以管理什么

本地管理界面覆盖完整的日常流程：

- 创建具名提供商；
- 使用持续维护的内置预设（当前包含 `https://openrouter.ai/api/v1` 的 OpenRouter），或选择自定义 OpenAI 兼容端点；
- 通过只写输入框填写凭据；
- 测试 OpenAI Responses API 兼容性；
- 为每个提供商设置优先级权重，并指定同权重时优先使用的首选提供商；
- 创建可复用的精确模型映射规则组，并为每个提供商选择一个规则组；不选择时默认透传；
- 创建路由规则组，让每条规则把一个或多个精确请求模型分配到同一提供商优先顺序；
- 配置每个提供商的模型获取路径，补充缺失模型，并逐个删除手工条目、启用或停用模型；
- 遇到可重试的 `429`、指定 `5xx`、超时、连接重置或明确网络故障时让提供商进入冷却，并且仅在尚未建立上游连接时回放有界 Responses 请求；
- 在运行中热编辑提供商元数据或凭据，并在仍有其他已测试路由时删除提供商；
- 创建、停用、编辑和删除客户端 API Key，并可设置到期时间及生命周期请求次数上限；
- 在回环监听时选择无密钥访问或热开启客户端鉴权，并在 Worker 停止后选择监听 `127.0.0.1` 或 `0.0.0.0`；
- 启动、停止、重启和查看代理 Worker；
- 通过可交互的总览趋势分析器查看匿名的 24 小时或 7 天请求、结果、已观测 Token、模型、Provider 与有界延迟 Metrics；
- 在总览中选择精确模型，追踪实时账号门控、命中的路由规则、提供商顺序、模型改写、预测出口和条件式回退；
- 查看包含请求/转发模型元数据的转发记录、已观测 Token 数与客户端中止请求，并在该页面控制可选 Capture；
- 查看提供商、路由、Capture、迁移和模型映射操作对应的本地化、已脱敏活动名称；
- 在紧凑的系统页配置登录时启动、路由、Codex 集成、运行时信息和诊断；
- 生成只包含创建状态、生成时间和已脱敏事件数量的内存诊断摘要。

总览会展示本机 Codex 的 ChatGPT 鉴权模式、订阅类型，以及实际返回的归一化额度窗口；系统页只保留紧凑的账号与路由状态。已知 5 小时和 7 天窗口会显示友好名称，但不会为缺失窗口伪造数据或预留空间。账号快照每五分钟自动刷新，也可以手动刷新。登录启动的 Supervisor 在查找 `codex` 时会自动把当前 Node 可执行文件目录加入 `PATH`，不再依赖交互式 Shell。无效的 `model_catalog_json`、无效 Codex 配置和找不到 Codex 命令会分别显示安全错误码与处理建议；自定义 Provider 路由仍可正常工作。

路由默认保持 `custom_only`。在总览或系统页开启 `account_first` 后，运行中的 Worker 会热更新，无需重启。只有 `POST /responses` 和 `POST /v1/responses` 可以优先使用 ChatGPT 账号；账号不可用或明确限流时进入自定义提供商池。启用的路由规则组中，每条规则可以让多个精确请求模型共享同一提供商顺序；未命中的模型以及未列出的备用提供商仍按权重排序。模型启停会在该候选完成模型映射后判断：默认启用新模型时，精确停用项会被排除；默认停用时，只有精确启用项可参与路由。健康冷却始终优先。一旦请求可能已经送达，自定义 POST 就不会被自动回放。只有在上游连接尚未建立时失败的有界 Responses 请求，才会在同一请求内安全转移。非 Responses 请求绝不会回放，回放缓冲上限为 8 MiB。

总览的路由预演直接复用上述决策链，不会在浏览器中猜测路由，并假设请求是带账号请求头的常规 Codex `POST /responses`。Worker 运行时，它通过私有 IPC 读取实时代数、提供商冷却、模型可用性和调度顺序；Worker 停止时则明确标记为仅按配置生成的快照。看板会区分当前主路径和 ChatGPT/自定义条件回退，并把最后一站称为“预测出口”，因为安全重试或只影响后续请求的冷却仍可能改变实际目的地。已认证的只读接口为 `GET /api/v1/routing-preview?model=<精确模型名>`，只返回有界路由元数据。

系统页可在无需管理员权限的情况下开启“登录时启动”。CRP 会写入一个带项目标记、属于当前用户的 macOS LaunchAgent、Linux systemd user unit 或 Windows Startup 命令，并在下次登录时使用同一 `CRP_HOME` 启动已安装 CLI。如果 Node 或包安装路径随后变化，系统页会把受管启动项标记为过期，用户可以明确修复或停用。停用只会通过已校验身份的文件描述符把受管 inode 改写为惰性配置，不会以存在竞态的方式删除保留路径或 Linux wants 链接。保留路径上如果已有外部普通文件、链接或其他不安全对象，页面会显示冲突；CRP 不会覆盖或删除它，也不会借机修改共享启动目录的权限。

Worker 监听 `127.0.0.1` 时，客户端 API Key 鉴权可自由开启或关闭；监听 `0.0.0.0` 时则强制开启，公网监听状态下不能关闭。鉴权开关可以热应用到运行中的 Worker，修改监听地址则必须先停止 Worker。客户端推荐使用独立的 `x-crp-api-key` 请求头。系统也接受生成型 CRP Key 使用 `Authorization: Bearer crp_...`，但该形式会被当作 CRP 鉴权消费，因此只走自定义提供商路由；独立请求头不会与 ChatGPT 或上游鉴权混淆，所以更推荐。每次鉴权成功都会原子消耗该 Key 的一次生命周期请求额度；已停用、已过期、已耗尽、未知或已删除的 Key 都会在进入路由前被拒绝。

全接口监听只允许通过受管 Supervisor/System 路径配置。旧版 standalone JSON 运行器没有客户端 Key 管理面，因此继续强制只监听 `127.0.0.1`。

完整客户端 Key 只在创建时接收，服务端只把 SHA-256 摘要写入私有的 `access-keys.sqlite3`，Admin API 绝不返回原值；界面只显示有界提示与生命周期元数据。CRP 会为本机 Codex 自动维护一个独立、仅允许回环连接使用的私有令牌，它不消耗客户端 Key 额度；两个访问请求头在转发上游前都会被移除，Codex 代理地址仍固定为 `127.0.0.1:15100`。监听 `0.0.0.0` 会在所有网卡上暴露未加密 HTTP 服务，只应部署在可信网络边界内，或另行配置 TLS 反向代理和防火墙。

`转发记录` 已是完整的元数据页面，并以 Supervisor 设置作为唯一运行时开关；旧版 standalone 配置不会再把它静默关闭。页面会展示 Capture 是否实际生效，并区分“已观测、上游未返回、协议未识别、不适用、历史版本未记录”。新记录会同时保存请求模型与实际转发模型，因此精确映射和 Provider override 会显示为 `请求模型 → 转发模型`；模型名可搜索，旧记录保持为空。表格会省略重复的本地地址前缀，仅显示路径与查询参数，详情仍保留完整入口和目标地址。以 `/models` 结尾的 Codex 模型目录请求默认隐藏，可通过页面开关显示；该过滤会在摘要计数和游标分页之前执行。OpenAI 的 `response.completed` 与 OpenRouter 的 `response.done` SSE 终止事件都会被识别，且不改写任何转发字节。已经观测到语义完成后客户端再关闭仍记为成功，真正发生在完成前的关闭才记为“中止”。API 只展示时间、路由/提供商、受限模型名、路径、字节数、状态、ID、Token、观测状态与已脱敏错误，绝不会返回正文和鉴权请求头。

总览 Metrics 仍是独立的匿名聚合状态。趋势分析器可在请求/Token、数量/占比以及输入/输出/总 Token 之间切换，支持鼠标和键盘查看精确时间桶；Token 未观测时显示断点而不是伪造为 0。服务可靠率会从分母中排除客户端中止。模型列表可展开并单独展示未知/归组请求；提供商表格会展示 API 返回的全部受限维度行，不再静默只保留前几项。

调整首选提供商、权重、提供商配置、模型范围、模型映射或当前路由规则组都只影响新请求；正在处理的请求继续使用其开始时捕获的完整快照。`passthrough` 模式保留客户端模型；`override` 模式只替换 JSON 顶层 `model` 值。运行中修改会先持久化候选 registry，再应用并健康确认严格递增的 Worker 快照；确认失败时恢复旧 registry，并用更新一代的回滚快照恢复 Worker。删除首选提供商时会自动选择权重最高的已测试备用提供商；运行中删除最后一个已测试路由会被拒绝，停止 Worker 后则允许。实时兼容性测试失败不会让正在使用的快照失效。首次选中仍使用 first-wins compare-and-set，并保持 Worker 停止。

模型映射规则组采用区分大小写的精确来源模型名。每个提供商可以选择一个可复用规则组，或留空继续透传；规则组与旧的单模型覆盖互斥。映射按自定义提供商候选分别解析，因此故障转移时，新候选会针对原始客户端模型应用自己的规则组，不会继承失败提供商的映射结果。未命中的模型保持原样，ChatGPT 账号路由也不会被改写。已分配规则组可通过同一套确认式热应用路径直接编辑；仍分配给任一提供商的规则组不能删除。

代理透传会按背压流式转发请求和响应字节，不会自动解压请求体。模型覆盖和精确映射都只在 8 MiB 有界范围内改写 JSON；发生改写时会尽可能保留 gzip、deflate、Brotli 和原生 zstd 编码，并移除已经失效的正文完整性/签名头。Node 没有原生 zstd 压缩能力时，经过验证的单帧 zstd 改写请求会以 identity 转发；无需改写且无法安全检查的 zstd 帧仍保持字节完全一致。客户端取消连接会终止对应的上游工作。

可选 Capture 内部对请求体和响应体各自最多保存 1 MiB，同时保留实际观测总字节数；转发记录 API 只投影元数据。存在已配置保护值时，截断正文、已声明或检测到的压缩正文，以及包含明文或可恢复编码保护值的正文都会记录为 `empty-truncated`；能够完整筛查的文本/二进制记录仍使用明确的 UTF-8/base64 编码。配置的 API key 和额外请求头值不会进入 Capture header、正文、URL/ID 元数据或 debug 日志。Metrics 的缓冲正文检查独立限制为 8 MiB，SSE 使用有界事件做增量检查，两者都不会隐式开启 Capture。

## 固定的 Codex 配置

CRP 只需引导配置一次，并持续保持以下不变量：

```toml
model_provider = "OpenAI"
```

```text
http://127.0.0.1:15100
```

提供商切换发生在 CRP 内部。日常切换时不要为每个上游创建不同的 Codex `model_provider`，也不要修改固定代理地址。

开启客户端 Key 鉴权后，CRP 会在固定 Codex Provider 配置中维护私有的 `x-crp-local-token` 静态请求头。该头只接受回环来源，并会在任何上游请求前移除；它与 `requires_openai_auth` 相互独立，因此 `account_first` 路由仍可继续使用 ChatGPT 身份。

在全新 HOME 中，显式运行 `crp start` 会私有且原子地创建缺失的 `.codex` 目录和 `config.toml`，不会为原本不存在的文件创建备份。在支持的 POSIX 系统上，新目录权限为 `0700`，新文件权限为 `0600`。再次执行引导会保持文件字节完全不变。已有配置只有在内容确需改变时才会生成相邻私有备份，其无关设置、换行符和权限都会保留。

修改已有的 Codex 层 provider 绑定前，必须先完全退出 Codex。Bootstrap 会从同一份加锁配置快照读取根 `model_provider` 及其受支持的 `base_url` 绑定。无效 UTF-8 或 selected-provider 绑定畸形/歧义会在备份、journal 和配置写入前失败；该 scanner 只校验相关绑定，不是完整 TOML validator。有效 URL 不同或缺失时才发现历史写集；只有非空写集会创建私有 rollout 快照、排他 SQLite 逻辑备份和 `.codex/.crp-history-repair` 前向恢复 journal，已对齐的历史走无 journal 的 config-only 提交。随后 CRP 发布固定配置，并只修改 active/archive rollout 中 `session_meta` 的 provider 元数据及受支持 SQLite 中的 `threads.model_provider`。修复 pending 或存在 config lock 时 Codex 都不是 ready，provider activation、Worker start/restart 和崩溃自动恢复都会被阻止；下一次 bootstrap 会继续修复。加密历史内容绝不会被改写；CLI 会输出静态警告，因为部分加密消息仍可能不可用。

CRP 内部的 provider add/test/activate/热切换绝不会触发该修复。按照仅比较 URL 的触发要求，如果 provider 名改变但有效 URL 相同，则不会重写历史元数据；迁移这类自定义布局需要单独人工审查。受管配置/历史备份可能包含本地私有状态，必须按原 Codex 目录同等保护。

## 凭据安全

公开 Supervisor 必须通过服务名 `org.cluic.codex-remote-proxy` 使用操作系统原生凭据存储：

- macOS Keychain；
- Windows Credential Manager；
- Linux 上兼容的 Secret Service。

如果原生后端无法构造或后续失败，公开启动与凭据操作会直接失败。当前 UI、CLI 和 Admin API 都没有文件存储授权或选择控件。底层私有文件适配器只允许受信任的依赖注入使用；公开 startup consent 属于未来 L3 工作，原生操作绝不会重放到该适配器。

界面不会读回已保存的 Provider 凭据或客户端 API Key。编辑时密钥输入框始终为空，完整客户端 Key 会被替换为单向摘要，不会出现在 API 读取结果、Activity、诊断、Capture 或日志中。ChatGPT access token、邮箱和 account ID 同样不会进入公开 status/settings 响应、Activity、Metrics、Capture 或日志。所有发往自定义 Provider 的请求都会移除账号鉴权头，自定义 API key 和额外请求头也绝不会发送到 ChatGPT。

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
crp language [en|zh-CN] [--json]
crp -v | crp --version
crp version [--json]
crp update [--check] [--json]
crp provider presets [--json]
crp provider list [--json]
crp provider add (--preset <ID> | --name <NAME> --base-url <URL>) --api-key <KEY> [--model <MODEL>] [--json]
crp provider models (--id <ID> | --name <NAME>) [--json]
crp provider test (--id <ID> | --name <NAME>) --model <MODEL> [--json]
crp provider activate (--id <ID> | --name <NAME>) [--json]
crp provider delete (--id <ID> | --name <NAME>) [--json]
```

正式推荐的入口只有两个：普通设置和日常管理使用 `crp ui`，无界面 CLI 启动使用 `crp start`。`ui` 会启动或发现 Supervisor 并打开管理页面；`start` 会启动或发现 Supervisor、引导固定的 Codex 配置，并启动代理 Worker。

所有 CLI 人类可读路径都支持 English 和简体中文。全新安装默认显示英文，不再根据 `LANG`、`LC_ALL` 或 `LC_MESSAGES` 自动切换。运行 `crp language zh`（或 `crp language zh-CN`）可把后续命令持久切换为简体中文，运行 `crp language en` 可切回英文。`CRP_LOCALE` 可以在单个进程环境中覆盖已保存选择，命令行任意位置的全局 `--locale en|zh-CN` 则只对本次调用生效且始终优先。语言只影响人类可读输出；使用 `--json` 时，失败不会写入 stdout，并且只向 stderr 写入一个语言无关的错误文档。

## 许可证

本项目采用 [MIT License](./LICENSE)。

不使用 `--json` 时，`provider list` 会展示提供商数量，以及每个提供商的当前标记、名称、ID、移除 query/hash 后的基础地址、测试状态、模型模式/覆盖值或映射规则组 ID，以及凭据配置状态。`status` 会展示 Supervisor PID/启动时间、Worker phase/PID/generation/listening/in-flight 状态、当前提供商、Codex 状态、固定的 `OpenAI` 身份和 `15100` 代理地址，而不是只输出笼统提示。动态终端文本会限制长度并转义控制字符、escape 和双向文本控制符；凭据引用、额外请求头和完整密钥绝不展示。

根帮助使用对齐的命令说明，并统一展示 usage、options 和 examples。每个受支持的一级命令、`provider` 命令组及每个 provider action 都支持精确位置的 `-h`/`--help`；帮助在本地解析，不会启动或发现 Supervisor。帮助标志只在准确的 argv 位置生效，尾随或错位输入仍返回校验错误，不会被静默忽略。

`crp stop` 只停止配置在 `15100` 端口的代理 Worker；Supervisor 和 `127.0.0.1:15101` 管理 API 会继续运行。需要停止 Worker 并完全退出 Supervisor 时使用 `crp shutdown`。因此 `stop` 后 Supervisor 仍在运行是预期行为，详细的 `status` 输出会区分这两个进程。

人类可读成功文案也保持这些区别：`shutdown` 明确确认 Supervisor 和 Worker 都已停止。`crp start` 会用稳定阶段标识失败：`supervisor_start`、`codex_bootstrap` 或 `proxy_start`；Codex 未 ready 时，`restart` 也会先执行必需的 bootstrap。显式 activation/start/restart 和 Worker 崩溃自动恢复共用同一个 FIFO Codex readiness gate。bootstrap 失败或仍 pending 时不会继续生命周期修改。配置一旦成功发布，后续不确定性不会回滚：有历史写集时保留 pending journal，无历史写集时单独报告 config-only committed-degraded，且不谎称存在 pending repair。

Detached Supervisor 启动只使用一次性、严格白名单化的 IPC 错误。获准的迁移输入错误会在就绪超时前返回；畸形、未知或未获准的子进程消息统一转为通用 `SUPERVISOR_START_FAILED` 契约。

原兼容别名 `crp init`、`crp install` 和 `crp setup` 已删除。它们会在本地以 `CLI_COMMAND_REMOVED` 失败，不发现 Supervisor、不执行任何修改，并提示改用 `crp ui` 或 `crp start`。`check`、`capture on|off|status`、`guide` 和已弃用的本地入口命令 `install-cli` 仍可用；CLI 依然没有 provider update、Activity、Settings 或 diagnostics 操作。

`crp provider presets` 会列出持续维护的公开默认值。`crp provider add --preset openrouter --api-key <KEY>` 使用正确的 OpenRouter `/api/v1` 基础地址和 Bearer 认证，凭据仍保持只写。自定义 add 与高级鉴权/路由选项继续可用；`--model` 只作为测试输入。命令行密钥可能出现在 shell 历史或进程检查中，因此该路径仅适合受控自动化。

`-v` 和 `--version` 只输出已安装版本，不发现或启动 CRP。`crp version` 会核对已安装包与运行中 Supervisor 的版本。`crp update --check` 只查询 npm；`crp update` 仅允许在已验证的全局 npm 安装中执行，先完成安装，再只关闭安装前确认的同一个 Supervisor，最后恢复更新前 Supervisor/Worker 是否运行。如果新版本无法恢复运行状态，CRP 会重新安装旧版本并恢复原状态，然后返回 `UPDATE_ROLLED_BACK`；回滚本身失败才返回带明确手动恢复命令的 `UPDATE_RECOVERY_FAILED`。源码目录和 `npx` 缓存不会被原地修改，而会收到明确的全局安装提示。

`provider test`、`activate`、`delete` 和 `models` 必须且只能提供一个选择器：`--id` 或 `--name`。名称通过公开 provider 列表做精确的大小写不敏感匹配。`provider models` 会从提供商已配置的发现路径发起带鉴权、禁止重定向的刷新；默认把 `/models` 追加到基础地址，Admin API 和 Web UI 可以修改该路径并单独读取缓存结果。模型发现有界，并会在进入缓存或输出前拒绝任何包含完整 credential 的模型 ID。它独立于 Responses 兼容性测试，因此模型端点缺失或不兼容不会修改 provider 的测试或激活状态，刷新失败也不会清除最后一次成功目录。

CLI 发起的兼容性测试（包括 `provider add --model`）只会在当前没有 Provider 时请求首次选中，普通 Web Providers 页面现在也会发出同样的请求。第一个成功候选在 Worker 已停止时通过原子 compare-and-set 胜出。选中只写入 `activeProviderId`，绝不会启动或重新配置 Worker，也不会调用受 readiness gate 保护的显式 activation 路由；界面会刷新服务端状态确认结果。仍需显式运行 `crp start`。未提供 `activateIfNone` 的 Admin 调用继续保持不自动选中。条件式 Web Setup 同样会选择该行为，并按 `保存 Provider -> 测试并 CAS 选中 -> 配置 Codex/修复历史 -> 启动 Worker` 执行。

## 从 0.2.2 升级

当前版本会在 Supervisor 首次启动时，把 pre-supervisor 扁平配置迁移到 provider registry schema 8。已有且有效的 schema-2 至 schema-7 registry 会先备份再原子升级；schema-2/schema-3 提供商获得中性的默认权重 `100`，后续 schema 的权重以及 schema-5 模型映射会保留。Schema-6 的单模型规则会变成只含一个模型的集合，自动/自定义模型范围会分别迁移为等价的“新模型默认启用/默认停用”，原有自定义白名单会成为已启用的手工模型。Schema-7 安装会迁移为回环监听且客户端 Key 鉴权关闭，从而保持原访问边界不变。原有路由和 Capture 设置保持不变。Schema 检查与替换同时持有迁移锁和常规 ProviderRegistry 写锁，并在报告成功前 fsync 备份及发布目录项。

1. 停止旧的托管代理。
2. 私下备份 `~/.codex-remote-proxy/` 和 `~/.codex/config.toml`；所有备份都应视为包含敏感信息。
3. 运行 `crp ui`。
4. 检查迁移得到的 `Default` 提供商，运行兼容性测试，并且只在测试通过后激活。

如果存在旧的 `config.json` 和运行时 `node/proxy-config.json`，迁移会读取它们。CRP 先创建防碰撞、字节完全一致的私有备份，再通过必需的原生凭据后端保存凭据，创建 `custom_only` 模式、权重 `100`、回环监听、客户端 Key 鉴权关闭、未激活、未测试、默认 `/models` 获取路径、新模型默认启用且映射/路由规则组为空的 schema-8 provider registry，验证已经提交的 registry，最后才从旧文件中清除密钥字段。备份会保留。schema-2 至 schema-7 升级也会保留字节完全一致的备份；验证或发布失败时恢复原始字节。

如果多个旧配置源包含不同凭据，迁移会在创建备份、访问凭据存储、写入 registry 或修改任一源文件之前返回 `MIGRATION_INPUT_INVALID`。CRP 不会自动选择其中一个凭据；该冲突只能在经过操作员审查的真实 HOME 迁移中解决。

如果事务在提交前失败，CRP 会尝试恢复原始字节，并且只删除能够证明属于本次事务的 registry 与凭据状态；外部替换的文件不会被删除。出现 `MIGRATION_COMMITTED_DEGRADED`、`MIGRATION_COMMITTED_LOCK_DEGRADED` 或 `MIGRATION_ROLLBACK_DEGRADED`，表示最终状态不确定或需要修复：停止 CRP，不要连续重试，保留备份，并在修改文件前查看 Activity 中已脱敏的错误码。处于降级状态时，CRP 不会擅自用备份自动覆盖当前状态。

回退到 `0.2.2` 不是 schema 降级。必须先停止 CRP，再把完整的升级前私有备份作为一个整体恢复；不要只把密钥复制回某一个旧文件，也不要混用 schema-8 registry 与扁平配置。真实 HOME 上的迁移和回退仍属于 L3 操作，需要对应平台的人工审查。

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

发布证据必须包含 lint、UI 类型检查/构建/精确三文件同步验证、确定性 Node 测试、Chromium 英中双语响应式矩阵、精确发布包白名单、生产依赖审计，以及 `design-qa.md` 中的视觉对比。确定性 fixture 不代表真实 Codex 历史、原生凭据、登录启动执行或外部 provider 证据；这些仍属于对应发布代码树的平台/人工门禁。

Supervisor 发现使用有界的 2 秒探活，普通 Admin 操作另用 30 秒超时，因此已经成功的 provider test 不会再被误报为 `SUPERVISOR_UNAVAILABLE`。代理目标通过结构化方式拼接，无论 base URL 是否带尾斜杠都只产生一个路径分隔符。

发布准备及仍待完成的外部门禁见 [node/RELEASING.md](./node/RELEASING.md)。
