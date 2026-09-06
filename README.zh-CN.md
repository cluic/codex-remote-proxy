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

管理界面使用 `node/ui-src/` 中的 Next.js App Router、React、TypeScript、Tailwind CSS、基于 Base UI 的 shadcn 源码组件和 Lucide 图标实现。默认 Webpack 构建会在 `node/ui/` 生成经过审核的静态导出及资源清单；发布包不需要前端运行时服务器，Admin Server 从同一个回环来源提供全部页面和 chunk。界面不包含远程字体、CDN、遥测或 source map。干净的 Ubuntu Node 22 是规范构建环境：发布门禁会在任何候选构建覆盖 `node/ui/` 前，将其生成结果与 checkout 比较。Linux、macOS 和 Windows 会校验已提交的源摘要、清单、CSP、资源、package allowlist 及各自的平台测试。

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
- 在总览中查看匿名的 24 小时或 7 天请求、结果、模型、Provider 与有界延迟 Metrics，以及最近 12 周的每日已观测 Token 热力图；
- 在总览中选择精确模型，追踪实时账号门控、命中的路由规则、提供商顺序、模型改写、预测出口和条件式回退；
- 在紧凑的转发记录中扫描模型、结果、提供商、耗时和已观测 Token；保留列表位置打开请求详情，并分别控制元数据与详情采集；
- 查看提供商、路由、Capture、迁移和模型映射操作对应的本地化、已脱敏活动名称；
- 在紧凑的系统页配置登录时启动、路由、Codex 集成、运行时信息和诊断；
- 生成只包含创建状态、生成时间和已脱敏事件数量的内存诊断摘要。

总览会展示本机 Codex 的 ChatGPT 鉴权模式、订阅类型，以及实际返回的归一化额度窗口；系统页只保留紧凑的账号与路由状态。已知 5 小时和 7 天窗口会显示友好名称，但不会为缺失窗口伪造数据或预留空间。账号快照每五分钟自动刷新，也可以手动刷新。登录启动的 Supervisor 在查找 `codex` 时会自动把当前 Node 可执行文件目录加入 `PATH`，不再依赖交互式 Shell。无效的 `model_catalog_json`、无效 Codex 配置和找不到 Codex 命令会分别显示安全错误码与处理建议；自定义 Provider 路由仍可正常工作。

路由默认保持 `custom_only`。在总览或系统页开启 `account_first` 后，运行中的 Worker 会热更新，无需重启。决策会同时识别接口、请求格式和模型：`POST /responses` 接受非直接图片模型，`POST /images/generations` 和 `POST /images/edits` 只接受 `gpt-image-*` 直接图片模型。标准路径和 `/v1` 路径都会映射到 ChatGPT Codex 账号 base 下的对应接口，Image Edits 会映射到 `/backend-api/codex/images/edits`。CRP 同时接受 Codex 客户端的 `application/json` 编辑载荷与公开 Image API 的标准 `multipart/form-data` 格式。JSON 预检只读取顶层 `model`；图片 URL、Base64、query、headers、Content-Length 和请求/响应字节均保持不变。Multipart 预检严格解析唯一、非文件型的 `model` 字段，绝不解码二进制 part。不支持的 edits Content-Type 返回 415 和 `unsupported_request_format`；缺失 JSON/multipart 模型返回 400 和 `model_not_detected`；非法 multipart 返回 400 和 `invalid_multipart`，这些错误都不会静默进入自定义池。账号预检仍以 8 MiB 为上限；更大的请求会在账号零投递前以 `account_body_too_large` 进入不依赖模型的自定义路径，若需要按精确模型选择 Provider 或 mapping/override，则返回 413 且不向任何上游投递。Image Edits 一旦投递便绝不重放，其 429 会原样返回并启动账号冷却，只有后续请求才会进入自定义池。账号网络失败、超时和投递状态不确定时绝不重放。

总览的路由预演直接复用上述决策链，不会在浏览器中猜测路由。它接受精确模型、接口类型和 `requestFormat=json|multipart|unsupported`；省略时仍兼容默认的 `responses + json`。Image Edits 会显示请求格式选择器，因此 JSON、multipart 和不支持格式的预演分别对应真实 account 路由或零投递 415。已认证的只读接口为 `GET /api/v1/routing-preview?model=<精确模型名>&operation=<接口类型>&requestFormat=<格式>`，只返回有界路由元数据。

