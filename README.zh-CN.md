![Codex Remote Proxy Banner](./assets/banner.png)

# Codex Remote Proxy 中文文档

Codex Remote Proxy（CRP）让 Codex 保持 ChatGPT 登录态，同时把模型请求转发到当前选中的 OpenAI 兼容提供商。Codex 始终使用内置的 `OpenAI` 提供商身份，因此切换上游不会改变已有 OpenAI 线程的归属。

[English](./README.md)

> 发布状态：npm 当前发布的仍是 pre-supervisor `0.2.2`，其中不包含 `crp ui`。下文说明待发布的下一个 minor 版本；必须先通过外部平台门禁与 L3 确认才能发布。

## 发布后安装

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

`crp ui` 会启动或发现本地 Supervisor，并打开管理界面。界面完整支持 English 和简体中文，可在页头切换；浏览器只会保存用户明确选择的语言。

## 可以管理什么

本地管理界面覆盖完整的日常流程：

- 创建具名提供商；
- 通过只写输入框填写凭据；
- 测试 OpenAI Responses API 兼容性；
- 激活并切换已通过测试的提供商；
- 替换非当前提供商的凭据或删除非当前提供商；
- 启动、停止、重启和查看代理 Worker；
- 查看已脱敏的活动记录和只读设置；
- 生成只包含创建状态、生成时间和已脱敏事件数量的内存诊断摘要。

提供商切换只影响新请求。已经在处理中的请求继续使用其开始时捕获的提供商快照。

## 固定的 Codex 配置

CRP 只需引导配置一次，并持续保持以下不变量：

```toml
model_provider = "OpenAI"
```

```text
http://127.0.0.1:15100
```

提供商切换发生在 CRP 内部。日常切换时不要为每个上游创建不同的 Codex `model_provider`，也不要修改固定代理地址。

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

如果会话仍有效但刷新后的页面没有启动 fragment，界面会进入仅 GET 工作区：读取仍可使用，所有修改控件都会禁用，必须重新运行 `crp ui` 才能恢复修改能力。会话交换失败，或后续会话/CSRF 鉴权失败，都会使当前标签页进入终止状态。

## CLI

凡是需要输入凭据，优先使用管理界面。Supervisor 同时提供以下命令：

```text
crp ui [--no-open] [--json]
crp init [--no-open] [--json]
crp start [--json]
crp status [--json]
crp stop [--json]
crp restart [--json]
crp shutdown [--json]
crp provider list|add|test|activate|delete [--json]
```

`crp init` 是 `crp ui` 的兼容别名，只接受 `--no-open` 和 `--json`，不会询问提供商，也不会写入旧的扁平配置。旧的 `--api-key`、`--upstream-base-url`、请求记录/主机/端口参数、未知参数和位置参数都会在发现 Supervisor 或写磁盘前被拒绝。

`crp provider add` 支持高级鉴权和模型选项，但要求使用只写的 `--api-key` 参数。命令行密钥可能出现在 shell 历史或进程检查中，因此该路径仅适合受控自动化。可通过 `crp guide --json` 查看准确的机器可读命令格式。

`crp install` 和 `crp setup` 仍是 Supervisor 版 `crp start` 的弃用别名，三者都只接受 `--json`。其他已实现的兼容/检查命令是 `check`、`capture on|off|status`、`guide` 和 `install-cli`；CLI 没有 provider update、Activity、Settings 或 diagnostics 命令。

## 从 0.2.2 升级

下一个 minor 版本会在 Supervisor 首次启动时，把 pre-supervisor 扁平配置迁移到 provider registry schema 2。

1. 停止旧的托管代理。
2. 私下备份 `~/.codex-remote-proxy/` 和 `~/.codex/config.toml`；所有备份都应视为包含敏感信息。
3. 运行 `crp ui`。
4. 检查迁移得到的 `Default` 提供商，运行兼容性测试，并且只在测试通过后激活。

如果存在旧的 `config.json` 和运行时 `node/proxy-config.json`，迁移会读取它们。CRP 先创建防碰撞、字节完全一致的私有备份，再通过必需的原生凭据后端保存凭据，创建未激活且未测试的 schema-2 提供商，验证已经提交的 registry，最后才从旧文件中清除密钥字段。备份会保留。

如果事务在提交前失败，CRP 会尝试恢复原始字节，并且只删除能够证明属于本次事务的 registry 与凭据状态；外部替换的文件不会被删除。出现 `MIGRATION_COMMITTED_DEGRADED`、`MIGRATION_COMMITTED_LOCK_DEGRADED` 或 `MIGRATION_ROLLBACK_DEGRADED`，表示最终状态不确定或需要修复：停止 CRP，不要连续重试，保留备份，并在修改文件前查看 Activity 中已脱敏的错误码。处于降级状态时，CRP 不会擅自用备份自动覆盖当前状态。

回退到 `0.2.2` 不是 schema 降级。必须先停止 CRP，再把完整的升级前私有备份作为一个整体恢复；不要只把密钥复制回某一个旧文件，也不要混用 schema-2 registry 与扁平配置。真实 HOME 上的迁移和回退仍属于 L3 操作，需要对应平台的人工审查。

## 开发验证

```bash
cd node
npm ci
npm run lint
npm test
npm run test:e2e -- --project=chromium --workers=1
npm audit --omit=dev
npm pack --dry-run --json --ignore-scripts
```

测试只使用临时 HOME、合成凭据、注入适配器和 loopback 模拟上游。不要让 Supervisor 启动或迁移测试操作真实 HOME。

发布准备及仍待完成的外部门禁见 [node/RELEASING.md](./node/RELEASING.md)。