系统页可在无需管理员权限的情况下开启“登录时启动”。CRP 会写入一个带项目标记、属于当前用户的 macOS LaunchAgent、Linux systemd user unit 或 Windows Startup 命令，并在下次登录时使用同一 `CRP_HOME` 启动已安装 CLI。如果 Node 或包安装路径随后变化，系统页会把受管启动项标记为过期，用户可以明确修复或停用。停用只会通过已校验身份的文件描述符把受管 inode 改写为惰性配置，不会以存在竞态的方式删除保留路径或 Linux wants 链接。保留路径上如果已有外部普通文件、链接或其他不安全对象，页面会显示冲突；CRP 不会覆盖或删除它，也不会借机修改共享启动目录的权限。

Worker 监听 `127.0.0.1` 时，客户端 API Key 鉴权可自由开启或关闭；监听 `0.0.0.0` 时则强制开启，公网监听状态下不能关闭。鉴权开关可以热应用到运行中的 Worker，修改监听地址则必须先停止 Worker。客户端推荐使用独立的 `x-crp-api-key` 请求头。系统也接受生成型 CRP Key 使用 `Authorization: Bearer crp_...`，但该形式会被当作 CRP 鉴权消费，因此只走自定义提供商路由；独立请求头不会与 ChatGPT 或上游鉴权混淆，所以更推荐。每次鉴权成功都会原子消耗该 Key 的一次生命周期请求额度；已停用、已过期、已耗尽、未知或已删除的 Key 都会在进入路由前被拒绝。

全接口监听只允许通过受管 Supervisor/System 路径配置。旧版 standalone JSON 运行器没有客户端 Key 管理面，因此继续强制只监听 `127.0.0.1`。

完整客户端 Key 只在创建时接收，服务端只把 SHA-256 摘要写入私有的 `access-keys.sqlite3`，Admin API 绝不返回原值；界面只显示有界提示与生命周期元数据。CRP 会为本机 Codex 自动维护一个独立、仅允许回环连接使用的私有令牌，它不消耗客户端 Key 额度；两个访问请求头在转发上游前都会被移除，Codex 代理地址仍固定为 `127.0.0.1:15100`。监听 `0.0.0.0` 会在所有网卡上暴露未加密 HTTP 服务，只应部署在可信网络边界内，或另行配置 TLS 反向代理和防火墙。

`转发记录` 是由本地 Capture 数据库提供的隐私受限请求账本，并以 Supervisor 设置作为唯一运行时来源；旧版 standalone 配置不能覆盖这些设置。列表接口仍然只返回元数据，桌面优先展示时间、模型/请求、结果、提供商、耗时与已观测 Token，窄屏使用记录卡片。完整 URL、ID、路由原因和采集载荷放在所选记录的详情对话框。HTTP 状态和请求最终结果分别展示：HTTP 200 后的流仍可能失败；没有记录具体失败原因时会明确说明，不推测原因。精确模型改写继续展示为 `请求模型 → 转发模型`，旧元数据保持可空，`/models` 目录请求默认隐藏。

已认证列表接口支持可选的 `since`/`until` 时间范围（规范 UTC ISO 格式 `YYYY-MM-DDTHH:mm:ss.sssZ`）、精确匹配请求或实际转发模型的 `model`、精确持久化提供商 ID `providerId` 与精确会话 ID `sessionId`。时间条件为 `started_at >= since` 且 `started_at < until`；同时提供两者时必须满足 `since < until`。精确文本筛选必须非空、无首尾空白和控制字符，最多 256 个 Unicode 码点。原有有界搜索、结果筛选和游标分页继续有效。各结果数量遵循目录可见性、时间、模型、提供商、会话和搜索条件，但不受当前结果选项及分页影响；旧记录缺少精确匹配字段时不算命中。刷新期间保留上次成功加载的列表。

Capture 初始化会建立只包含列表元数据的覆盖索引，让列表及统计查询避免扫描正文溢出页。对已有非空数据库，一次性建索引在独立后台线程执行，不再阻塞代理就绪。界面会显示索引准备状态：代理继续转发，但准备期间暂不采集新请求；已有历史保持不变，成功后自动恢复采集，页面自动观察完成状态，无需为此重启。关闭采集、切换待准备的数据库路径或关闭 Worker 会取消维护，新任务必须等待旧任务确认终止后再开始。空数据库可以立即初始化索引。只读查询绝不创建索引，旧数据库仍使用准确的兼容查询。记录与统计来自同一已提交读取快照，后续刷新可见新写入及删除，不使用可能过时的统计缓存。进入转发记录页不再请求无关的 Metrics 和 Token 热力图；这些数据在相应页面加载，且不阻塞工作区初始化。

元数据 Capture 与详细载荷 Capture 使用两个独立开关。详情采集默认关闭，只能在元数据 Capture 开启时启用；关闭元数据 Capture 会同时清除详情设置，因此重新开启元数据不会静默恢复正文采集。选择一行后才会通过已认证且禁止缓存的 `GET /api/v1/forwarding-records/:id` 加载详情，列表不会预取载荷。以详细模式采集的记录可以返回有界、经过隐私筛查的请求/响应 headers 与正文，并明确标注编码、实际观测字节数和截断状态。敏感请求头继续脱敏，保护值筛查保持 fail-closed，旧记录/未采集状态会明确显示，切换行时旧载荷会在新请求完成前立即清空。

总览 Metrics 仍是独立的匿名聚合状态。当前窗口的指标卡、模型列表和 Provider 表格继续使用 24 或 168 个 UTC 小时桶；另以紧凑日汇总保留 84 个 UTC 日，用 GitHub 风格热力图展示最近 12 周每日已观测 Token。鼠标悬停、点击或键盘聚焦任意日期都可查看输入、输出、总 Token 与请求覆盖率；有请求但完全未返回用量、仅部分请求返回用量、真实无流量三种状态会明确区分。小时与每日接口会彼此独立地处理失败；每日持久化降级时仍展示最新内存汇总，并明确提示风险。服务可靠率会从分母中排除客户端中止。模型列表可展开并单独展示未知/归组请求；提供商表格会展示 API 返回的全部受限维度行，不再静默只保留前几项。

调整首选提供商、权重、提供商配置、模型范围、模型映射或当前路由规则组都只影响新请求；正在处理的请求继续使用其开始时捕获的完整快照。`passthrough` 模式保留客户端模型；`override` 模式只替换 JSON 顶层 `model` 值。运行中修改会先持久化候选 registry，再应用并健康确认严格递增的 Worker 快照；确认失败时恢复旧 registry，并用更新一代的回滚快照恢复 Worker。删除首选提供商时会自动选择权重最高的已测试备用提供商；运行中删除最后一个已测试路由会被拒绝，停止 Worker 后则允许。实时兼容性测试失败不会让正在使用的快照失效。首次选中仍使用 first-wins compare-and-set，并保持 Worker 停止。

模型映射规则组采用区分大小写的精确来源模型名。每个提供商可以选择一个可复用规则组，或留空继续透传；规则组与旧的单模型覆盖互斥。映射按自定义提供商候选分别解析，因此故障转移时，新候选会针对原始客户端模型应用自己的规则组，不会继承失败提供商的映射结果。未命中的模型保持原样，ChatGPT 账号路由也不会被改写。已分配规则组可通过同一套确认式热应用路径直接编辑；仍分配给任一提供商的规则组不能删除。

代理透传会按背压流式转发请求和响应字节，不会自动解压请求体。模型覆盖和精确映射都只在 8 MiB 有界范围内改写 JSON；发生改写时会尽可能保留 gzip、deflate、Brotli 和原生 zstd 编码，并移除已经失效的正文完整性/签名头。Node 没有原生 zstd 压缩能力时，经过验证的单帧 zstd 改写请求会以 identity 转发；无需改写且无法安全检查的 zstd 帧仍保持字节完全一致。客户端取消连接会终止对应的上游工作。

开启详细 Capture 时，请求体和响应体各自最多保存 1 MiB，同时保留实际观测总字节数；关闭详情时，headers/正文内容保持为空，只记录元数据和字节总数。存在已配置保护值时，截断正文、已声明或检测到的压缩正文，以及包含明文或可恢复编码保护值的正文都会记录为 `empty-truncated`；能够完整筛查的文本/二进制记录使用明确的 UTF-8/base64 编码。配置的 API key 和额外请求头值不会进入 Capture headers、正文、URL/ID 元数据、详情响应或 debug 日志。Metrics 的缓冲正文检查独立限制为 8 MiB，SSE 使用有界事件做增量检查，两者都不会隐式开启 Capture。

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

当前版本会在 Supervisor 首次启动时，把 pre-supervisor 扁平配置迁移到 provider registry schema 9。已有且有效的 schema-2 至 schema-8 registry 会先备份再原子升级；schema-2/schema-3 提供商获得中性的默认权重 `100`，后续 schema 的权重以及 schema-5 模型映射会保留。Schema-6 的单模型规则会变成只含一个模型的集合，自动/自定义模型范围会分别迁移为等价的“新模型默认启用/默认停用”，原有自定义白名单会成为已启用的手工模型。Schema-7 安装会迁移为回环监听且客户端 Key 鉴权关闭，从而保持原访问边界不变。Schema-8 及更早安装会保留原有元数据 Capture 选择，并把新的详细 Capture 设置安全地初始化为关闭。Schema 检查与替换同时持有迁移锁和常规 ProviderRegistry 写锁，并在报告成功前 fsync 备份及发布目录项。

1. 停止旧的托管代理。
2. 私下备份 `~/.codex-remote-proxy/` 和 `~/.codex/config.toml`；所有备份都应视为包含敏感信息。
3. 运行 `crp ui`。
4. 检查恢复得到的一个或多个 Provider 候选，运行兼容性测试，并且只在测试通过后选择。

迁移会独立解析旧 `config.json` 与运行时 `node/proxy-config.json`。只有一个完整来源时，创建一个未激活、未测试的 `Default` Provider；规范化后的连接事实完全相同时会去重。如果两个完整来源的 URL、凭据或显式鉴权事实不同，CRP 不替用户选择，而是分别导入为未激活的 `Recovered runtime` 与 `Recovered saved`，并为每份凭据创建独立的原生后端引用。所有可解析来源会先创建字节完全一致的私有备份；schema-9 registry 验证成功后才清除旧来源中的密钥。无法解析的旧 JSON 会保持原始字节不变。

如果没有任何来源能够独立组成一个完整且有效的 Provider，迁移不会修改、备份或清理旧文件，而会让 Web UI 使用空的内存 schema-9 registry 正常进入 Setup。用户可以直接在界面添加 Provider，无需编辑或删除含密钥的文件。registry 路径不安全、身份竞态或权限错误仍会严格失败，绝不会为了启动界面而丢弃已经迁移的多 Provider 数据。

如果现有 `providers.json` 是能够安全读取的普通文件，但其 JSON、schema 或文档内容无效，CRP 现在会在不删除原文的情况下自动恢复：先创建私有、字节完全一致的备份，再通过同目录 hard link 把原 inode 保留到固定且禁止覆盖的 `providers.json.recovery-invalid` marker，收紧为 `0600` 并 fsync，最后只释放仍与原 inode 匹配的 canonical 链接。Supervisor 随后使用空的内存 registry 打开 Setup。符号链接、目录、权限失败、身份竞态和外部 recovery marker 仍会严格失败。`prepared → linked → canonical-released` 持久 journal 会绑定源 inode、PID 与两把事务锁，让后续启动可以安全完成中断恢复，而不会删除 foreign lock 或文件。

如果事务在提交前失败，CRP 只按逆序恢复本次实际修改的来源，并补偿本次创建的凭据；外部替换文件绝不会被删除。回滚降级时会保留固定的迁移锁与 registry 锁作为可发现阻断。Activity 在主迁移提交后失败会报告 committed-degraded，不会谎称主操作未提交。出现 `MIGRATION_COMMITTED_DEGRADED`、`MIGRATION_COMMITTED_LOCK_DEGRADED` 或 `MIGRATION_ROLLBACK_DEGRADED` 时，必须停止 CRP，保留私有备份，并检查已脱敏 Activity 错误码。

回退到 `0.2.2` 不是 schema 降级。必须先停止 CRP，再把完整的升级前私有备份作为一个整体恢复；不要只把密钥复制回某一个旧文件，也不要混用 schema-9 registry 与扁平配置。真实 HOME 上的迁移和回退仍属于 L3 操作，需要对应平台的人工审查。

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

发布证据必须包含 lint、UI 类型检查/构建/精确资源清单验证、确定性 Node 测试、Chromium 英中双语响应式矩阵、精确发布包白名单、生产依赖审计，以及 `design-qa.md` 中的视觉对比。确定性 fixture 不代表真实 Codex 历史、原生凭据、登录启动执行或外部 provider 证据；这些仍属于对应发布代码树的平台/人工门禁。

Supervisor 发现使用有界的 2 秒探活，普通 Admin 操作另用 30 秒超时，因此已经成功的 provider test 不会再被误报为 `SUPERVISOR_UNAVAILABLE`。代理目标通过结构化方式拼接，无论 base URL 是否带尾斜杠都只产生一个路径分隔符。

发布准备及仍待完成的外部门禁见 [node/RELEASING.md](./node/RELEASING.md)。
