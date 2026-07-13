(() => {
  "use strict";

  const DICTIONARIES = {
    en: {
      "a11y.skip": "Skip to content",
      "brand.subtitle": "Local control",
      "brand.long": "Codex Remote Proxy",
      "nav.label": "Workspace",
      "nav.eyebrow": "Workspace",
      "nav.overview": "Overview",
      "nav.providers": "Providers",
      "nav.activity": "Activity",
      "nav.settings": "Settings",
      "session.local": "Local session",
      "session.readOnly.title": "Read-only session",
      "session.expired.title": "Session expired",
      "session.reopen": "Run crp ui again to make changes.",
      "session.terminalHelp": "This browser session can no longer make or read local changes.",
      "session.eyebrow": "CRP / SESSION",
      "locale.label": "Language",
      "actions.refresh": "Refresh status",
      "actions.addProvider": "Add provider",
      "actions.cancel": "Cancel",
      "actions.save": "Save changes",
      "actions.close": "Close",
      "actions.editProvider": "Edit {name}",
      "actions.testProvider": "Test {name}",
      "actions.deleteProvider": "Delete {name}",
      "titles.overview": "Overview",
      "titles.providers": "Providers",
      "titles.activity": "Activity",
      "titles.settings": "Settings",
      "titles.suffix": "CRP Local Control",
      "overview.subtitle": "Proxy health, provider routing, and recent lifecycle activity.",
      "overview.updated": "Updated just now",
      "overview.proxyReady": "Proxy is ready",
      "overview.proxyStopped": "Proxy needs attention",
      "overview.readyDetail": "Codex requests are routed through {name}. No recent errors.",
      "overview.stoppedDetail": "Complete provider setup to start local routing.",
      "overview.proxyAddress": "Proxy address",
      "overview.fixedLoopback": "Fixed loopback",
      "overview.worker": "Worker",
      "overview.generation": "Generation {value}",
      "overview.inFlight": "In flight",
      "overview.safeRestart": "Safe to restart",
      "overview.activeProvider": "Active provider",
      "overview.manageProviders": "Manage providers",
      "overview.quickSwitch": "Quick switch",
      "overview.switchProvider": "Switch provider",
      "overview.recentActivity": "Recent activity",
      "overview.viewAll": "View all",
      "overview.runtime": "Runtime",
      "overview.supervisor": "Supervisor",
      "overview.codexProvider": "Codex provider",
      "overview.credentialStore": "Credential store",
      "overview.sessionExpires": "Session expires",
      "overview.readOnlyNote": "Settings are read-only while the supervisor is running.",
      "overview.noActivity": "No lifecycle activity yet.",
      "overview.restartWorker": "Restart worker",
      "overview.stopWorker": "Stop proxy",
      "overview.startWorker": "Start proxy",
      "overview.activeConfigured": "Credential configured",
      "overview.pid": "PID {value}",
      "overview.notRunning": "Not running",
      "overview.minutes": "{value} min",
      "onboarding.title": "Set up your first provider",
      "onboarding.eyebrow": "CRP / 01",
      "onboarding.subtitle": "Connect one Responses API-compatible provider, verify it, then start CRP.",
      "onboarding.stepDetails": "Provider details",
      "onboarding.stepTest": "Compatibility test",
      "onboarding.stepActivate": "Activate and start",
      "onboarding.formTitle": "Provider connection",
      "onboarding.formHelp": "Credentials stay in the configured local credential backend.",
      "onboarding.name": "Provider name",
      "onboarding.namePlaceholder": "Primary OpenAI",
      "onboarding.baseUrl": "Base URL",
      "onboarding.baseUrlPlaceholder": "https://api.example.com/v1",
      "onboarding.apiKey": "API key",
      "onboarding.apiKeyHelp": "The saved credential is never shown again.",
      "onboarding.testModel": "Test model",
      "onboarding.advanced": "Advanced provider settings",
      "onboarding.advancedHelp": "Configure authentication, headers, and model routing.",
      "onboarding.authHeader": "Authentication header",
      "onboarding.authScheme": "Authentication scheme",
      "onboarding.extraHeaders": "Extra headers (JSON)",
      "onboarding.extraHeadersHelp": "Use a JSON object containing only non-sensitive string header values.",
      "onboarding.modelMode": "Model routing",
      "onboarding.passthrough": "Pass through requested model",
      "onboarding.override": "Override every requested model",
      "onboarding.modelOverride": "Override model",
      "onboarding.fallback": "Allow fallback credential storage",
      "onboarding.fallbackHelp": "Allow only if the native credential store cannot be constructed; CRP may use its private file fallback.",
      "onboarding.save": "Save provider",
      "onboarding.saved": "Provider saved. Test compatibility next.",
      "onboarding.testTitle": "Verify the Responses API",
      "onboarding.testHelp": "CRP sends a minimal local compatibility request using the saved credential.",
      "onboarding.test": "Test compatibility",
      "onboarding.compatible": "Compatible",
      "onboarding.compatibleHelp": "The provider returned a valid Responses API payload.",
      "onboarding.activate": "Activate and start",
      "onboarding.retryHelp": "Edit the provider settings or replace its credential, then run the test again.",
      "providers.subtitle": "Manage endpoints, credentials, tests, and active routing.",
      "providers.active": "Active",
      "providers.testAction": "Test",
      "providers.editAction": "Edit",
      "providers.deleteAction": "Delete",
      "providers.activateAction": "Activate",
      "providers.editTitle": "Edit provider",
      "providers.createTitle": "Add provider",
      "providers.editHelp": "Update the public endpoint or replace its saved credential.",
      "providers.createHelp": "Add a Responses API-compatible provider to this local CRP instance.",
      "providers.replacement": "Replacement API key",
      "providers.replacementHelp": "Leave blank to keep the saved credential.",
      "providers.activeEditReason": "Activate another provider before editing this active provider.",
      "providers.fallbackEditHelp": "Fallback consent applies only when a credential is first stored; this update keeps the configured credential backend.",
      "providers.testTitle": "Test provider",
      "providers.runTest": "Run test",
      "providers.deleteTitle": "Delete provider?",
      "providers.deleteMessage": "Delete {name} and its saved local credential?",
      "providers.deleteConfirm": "Delete provider",
      "providers.empty": "No providers are configured.",
      "activity.subtitle": "Sanitized local lifecycle events and diagnostics.",
      "activity.export": "Export diagnostics",
      "activity.empty": "No sanitized activity is available.",
      "activity.previous": "Previous",
      "activity.next": "Next",
      "activity.category": "Category: {value}",
      "activity.category.provider": "Provider",
      "activity.category.proxy": "Proxy",
      "activity.category.migration": "Migration",
      "activity.category.worker": "Worker",
      "activity.category.lifecycle": "Lifecycle",
      "activity.category.security": "Security",
      "activity.category.codex": "Codex",
      "activity.category.unknown": "Other",
      "activity.providerId": "Provider ID: {value}",
      "activity.errorCode": "Error: {value}",
      "activity.diagnosticsTitle": "Diagnostics exported",
      "activity.diagnosticsCreatedAt": "Created at {value}",
      "activity.diagnosticsCount": "{value} sanitized events",
      "settings.subtitle": "Fixed local runtime settings and Codex integration state.",
      "settings.readOnly": "Read-only while CRP is running",
      "settings.proxy": "Proxy address",
      "settings.admin": "Admin address",
      "settings.backend": "Credential backend",
      "settings.native": "Native keyring",
      "settings.capture": "Traffic capture",
      "settings.disabled": "Disabled",
      "settings.enabled": "Enabled",
      "settings.codex": "Codex model provider",
      "settings.codexProxy": "Codex proxy URL",
      "restart.title": "Restart worker?",
      "restart.message": "{count} requests are still in flight. Restarting can interrupt them.",
      "restart.confirm": "Restart anyway",
      "stub.coming": "This workspace is loading.",
      "compatibility.passed": "Passed",
      "compatibility.failed": "Failed",
      "compatibility.untested": "Untested",
      "activity.complete": "Complete",
      "activity.success": "Passed",
      "activity.failure": "Failed",
      "activity.failed": "Failed",
      "activity.degraded": "Degraded",
      "activity.degradedAction": "Stop CRP and review Activity before making more changes.",
      "activity.create": "Provider created",
      "activity.update": "Provider updated",
      "activity.delete": "Provider deleted",
      "activity.test": "Compatibility test",
      "activity.activate": "Provider activated",
      "activity.proxy.start": "Proxy started",
      "activity.proxy.restart": "Worker restarted",
      "activity.proxy.stop": "Proxy stopped",
      "activity.start": "Proxy started",
      "activity.stop": "Proxy stopped",
      "activity.restart": "Worker restarted",
      "activity.legacy-config": "Legacy configuration migration",
      "announcements.providerSaved": "Provider saved",
      "announcements.compatible": "Provider is compatible",
      "announcements.proxyStarted": "Proxy started",
      "announcements.refreshed": "Status refreshed",
      "announcements.providerSwitched": "Provider switched",
      "announcements.providerDeleted": "Provider deleted",
      "announcements.workerRestarted": "Worker restarted",
      "announcements.workerStarted": "Proxy started",
      "announcements.workerStopped": "Proxy stopped",
      "announcements.providerActivated": "Provider activated",
      "announcements.activityPage": "Activity page loaded",
      "announcements.diagnostics": "Diagnostics exported",
      "errors.auth.title": "Provider authentication failed",
      "errors.auth.action": "Check the API key and authorization scheme, then test again.",
      "errors.dns.title": "Provider address could not be resolved",
      "errors.dns.action": "Check the provider hostname and local DNS, then test again.",
      "errors.tls.title": "Secure connection failed",
      "errors.tls.action": "Check the provider certificate and system clock, then test again.",
      "errors.timeout.title": "Provider test timed out",
      "errors.timeout.action": "Check provider availability and try the test again.",
      "errors.notFound.title": "Responses API endpoint was not found",
      "errors.notFound.action": "Check that the base URL includes the provider API prefix.",
      "errors.incompatible.title": "Provider response is incompatible",
      "errors.incompatible.action": "Use a provider with a compatible Responses API implementation.",
      "errors.port.title": "The proxy port is already in use",
      "errors.port.action": "Stop the process using port 15100, then restart the worker.",
      "errors.worker.title": "The proxy worker could not complete the operation",
      "errors.worker.action": "Review Activity, then retry the worker operation.",
      "errors.migration.title": "Local data migration needs attention",
      "errors.migration.action": "Stop CRP and repair the migration state before restarting.",
      "errors.concurrent.title": "Another local operation is in progress",
      "errors.concurrent.action": "Wait for the current operation to finish, then try again.",
      "errors.notReady.title": "Provider is not ready",
      "errors.notReady.action": "Run a successful compatibility test before activating this provider.",
      "errors.active.title": "The active provider cannot be changed this way",
      "errors.active.action": "Activate another provider before editing or deleting this provider.",
      "errors.readOnly.title": "Settings are read-only",
      "errors.readOnly.action": "Use the supported provider and lifecycle controls instead.",
      "errors.input.title": "Provider settings are invalid",
      "errors.input.action": "Review the highlighted provider fields and try again.",
      "errors.degraded.title": "CRP state needs repair",
      "errors.degraded.action": "Stop CRP, review Activity, and repair local state before any further operation.",
      "errors.requestId": "Request ID: {value}",
      "errors.technical": "Technical details",
      "errors.codeLabel": "Error code",
      "errors.requestIdLabel": "Request ID",
      "errors.detail.field": "Field",
      "errors.detail.reason": "Reason",
      "errors.detail.committed": "Committed",
      "errors.detail.degraded": "Degraded",
      "errors.detail.generation": "Generation",
      "errors.detail.httpStatus": "HTTP status",
      "errors.value.yes": "Yes",
      "errors.value.no": "No",
      "errors.reason.timeout": "Timed out",
      "errors.reason.not_found": "Not found",
      "errors.reason.invalid": "Invalid value",
      "errors.reason.conflict": "Conflicting operation",
      "errors.reason.unavailable": "Unavailable",
      "errors.reason.permission_denied": "Permission denied",
      "errors.generic.title": "CRP could not complete the operation",
      "errors.generic.action": "Review Activity and try again.",
      "errors.session.title": "Session expired",
      "errors.session.action": "Run crp ui again to create a local editing session."
    },
    "zh-CN": {
      "a11y.skip": "跳至主要内容",
      "brand.subtitle": "本地控制台",
      "brand.long": "Codex 远程代理",
      "nav.label": "工作区",
      "nav.eyebrow": "工作区",
      "nav.overview": "概览",
      "nav.providers": "提供商",
      "nav.activity": "活动",
      "nav.settings": "设置",
      "session.local": "本地会话",
      "session.readOnly.title": "只读会话",
      "session.expired.title": "会话已过期",
      "session.reopen": "请重新运行 crp ui 以执行更改。",
      "session.terminalHelp": "此浏览器会话已无法读取或执行本地更改。",
      "session.eyebrow": "CRP / 会话",
      "locale.label": "语言",
      "actions.refresh": "刷新状态",
      "actions.addProvider": "添加提供商",
      "actions.cancel": "取消",
      "actions.save": "保存更改",
      "actions.close": "关闭",
      "actions.editProvider": "编辑 {name}",
      "actions.testProvider": "测试 {name}",
      "actions.deleteProvider": "删除 {name}",
      "titles.overview": "概览",
      "titles.providers": "提供商",
      "titles.activity": "活动",
      "titles.settings": "设置",
      "titles.suffix": "CRP 本地控制台",
      "overview.subtitle": "查看代理健康状态、提供商路由和最近的生命周期活动。",
      "overview.updated": "刚刚更新",
      "overview.proxyReady": "代理已就绪",
      "overview.proxyStopped": "代理需要处理",
      "overview.readyDetail": "Codex 请求正通过 {name} 路由，近期没有错误。",
      "overview.stoppedDetail": "请完成提供商设置以启动本地路由。",
      "overview.proxyAddress": "代理地址",
      "overview.fixedLoopback": "固定回环地址",
      "overview.worker": "工作进程",
      "overview.generation": "第 {value} 代",
      "overview.inFlight": "处理中",
      "overview.safeRestart": "可安全重启",
      "overview.activeProvider": "当前提供商",
      "overview.manageProviders": "管理提供商",
      "overview.quickSwitch": "快速切换",
      "overview.switchProvider": "切换提供商",
      "overview.recentActivity": "最近活动",
      "overview.viewAll": "查看全部",
      "overview.runtime": "运行环境",
      "overview.supervisor": "管理进程",
      "overview.codexProvider": "Codex 提供商",
      "overview.credentialStore": "凭据存储",
      "overview.sessionExpires": "会话有效期",
      "overview.readOnlyNote": "管理进程运行期间，设置为只读。",
      "overview.noActivity": "暂无生命周期活动。",
      "overview.restartWorker": "重启工作进程",
      "overview.stopWorker": "停止代理",
      "overview.startWorker": "启动代理",
      "overview.activeConfigured": "凭据已配置",
      "overview.pid": "PID {value}",
      "overview.notRunning": "未运行",
      "overview.minutes": "{value} 分钟",
      "onboarding.title": "设置首个提供商",
      "onboarding.eyebrow": "CRP / 01",
      "onboarding.subtitle": "连接一个兼容 Responses API 的提供商，验证后启动 CRP。",
      "onboarding.stepDetails": "提供商信息",
      "onboarding.stepTest": "兼容性测试",
      "onboarding.stepActivate": "激活并启动",
      "onboarding.formTitle": "提供商连接",
      "onboarding.formHelp": "凭据只保存在已配置的本地凭据后端中。",
      "onboarding.name": "提供商名称",
      "onboarding.namePlaceholder": "主要 OpenAI",
      "onboarding.baseUrl": "基础地址",
      "onboarding.baseUrlPlaceholder": "https://api.example.com/v1",
      "onboarding.apiKey": "API 密钥",
      "onboarding.apiKeyHelp": "已保存的凭据不会再次显示。",
      "onboarding.testModel": "测试模型",
      "onboarding.advanced": "高级提供商设置",
      "onboarding.advancedHelp": "配置认证、请求头和模型路由。",
      "onboarding.authHeader": "认证请求头",
      "onboarding.authScheme": "认证方案",
      "onboarding.extraHeaders": "额外请求头（JSON）",
      "onboarding.extraHeadersHelp": "请使用仅包含非敏感字符串请求头的 JSON 对象。",
      "onboarding.modelMode": "模型路由",
      "onboarding.passthrough": "透传请求的模型",
      "onboarding.override": "覆盖所有请求模型",
      "onboarding.modelOverride": "覆盖模型",
      "onboarding.fallback": "允许回退凭据存储",
      "onboarding.fallbackHelp": "仅当原生凭据存储无法构造时允许；CRP 可能使用其私有文件回退。",
      "onboarding.save": "保存提供商",
      "onboarding.saved": "提供商已保存。下一步请测试兼容性。",
      "onboarding.testTitle": "验证 Responses API",
      "onboarding.testHelp": "CRP 使用已保存凭据发送最小化的本地兼容性请求。",
      "onboarding.test": "测试兼容性",
      "onboarding.compatible": "兼容",
      "onboarding.compatibleHelp": "提供商返回了有效的 Responses API 数据。",
      "onboarding.activate": "激活并启动",
      "onboarding.retryHelp": "编辑提供商设置或替换凭据，然后重新运行测试。",
      "providers.subtitle": "管理端点、凭据、测试和当前路由。",
      "providers.active": "当前使用",
      "providers.testAction": "测试",
      "providers.editAction": "编辑",
      "providers.deleteAction": "删除",
      "providers.activateAction": "激活",
      "providers.editTitle": "编辑提供商",
      "providers.createTitle": "添加提供商",
      "providers.editHelp": "更新公开端点，或替换已保存的凭据。",
      "providers.createHelp": "向此本地 CRP 实例添加兼容 Responses API 的提供商。",
      "providers.replacement": "替换 API 密钥",
      "providers.replacementHelp": "留空可保留已保存的凭据。",
      "providers.activeEditReason": "请先激活其他提供商，再编辑当前提供商。",
      "providers.fallbackEditHelp": "回退授权仅适用于首次存储凭据；本次更新沿用已配置的凭据后端。",
      "providers.testTitle": "测试提供商",
      "providers.runTest": "运行测试",
      "providers.deleteTitle": "删除提供商？",
      "providers.deleteMessage": "删除 {name} 及其已保存的本地凭据？",
      "providers.deleteConfirm": "删除提供商",
      "providers.empty": "尚未配置提供商。",
      "activity.subtitle": "查看已脱敏的本地生命周期事件和诊断信息。",
      "activity.export": "导出诊断信息",
      "activity.empty": "暂无已脱敏的活动记录。",
      "activity.previous": "上一页",
      "activity.next": "下一页",
      "activity.category": "类别：{value}",
      "activity.category.provider": "提供商",
      "activity.category.proxy": "代理",
      "activity.category.migration": "迁移",
      "activity.category.worker": "工作进程",
      "activity.category.lifecycle": "生命周期",
      "activity.category.security": "安全",
      "activity.category.codex": "Codex",
      "activity.category.unknown": "其他",
      "activity.providerId": "提供商 ID：{value}",
      "activity.errorCode": "错误：{value}",
      "activity.diagnosticsTitle": "诊断信息已导出",
      "activity.diagnosticsCreatedAt": "创建时间：{value}",
      "activity.diagnosticsCount": "{value} 条已脱敏事件",
      "settings.subtitle": "查看固定的本地运行设置和 Codex 集成状态。",
      "settings.readOnly": "CRP 运行期间为只读",
      "settings.proxy": "代理地址",
      "settings.admin": "管理地址",
      "settings.backend": "凭据后端",
      "settings.native": "原生钥匙串",
      "settings.capture": "流量捕获",
      "settings.disabled": "已禁用",
      "settings.enabled": "已启用",
      "settings.codex": "Codex 模型提供商",
      "settings.codexProxy": "Codex 代理 URL",
      "restart.title": "重启工作进程？",
      "restart.message": "仍有 {count} 个请求正在处理，重启可能中断这些请求。",
      "restart.confirm": "仍然重启",
      "stub.coming": "该工作区正在加载。",
      "compatibility.passed": "已通过",
      "compatibility.failed": "失败",
      "compatibility.untested": "未测试",
      "activity.complete": "完成",
      "activity.success": "已通过",
      "activity.failure": "失败",
      "activity.failed": "失败",
      "activity.degraded": "已降级",
      "activity.degradedAction": "请停止 CRP 并查看活动记录，然后再执行更多更改。",
      "activity.create": "已创建提供商",
      "activity.update": "已更新提供商",
      "activity.delete": "已删除提供商",
      "activity.test": "兼容性测试",
      "activity.activate": "已激活提供商",
      "activity.proxy.start": "代理已启动",
      "activity.proxy.restart": "工作进程已重启",
      "activity.proxy.stop": "代理已停止",
      "activity.start": "代理已启动",
      "activity.stop": "代理已停止",
      "activity.restart": "工作进程已重启",
      "activity.legacy-config": "旧版配置迁移",
      "announcements.providerSaved": "提供商已保存",
      "announcements.compatible": "提供商兼容",
      "announcements.proxyStarted": "代理已启动",
      "announcements.refreshed": "状态已刷新",
      "announcements.providerSwitched": "已切换提供商",
      "announcements.providerDeleted": "提供商已删除",
      "announcements.workerRestarted": "工作进程已重启",
      "announcements.workerStarted": "代理已启动",
      "announcements.workerStopped": "代理已停止",
      "announcements.providerActivated": "提供商已激活",
      "announcements.activityPage": "活动页面已加载",
      "announcements.diagnostics": "诊断信息已导出",
      "errors.auth.title": "提供商认证失败",
      "errors.auth.action": "请检查 API 密钥和认证方案，然后重新测试。",
      "errors.dns.title": "无法解析提供商地址",
      "errors.dns.action": "请检查提供商主机名和本地 DNS，然后重新测试。",
      "errors.tls.title": "安全连接失败",
      "errors.tls.action": "请检查提供商证书和系统时间，然后重新测试。",
      "errors.timeout.title": "提供商测试超时",
      "errors.timeout.action": "请检查提供商可用性，然后重新测试。",
      "errors.notFound.title": "未找到 Responses API 端点",
      "errors.notFound.action": "请检查基础 URL 是否包含提供商 API 前缀。",
      "errors.incompatible.title": "提供商响应不兼容",
      "errors.incompatible.action": "请使用实现了兼容 Responses API 的提供商。",
      "errors.port.title": "代理端口已被占用",
      "errors.port.action": "请停止占用 15100 端口的进程，然后重启工作进程。",
      "errors.worker.title": "代理工作进程无法完成操作",
      "errors.worker.action": "请查看活动记录，然后重试工作进程操作。",
      "errors.migration.title": "本地数据迁移需要处理",
      "errors.migration.action": "请停止 CRP 并修复迁移状态，然后重新启动。",
      "errors.concurrent.title": "另一个本地操作正在进行",
      "errors.concurrent.action": "请等待当前操作完成，然后重试。",
      "errors.notReady.title": "提供商尚未就绪",
      "errors.notReady.action": "激活前请先通过兼容性测试。",
      "errors.active.title": "无法以此方式更改当前提供商",
      "errors.active.action": "请先激活其他提供商，再编辑或删除此提供商。",
      "errors.readOnly.title": "设置为只读",
      "errors.readOnly.action": "请使用受支持的提供商和生命周期控制。",
      "errors.input.title": "提供商设置无效",
      "errors.input.action": "请检查提供商字段后重试。",
      "errors.degraded.title": "CRP 状态需要修复",
      "errors.degraded.action": "请停止 CRP、查看活动记录并修复本地状态，然后再执行任何操作。",
      "errors.requestId": "请求 ID：{value}",
      "errors.technical": "技术详情",
      "errors.codeLabel": "错误代码",
      "errors.requestIdLabel": "请求 ID",
      "errors.detail.field": "字段",
      "errors.detail.reason": "原因",
      "errors.detail.committed": "已提交",
      "errors.detail.degraded": "已降级",
      "errors.detail.generation": "代次",
      "errors.detail.httpStatus": "HTTP 状态",
      "errors.value.yes": "是",
      "errors.value.no": "否",
      "errors.reason.timeout": "已超时",
      "errors.reason.not_found": "未找到",
      "errors.reason.invalid": "值无效",
      "errors.reason.conflict": "操作冲突",
      "errors.reason.unavailable": "不可用",
      "errors.reason.permission_denied": "权限不足",
      "errors.generic.title": "CRP 无法完成操作",
      "errors.generic.action": "请查看活动记录，然后重试。",
      "errors.session.title": "会话已过期",
      "errors.session.action": "请重新运行 crp ui 以创建本地编辑会话。"
    }
  };

  const dictionaryKeys = Object.keys(DICTIONARIES.en).sort().join("\n");
  if (Object.keys(DICTIONARIES["zh-CN"]).sort().join("\n") !== dictionaryKeys) {
    throw new Error("Locale dictionaries must contain matching keys.");
  }

  const SUPPORTED_LOCALES = Object.keys(DICTIONARIES);
  const EMPTY_BODY = Symbol("empty-body");
  const ACTIVITY_PAGE_SIZE = 50;
  const ACTIVITY_CATEGORIES = new Set([
    "provider",
    "proxy",
    "migration",
    "worker",
    "lifecycle",
    "security",
    "codex"
  ]);
  const SESSION_TERMINAL_ERROR_CODES = new Set([
    "AUTH_REQUIRED",
    "AUTH_INVALID",
    "AUTH_SESSION_INVALID",
    "AUTH_SESSION_EXPIRED",
    "AUTH_CSRF_MISSING",
    "AUTH_CSRF_INVALID"
  ]);
  const SAFE_ERROR_DETAIL_FIELDS = new Set([
    "field",
    "reason",
    "committed",
    "degraded",
    "generation",
    "httpStatus"
  ]);
  const SAFE_ERROR_FIELDS = new Set([
    "provider",
    "name",
    "baseUrl",
    "authHeader",
    "authScheme",
    "extraHeaders",
    "modelMode",
    "modelOverride",
    "credential",
    "proxy",
    "port",
    "generation"
  ]);
  const SAFE_ERROR_REASONS = new Set([
    "timeout",
    "not_found",
    "invalid",
    "conflict",
    "unavailable",
    "permission_denied"
  ]);

  class UiError extends Error {
    constructor(code, status = 500, { requestId = null, details = {} } = {}) {
      const stableCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
        ? code
        : "INTERNAL_ERROR";
      super(stableCode);
      this.code = stableCode;
      this.status = status;
      this.requestId = typeof requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(requestId)
        ? requestId
        : null;
      this.details = Object.fromEntries(
        Object.entries(details).filter(([key]) => SAFE_ERROR_DETAIL_FIELDS.has(key))
      );
    }
  }

  function storedLocale() {
    try {
      const stored = localStorage.getItem("crp.locale");
      if (stored === null) return null;
      if (SUPPORTED_LOCALES.includes(stored)) return stored;
      localStorage.removeItem("crp.locale");
    } catch {
      return null;
    }
    return null;
  }

  function matchLocale(candidate) {
    if (typeof candidate !== "string") return null;
    const normalized = candidate.toLowerCase();
    if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
    return null;
  }

  function browserLocale() {
    const candidates = Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
    for (const candidate of candidates) {
      const matched = matchLocale(candidate);
      if (matched !== null) return matched;
    }
    return "en";
  }

  let locale = storedLocale() ?? browserLocale();
  let dateFormatter = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  let numberFormatter = new Intl.NumberFormat(locale);

  function t(key, variables = {}) {
    const template = DICTIONARIES[locale][key] ?? DICTIONARIES.en[key] ?? key;
    return Object.entries(variables).reduce(
      (copy, [name, value]) => copy.replaceAll(`{${name}}`, String(value)),
      template
    );
  }

  function readAndClearControlToken() {
    const hash = location.hash;
    const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(hash);
    const token = match?.[1] ?? null;
    if (hash.length > 0) {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
    return token;
  }

  const elements = {
    sessionRoot: document.querySelector("#session-root"),
    onboardingRoot: document.querySelector("#onboarding-root"),
    appRoot: document.querySelector("#app-root"),
    onboardingMain: document.querySelector("#onboarding-content"),
    main: document.querySelector("#main-content"),
    localeControls: Array.from(document.querySelectorAll("[data-locale-select]")),
    breadcrumb: document.querySelector("#breadcrumb-current"),
    refresh: document.querySelector("#refresh-button"),
    addProvider: document.querySelector("#add-provider-button"),
    sessionBanner: document.querySelector("#session-banner"),
    sessionTitle: document.querySelector("#session-banner-title"),
    sessionAction: document.querySelector("#session-banner-action"),
    onboardingBanner: document.querySelector("#onboarding-session-banner"),
    onboardingSessionTitle: document.querySelector("#onboarding-session-title"),
    onboardingSessionAction: document.querySelector("#onboarding-session-action"),
    adminAddress: document.querySelector("#admin-address"),
    live: document.querySelector("#live-region"),
    confirmDialog: document.querySelector("#confirm-dialog"),
    confirmTitle: document.querySelector("#confirm-title"),
    confirmMessage: document.querySelector("#confirm-message"),
    confirmCancel: document.querySelector("#confirm-cancel"),
    confirmAccept: document.querySelector("#confirm-accept")
  };

  let confirmResolver = null;
  let confirmTrigger = null;
  let confirmTranslator = null;
  let activeDialogTranslator = null;
  let activeDialogSecretClearer = null;
  let activeLoadController = null;
  let visibleSurface = "loading";

  function createProviderDraft() {
    return {
      name: "",
      baseUrl: "",
      credential: "",
      testModel: "gpt-5.1-codex-mini",
      fallbackConsent: false,
      advanced: false,
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: "{}",
      modelMode: "passthrough",
      modelOverride: ""
    };
  }

  const state = {
    route: "overview",
    csrfToken: null,
    authTerminal: false,
    ready: false,
    mutationAllowed: false,
    readOnlyReason: null,
    pending: false,
    status: null,
    providers: [],
    events: [],
    activityOffset: 0,
    activityNextOffset: null,
    diagnostics: null,
    settings: null,
    pageError: null,
    onboarding: {
      providerId: null,
      phase: "create",
      draft: createProviderDraft(),
      dirty: false
    }
  };

  function applyStaticTranslations() {
    document.documentElement.lang = locale;
    for (const control of elements.localeControls) control.value = locale;
    for (const element of document.querySelectorAll("[data-i18n]")) {
      element.textContent = t(element.dataset.i18n);
    }
    for (const element of document.querySelectorAll("[data-i18n-aria]")) {
      element.setAttribute("aria-label", t(element.dataset.i18nAria));
    }
    for (const element of document.querySelectorAll("[data-i18n-title]")) {
      element.setAttribute("title", t(element.dataset.i18nTitle));
    }
    dateFormatter = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    numberFormatter = new Intl.NumberFormat(locale);
    confirmTranslator?.();
    activeDialogTranslator?.();
    updateChrome();
  }

  function updateChrome() {
    if (state.authTerminal) {
      elements.sessionRoot.hidden = false;
      elements.onboardingRoot.hidden = true;
      elements.appRoot.hidden = true;
      if (visibleSurface !== "session") {
        visibleSurface = "session";
        window.scrollTo(0, 0);
      }
      document.title = `${t("session.expired.title")} | ${t("titles.suffix")}`;
      return;
    }
    const onboardingVisible = state.ready && !state.status?.activeProviderId;
    elements.sessionRoot.hidden = true;
    elements.onboardingRoot.hidden = !onboardingVisible;
    elements.appRoot.hidden = !state.ready || onboardingVisible;
    const nextSurface = !state.ready ? "loading" : onboardingVisible ? "onboarding" : "app";
    if (visibleSurface !== nextSurface) {
      visibleSurface = nextSurface;
      window.scrollTo(0, 0);
    }
    if (!state.ready) return;
    const routeLabel = t(`titles.${state.route}`);
    elements.breadcrumb.textContent = routeLabel;
    document.title = `${onboardingVisible ? t("onboarding.title") : routeLabel} | ${t("titles.suffix")}`;
    for (const link of document.querySelectorAll("[data-route]")) {
      if (link.dataset.route === state.route) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    elements.addProvider.disabled = !state.mutationAllowed || state.pending;
    elements.refresh.disabled = state.pending;
    elements.sessionBanner.hidden = state.readOnlyReason === null;
    elements.onboardingBanner.hidden = state.readOnlyReason === null;
    if (state.readOnlyReason !== null) {
      const title = t("session.readOnly.title");
      const action = t("session.reopen");
      elements.sessionTitle.textContent = title;
      elements.sessionAction.textContent = action;
      elements.onboardingSessionTitle.textContent = title;
      elements.onboardingSessionAction.textContent = action;
    }
  }

  function node(tagName, options = {}, children = []) {
    const element = document.createElement(tagName);
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = options.text;
    for (const [name, value] of Object.entries(options.attributes ?? {})) {
      if (value !== null && value !== undefined) element.setAttribute(name, String(value));
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined) {
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
      }
    }
    return element;
  }

  function button(label, className = "secondary-button", attributes = {}) {
    const { disabled = false, readOnlyAllowed = false, ...domAttributes } = attributes;
    const control = node("button", {
      className,
      text: label,
      attributes: { type: "button", ...domAttributes }
    });
    control.disabled = state.pending || disabled === true || (!state.mutationAllowed && !readOnlyAllowed);
    return control;
  }

  function field({ label, name, type = "text", value = "", placeholder = "", help, required = true }) {
    const input = node("input", {
      attributes: {
        name,
        type,
        value,
        placeholder,
        required: required ? "" : null,
        autocomplete: type === "password" ? "new-password" : "off",
        spellcheck: "false"
      }
    });
    input.disabled = !state.mutationAllowed || state.pending;
    const labelElement = node("span", { text: label });
    const helpElement = help ? node("small", { text: help }) : null;
    const wrapper = node("label", { className: "form-field" }, [
      labelElement,
      input,
      helpElement
    ]);
    return { wrapper, input, labelElement, helpElement };
  }

  function selectField({ label, name, value, options }) {
    const select = node("select", { attributes: { name } });
    select.disabled = !state.mutationAllowed || state.pending;
    for (const option of options) {
      const optionElement = node("option", {
        text: option.label,
        attributes: { value: option.value }
      });
      optionElement.selected = option.value === value;
      select.append(optionElement);
    }
    const labelElement = node("span", { text: label });
    const wrapper = node("label", { className: "form-field" }, [labelElement, select]);
    return { wrapper, input: select, labelElement };
  }

  function textareaField({ label, name, value, help }) {
    const input = node("textarea", {
      text: value,
      attributes: { name, rows: "3", spellcheck: "false" }
    });
    input.disabled = !state.mutationAllowed || state.pending;
    const labelElement = node("span", { text: label });
    const helpElement = node("small", { text: help });
    const wrapper = node("label", { className: "form-field is-wide" }, [
      labelElement,
      input,
      helpElement
    ]);
    return { wrapper, input, labelElement, helpElement };
  }

  function translateDynamicFields(root) {
    for (const element of root.querySelectorAll("[data-copy-key]")) {
      element.textContent = t(element.dataset.copyKey);
    }
    for (const element of root.querySelectorAll("[data-placeholder-key]")) {
      element.setAttribute("placeholder", t(element.dataset.placeholderKey));
    }
  }

  function pageHeading(title, subtitle) {
    return node("div", { className: "page-heading" }, [
      node("div", {}, [
        node("h1", { text: title }),
        node("p", { text: subtitle })
      ]),
      node("span", { className: "updated-copy", text: t("overview.updated") })
    ]);
  }

  function errorGroup(error) {
    const code = error instanceof UiError ? error.code : error;
    if (code?.includes("DEGRADED") || code?.includes("COMMITTED")) return "degraded";
    if (code === "PROVIDER_TEST_AUTH") return "auth";
    if (code === "PROVIDER_TEST_DNS") return "dns";
    if (code === "PROVIDER_TEST_TLS") return "tls";
    if (code === "PROVIDER_TEST_TIMEOUT") return "timeout";
    if (code === "PROVIDER_TEST_NOT_FOUND") return "notFound";
    if (["PROVIDER_TEST_INVALID_JSON", "PROVIDER_TEST_INVALID_RESPONSES", "PROVIDER_TEST_HTTP", "PROVIDER_TEST_NETWORK", "PROVIDER_TEST_REDIRECT"].includes(code)) return "incompatible";
    if (code === "WORKER_PORT_BUSY") return "port";
    if (code?.startsWith("WORKER_") || code?.startsWith("PROXY_")) return "worker";
    if (code?.startsWith("MIGRATION_")) return "migration";
    if (code?.endsWith("_BUSY")) return "concurrent";
    if (code === "PROVIDER_NOT_READY") return "notReady";
    if (code === "PROVIDER_ACTIVE") return "active";
    if (code === "SETTINGS_READ_ONLY") return "readOnly";
    if (code === "PROVIDER_INPUT_INVALID" || code === "API_BODY_INVALID" || code === "PROVIDER_EXTRA_HEADERS_INVALID") return "input";
    if (code === "AUTH_REQUIRED" || code === "AUTH_SESSION_EXPIRED") return "session";
    return "generic";
  }

  function safeErrorDetailValue(key, value) {
    if (key === "field") {
      return typeof value === "string" && SAFE_ERROR_FIELDS.has(value) ? value : null;
    }
    if (key === "reason") {
      if (typeof value !== "string") return null;
      const reason = value.trim().toLowerCase().replaceAll("-", "_");
      return SAFE_ERROR_REASONS.has(reason) ? t(`errors.reason.${reason}`) : null;
    }
    if (key === "committed" || key === "degraded") {
      return typeof value === "boolean" ? t(`errors.value.${value ? "yes" : "no"}`) : null;
    }
    if (key === "generation") {
      return Number.isSafeInteger(value) && value >= 0 ? numberFormatter.format(value) : null;
    }
    if (key === "httpStatus") {
      return Number.isSafeInteger(value) && value >= 100 && value <= 599
        ? numberFormatter.format(value)
        : null;
    }
    return null;
  }

  function technicalRow(label, value) {
    return node("div", { className: "error-detail-row" }, [
      node("dt", { text: label }),
      node("dd", { text: value })
    ]);
  }

  function errorPanel(error) {
    const normalized = error instanceof UiError ? error : new UiError(error);
    const group = errorGroup(normalized);
    const technicalRows = [technicalRow(t("errors.codeLabel"), normalized.code)];
    if (normalized.requestId) {
      technicalRows.push(technicalRow(t("errors.requestIdLabel"), normalized.requestId));
    }
    for (const [key, value] of Object.entries(normalized.details)) {
      const safeValue = safeErrorDetailValue(key, value);
      if (safeValue !== null) {
        technicalRows.push(technicalRow(t(`errors.detail.${key}`), safeValue));
      }
    }
    return node("div", { className: "error-panel", attributes: { role: "alert" } }, [
      node("span", { text: "!", attributes: { "aria-hidden": "true" } }),
      node("div", { className: "error-content" }, [
        node("strong", { text: t(`errors.${group}.title`) }),
        node("span", { text: t(`errors.${group}.action`) }),
        node("details", { className: "error-technical" }, [
          node("summary", { text: t("errors.technical") }),
          node("dl", {}, technicalRows)
        ])
      ])
    ]);
  }

  function announce(message) {
    elements.live.textContent = "";
    requestAnimationFrame(() => {
      elements.live.textContent = message;
    });
  }

  function confirmAction({ translate, trigger }) {
    if (elements.confirmDialog.open) return Promise.resolve(false);
    confirmTranslator = () => {
      const copy = translate();
      elements.confirmTitle.textContent = copy.title;
      elements.confirmMessage.textContent = copy.message;
      elements.confirmCancel.textContent = t("actions.cancel");
      elements.confirmAccept.textContent = copy.confirmLabel;
    };
    confirmTranslator();
    confirmTrigger = trigger ?? document.activeElement;
    elements.confirmDialog.showModal();
    elements.confirmCancel.focus();
    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  function finishConfirmation(accepted) {
    if (!elements.confirmDialog.open) return;
    elements.confirmDialog.close(accepted ? "confirm" : "cancel");
    settleConfirmation(accepted);
  }

  function settleConfirmation(accepted, restoreFocus = true) {
    const resolver = confirmResolver;
    const trigger = confirmTrigger;
    confirmResolver = null;
    confirmTrigger = null;
    confirmTranslator = null;
    resolver?.(accepted);
    if (restoreFocus) trigger?.focus({ preventScroll: true });
  }

  function createModal({ title, help, trigger }) {
    const dialog = node("dialog", { attributes: { "aria-labelledby": `modal-${Date.now()}` } });
    const titleId = dialog.getAttribute("aria-labelledby");
    const body = node("div", { className: "modal-body" });
    const footer = node("div", { className: "modal-footer" });
    const titleElement = node("h2", { text: title, attributes: { id: titleId } });
    const helpElement = node("p", { text: help });
    dialog.append(
      node("header", { className: "modal-header" }, [titleElement, helpElement]),
      body,
      footer
    );
    dialog.addEventListener("close", () => {
      activeDialogTranslator = null;
      activeDialogSecretClearer = null;
      dialog.remove();
      trigger?.focus({ preventScroll: true });
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    return { dialog, body, footer, titleElement, helpElement };
  }

  function clearSecretDrafts() {
    state.onboarding.draft.credential = "";
    activeDialogSecretClearer?.();
    for (const input of document.querySelectorAll("input[type='password']")) input.value = "";
  }

  function terminateSession(error) {
    if (state.authTerminal) return;
    state.authTerminal = true;
    state.csrfToken = null;
    state.mutationAllowed = false;
    state.pending = false;
    state.readOnlyReason = null;
    state.pageError = error;
    activeLoadController?.abort();
    activeLoadController = null;
    clearSecretDrafts();
    for (const dialog of document.querySelectorAll("dialog[open]")) {
      if (dialog === elements.confirmDialog) {
        dialog.close("session-expired");
        settleConfirmation(false, false);
      }
      else {
        dialog.close("session-expired");
        dialog.remove();
      }
    }
    activeDialogTranslator = null;
    activeDialogSecretClearer = null;
    elements.main.replaceChildren();
    elements.onboardingMain.replaceChildren();
    updateChrome();
    document.documentElement.setAttribute("aria-busy", "false");
  }

  async function parseResponse(response) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new UiError("INTERNAL_ERROR", response.status);
    }
    if (!response.ok) {
      const code = typeof payload?.error?.code === "string" ? payload.error.code : "INTERNAL_ERROR";
      const error = new UiError(code, response.status, {
        requestId: payload?.error?.requestId,
        details: payload?.error?.details
      });
      if (response.status === 401
        || response.status === 403 && SESSION_TERMINAL_ERROR_CODES.has(error.code)) {
        terminateSession(error);
      }
      throw error;
    }
    return payload;
  }

  async function exchangeSession(controlToken) {
    const response = await fetch("/api/v1/session", {
      method: "POST",
      headers: { authorization: `Bearer ${controlToken}` },
      credentials: "same-origin"
    });
    const payload = await parseResponse(response);
    state.csrfToken = payload.csrfToken;
    state.mutationAllowed = true;
    state.readOnlyReason = null;
  }

  async function requestJson(path, { method = "GET", body = EMPTY_BODY, signal } = {}) {
    if (state.authTerminal) throw state.pageError ?? new UiError("AUTH_REQUIRED", 401);
    const headers = {};
    const mutation = method !== "GET" && method !== "HEAD";
    if (mutation) {
      if (!state.mutationAllowed || typeof state.csrfToken !== "string") {
        throw new UiError("AUTH_REQUIRED", 401);
      }
      headers["x-crp-csrf"] = state.csrfToken;
    }
    const options = {
      method,
      headers,
      credentials: "same-origin",
      signal
    };
    if (body !== EMPTY_BODY) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return await parseResponse(await fetch(path, options));
  }

  async function loadWorkspace() {
    if (state.authTerminal) return false;
    activeLoadController?.abort();
    const controller = new AbortController();
    activeLoadController = controller;
    const [status, providers, activity, settings] = await Promise.all([
      requestJson("/api/v1/status", { signal: controller.signal }),
      requestJson("/api/v1/providers", { signal: controller.signal }),
      requestJson(`/api/v1/activity?limit=${ACTIVITY_PAGE_SIZE}&offset=0`, { signal: controller.signal }),
      requestJson("/api/v1/settings", { signal: controller.signal })
    ]);
    if (state.authTerminal || controller.signal.aborted) return false;
    activeLoadController = null;
    state.status = status;
    state.providers = providers.providers;
    state.events = activity.events;
    state.activityOffset = 0;
    state.activityNextOffset = activity.page?.nextOffset ?? null;
    state.settings = settings.settings;
    return true;
  }

  async function runMutation(operation) {
    if (state.pending || !state.mutationAllowed || state.authTerminal) return null;
    state.pending = true;
    state.pageError = null;
    render();
    try {
      return await operation();
    } catch (error) {
      if (!state.authTerminal) {
        state.pageError = error instanceof UiError ? error : new UiError("INTERNAL_ERROR");
      }
      return null;
    } finally {
      state.pending = false;
      if (!state.authTerminal) render();
    }
  }

  async function runRead(operation) {
    if (state.pending || state.authTerminal) return null;
    state.pending = true;
    state.pageError = null;
    render();
    try {
      return await operation();
    } catch (error) {
      if (!state.authTerminal) {
        state.pageError = error instanceof UiError ? error : new UiError("INTERNAL_ERROR");
      }
      return null;
    } finally {
      state.pending = false;
      if (!state.authTerminal) render();
    }
  }

  function bindDraftControl(control, draft, key, onDirty = () => {}) {
    const update = () => {
      draft[key] = control.type === "checkbox" ? control.checked : control.value;
      onDirty();
    };
    control.addEventListener("input", update);
    control.addEventListener("change", update);
  }

  function parseExtraHeaders(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new UiError("PROVIDER_EXTRA_HEADERS_INVALID", 400, {
        details: { field: "extraHeaders", reason: "invalid JSON" }
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.values(parsed).some((value) => typeof value !== "string")) {
      throw new UiError("PROVIDER_EXTRA_HEADERS_INVALID", 400, {
        details: { field: "extraHeaders", reason: "must be a string map" }
      });
    }
    return parsed;
  }

  function providerInputFromDraft(draft) {
    return {
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      authHeader: draft.authHeader.trim(),
      authScheme: draft.authScheme.trim(),
      extraHeaders: parseExtraHeaders(draft.extraHeaders),
      modelMode: draft.modelMode,
      modelOverride: draft.modelMode === "override" ? draft.modelOverride.trim() : null
    };
  }

  function takeCredential(draft, input) {
    const credential = draft.credential;
    draft.credential = "";
    input.value = "";
    return credential;
  }

  function validateProviderForm(form, credentialInput, credential, credentialRequired) {
    const wasRequired = credentialInput.required;
    credentialInput.required = false;
    const publicFieldsValid = form.reportValidity();
    credentialInput.required = wasRequired;
    const credentialValid = !credentialRequired || credential.length > 0;
    if (!credentialValid) credentialInput.reportValidity();
    return publicFieldsValid && credentialValid;
  }

  function updateDraftFromProvider(draft, provider) {
    draft.name = provider.name;
    draft.baseUrl = provider.baseUrl;
    draft.credential = "";
    draft.authHeader = provider.authHeader;
    draft.authScheme = provider.authScheme;
    draft.extraHeaders = JSON.stringify(provider.extraHeaders ?? {}, null, 2);
    draft.modelMode = provider.modelMode;
    draft.modelOverride = provider.modelOverride ?? "";
  }

  function buildProviderFields(draft, {
    credentialLabelKey,
    credentialHelpKey,
    credentialRequired,
    includeFallback,
    onDirty,
    onStructureChange
  }) {
    const name = field({
      label: t("onboarding.name"),
      name: "name",
      value: draft.name,
      placeholder: t("onboarding.namePlaceholder")
    });
    name.labelElement.dataset.copyKey = "onboarding.name";
    name.input.dataset.placeholderKey = "onboarding.namePlaceholder";
    const baseUrl = field({
      label: t("onboarding.baseUrl"),
      name: "baseUrl",
      type: "url",
      value: draft.baseUrl,
      placeholder: t("onboarding.baseUrlPlaceholder")
    });
    baseUrl.labelElement.dataset.copyKey = "onboarding.baseUrl";
    baseUrl.input.dataset.placeholderKey = "onboarding.baseUrlPlaceholder";
    baseUrl.wrapper.classList.add("is-wide");
    const credential = field({
      label: t(credentialLabelKey),
      name: "credential",
      type: "password",
      value: "",
      help: t(credentialHelpKey),
      required: credentialRequired
    });
    credential.input.value = draft.credential;
    credential.labelElement.dataset.copyKey = credentialLabelKey;
    credential.helpElement.dataset.copyKey = credentialHelpKey;
    const testModel = field({
      label: t("onboarding.testModel"),
      name: "model",
      value: draft.testModel
    });
    testModel.labelElement.dataset.copyKey = "onboarding.testModel";
    for (const [control, key] of [
      [name.input, "name"],
      [baseUrl.input, "baseUrl"],
      [credential.input, "credential"],
      [testModel.input, "testModel"]
    ]) bindDraftControl(control, draft, key, onDirty);

    const controls = [name.wrapper, baseUrl.wrapper, credential.wrapper, testModel.wrapper];
    if (includeFallback) {
      const fallback = node("input", {
        attributes: { name: "fallbackConsent", type: "checkbox" }
      });
      fallback.disabled = !state.mutationAllowed || state.pending;
      fallback.checked = draft.fallbackConsent;
      bindDraftControl(fallback, draft, "fallbackConsent", onDirty);
      const fallbackLabel = node("span", { text: t("onboarding.fallback") });
      fallbackLabel.dataset.copyKey = "onboarding.fallback";
      const fallbackHelp = node("small", { text: t("onboarding.fallbackHelp") });
      fallbackHelp.dataset.copyKey = "onboarding.fallbackHelp";
      controls.push(node("label", { className: "checkbox-field" }, [
        fallback,
        node("span", {}, [fallbackLabel, fallbackHelp])
      ]));
    } else {
      const fallbackHelp = node("p", { className: "form-field is-wide", text: t("providers.fallbackEditHelp") });
      fallbackHelp.dataset.copyKey = "providers.fallbackEditHelp";
      controls.push(fallbackHelp);
    }

    const advanced = node("input", { attributes: { type: "checkbox", name: "advanced" } });
    advanced.disabled = !state.mutationAllowed || state.pending;
    advanced.checked = draft.advanced;
    advanced.addEventListener("change", () => {
      draft.advanced = advanced.checked;
      onDirty();
      onStructureChange();
    });
    const advancedLabel = node("span", { text: t("onboarding.advanced") });
    advancedLabel.dataset.copyKey = "onboarding.advanced";
    const advancedHelp = node("small", { text: t("onboarding.advancedHelp") });
    advancedHelp.dataset.copyKey = "onboarding.advancedHelp";
    controls.push(node("label", { className: "checkbox-field" }, [
      advanced,
      node("span", {}, [advancedLabel, advancedHelp])
    ]));

    if (draft.advanced) {
      const authHeader = field({
        label: t("onboarding.authHeader"),
        name: "authHeader",
        value: draft.authHeader
      });
      const authScheme = field({
        label: t("onboarding.authScheme"),
        name: "authScheme",
        value: draft.authScheme,
        required: false
      });
      authHeader.labelElement.dataset.copyKey = "onboarding.authHeader";
      authScheme.labelElement.dataset.copyKey = "onboarding.authScheme";
      const extraHeaders = textareaField({
        label: t("onboarding.extraHeaders"),
        name: "extraHeaders",
        value: draft.extraHeaders,
        help: t("onboarding.extraHeadersHelp")
      });
      extraHeaders.labelElement.dataset.copyKey = "onboarding.extraHeaders";
      extraHeaders.helpElement.dataset.copyKey = "onboarding.extraHeadersHelp";
      const modelMode = selectField({
        label: t("onboarding.modelMode"),
        name: "modelMode",
        value: draft.modelMode,
        options: [
          { value: "passthrough", label: t("onboarding.passthrough") },
          { value: "override", label: t("onboarding.override") }
        ]
      });
      modelMode.labelElement.dataset.copyKey = "onboarding.modelMode";
      modelMode.input.options[0].dataset.copyKey = "onboarding.passthrough";
      modelMode.input.options[1].dataset.copyKey = "onboarding.override";
      for (const [control, key] of [
        [authHeader.input, "authHeader"],
        [authScheme.input, "authScheme"],
        [extraHeaders.input, "extraHeaders"]
      ]) bindDraftControl(control, draft, key, onDirty);
      modelMode.input.addEventListener("change", () => {
        draft.modelMode = modelMode.input.value;
        onDirty();
        onStructureChange();
      });
      controls.push(authHeader.wrapper, authScheme.wrapper, extraHeaders.wrapper, modelMode.wrapper);
      if (draft.modelMode === "override") {
        const override = field({
          label: t("onboarding.modelOverride"),
          name: "modelOverride",
          value: draft.modelOverride
        });
        override.labelElement.dataset.copyKey = "onboarding.modelOverride";
        bindDraftControl(override.input, draft, "modelOverride", onDirty);
        controls.push(override.wrapper);
      }
    }
    return { controls, credential };
  }

  function renderOnboarding() {
    const phase = state.onboarding.phase;
    const draft = state.onboarding.draft;
    const stepIndex = phase === "create" ? 0 : phase === "test" ? 1 : 2;
    const steps = [
      t("onboarding.stepDetails"),
      t("onboarding.stepTest"),
      t("onboarding.stepActivate")
    ];
    const stepList = node("div", { className: "step-list" }, steps.map((copy, index) => (
      node("div", {
        className: `step-item ${index === stepIndex ? "is-active" : ""} ${index < stepIndex ? "is-complete" : ""}`.trim()
      }, [
        node("span", { text: index < stepIndex ? "✓" : numberFormatter.format(index + 1) }),
        node("strong", { text: copy })
      ])
    )));
    const intro = node("section", { className: "onboarding-intro" }, [
      node("span", { className: "eyebrow", text: t("onboarding.eyebrow") }),
      node("h1", { text: t("onboarding.title") }),
      node("p", { text: t("onboarding.subtitle") }),
      stepList
    ]);
    const formRegion = node("section", { className: "onboarding-form" });
    if (state.pageError && errorGroup(state.pageError) !== "session") {
      formRegion.append(errorPanel(state.pageError));
    }
    if (phase !== "create") {
      formRegion.append(node("div", { className: "inline-notice" }, [
        node("span", { text: "✓", attributes: { "aria-hidden": "true" } }),
        node("strong", { text: t("onboarding.saved") })
      ]));
    }
    formRegion.append(
      node("h2", { text: phase === "create" ? t("onboarding.formTitle") : t("onboarding.testTitle") }),
      node("p", { text: phase === "create" ? t("onboarding.formHelp") : t("onboarding.retryHelp") })
    );

    const form = node("form", { className: "form-grid" });
    const onDirty = phase === "create" ? () => {} : () => {
      state.onboarding.dirty = true;
      state.onboarding.phase = "test";
    };
    const built = buildProviderFields(draft, {
      credentialLabelKey: phase === "create" ? "onboarding.apiKey" : "providers.replacement",
      credentialHelpKey: phase === "create" ? "onboarding.apiKeyHelp" : "providers.replacementHelp",
      credentialRequired: phase === "create",
      includeFallback: phase === "create",
      onDirty,
      onStructureChange: render
    });
    form.append(...built.controls);
    activeDialogSecretClearer = null;

    const actions = node("div", { className: "form-actions" });
    if (phase === "create") {
      const submit = button(t("onboarding.save"), "primary-button");
      submit.type = "submit";
      actions.append(submit);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (state.pending) return;
        const credential = takeCredential(draft, built.credential.input);
        if (!validateProviderForm(form, built.credential.input, credential, true)) return;
        const payload = await runMutation(async () => await requestJson("/api/v1/providers", {
          method: "POST",
          body: {
            provider: providerInputFromDraft(draft),
            credential,
            fallbackConsent: draft.fallbackConsent
          }
        }));
        if (payload && !state.authTerminal) {
          state.onboarding.providerId = payload.provider.id;
          state.onboarding.phase = "test";
          state.onboarding.dirty = false;
          updateDraftFromProvider(draft, payload.provider);
          state.providers = [payload.provider];
          announce(t("announcements.providerSaved"));
          render();
        }
      });
    } else {
      const testProvider = button(t("onboarding.test"), "secondary-button");
      testProvider.addEventListener("click", async () => {
        if (state.pending) return;
        const replacementCredential = takeCredential(draft, built.credential.input);
        if (!validateProviderForm(form, built.credential.input, replacementCredential, false)) return;
        const payload = await runMutation(async () => {
          if (state.onboarding.dirty || replacementCredential.length > 0) {
            const updated = await requestJson(
              `/api/v1/providers/${encodeURIComponent(state.onboarding.providerId)}`,
              {
                method: "PATCH",
                body: {
                  patch: providerInputFromDraft(draft),
                  ...(replacementCredential.length > 0
                    ? { replacementCredential }
                    : {})
                }
              }
            );
            updateDraftFromProvider(draft, updated.provider);
            state.onboarding.dirty = false;
          }
          return await requestJson(
            `/api/v1/providers/${encodeURIComponent(state.onboarding.providerId)}/test`,
            { method: "POST", body: { model: draft.testModel.trim() } }
          );
        });
        if (payload?.result?.ok === true) {
          state.onboarding.phase = "activate";
          state.pageError = null;
          announce(t("announcements.compatible"));
        } else if (payload?.result?.code) {
          state.onboarding.phase = "test";
          state.pageError = new UiError(payload.result.code, 200);
        }
        if (!state.authTerminal) render();
      });
      actions.append(testProvider);
      if (phase === "activate" && !state.onboarding.dirty) {
        formRegion.append(node("div", { className: "inline-notice" }, [
          node("span", { text: "✓", attributes: { "aria-hidden": "true" } }),
          node("div", {}, [
            node("strong", { text: t("onboarding.compatible") }),
            node("span", { text: t("onboarding.compatibleHelp") })
          ])
        ]));
        const activate = button(t("onboarding.activate"), "primary-button");
        activate.addEventListener("click", async () => {
          if (state.onboarding.dirty) {
            state.pageError = new UiError("PROVIDER_NOT_READY", 409);
            state.onboarding.phase = "test";
            render();
            return;
          }
          const completed = await runMutation(async () => {
            await requestJson(`/api/v1/providers/${encodeURIComponent(state.onboarding.providerId)}/activate`, { method: "POST" });
            await requestJson("/api/v1/codex/bootstrap", { method: "POST" });
            await requestJson("/api/v1/proxy/start", { method: "POST" });
            return await loadWorkspace();
          });
          if (completed && !state.authTerminal) {
            state.route = "overview";
            announce(t("announcements.proxyStarted"));
            render();
          }
        });
        actions.append(activate);
      }
    }
    form.append(actions);
    formRegion.append(form);
    return node("section", { className: "onboarding-panel" }, [intro, formRegion]);
  }

  function compatibility(provider) {
    const status = provider?.lastTestStatus ?? "untested";
    return node("span", {
      className: `compatibility is-${status}`,
      text: t(`compatibility.${status}`)
    });
  }

  function activityCategory(category) {
    const normalized = ACTIVITY_CATEGORIES.has(category) ? category : "unknown";
    return t(`activity.category.${normalized}`);
  }

  function activityNeedsRepair(event) {
    return typeof event.errorCode === "string"
        && (event.errorCode.includes("DEGRADED") || event.errorCode.includes("COMMITTED"))
      || event.details?.rollbackDegraded === true
      || event.details?.degraded === true
      || event.details?.committed === true;
  }

  function renderActivityList(events, limit = 4) {
    const list = node("div", { className: "activity-list" });
    if (events.length === 0) {
      list.append(node("p", { className: "empty-state", text: t("overview.noActivity") }));
      return list;
    }
    for (const event of events.slice(0, limit)) {
      const actionKey = `activity.${event.action}`;
      const provider = state.providers.find((item) => item.id === event.providerId);
      const result = ["success", "failed", "degraded"].includes(event.result)
        ? event.result
        : "failed";
      const repairRequired = result === "degraded" || activityNeedsRepair(event);
      list.append(node("div", { className: "activity-row" }, [
        node("time", {
          text: event.timestamp ? dateFormatter.format(new Date(event.timestamp)) : "--:--:--",
          attributes: { datetime: event.timestamp }
        }),
        node("span", { className: "activity-copy" }, [
          node("span", { className: "activity-summary" }, [
            node("strong", { text: t(actionKey) }),
            provider ? node("span", { text: provider.name }) : null
          ]),
          node("span", { className: "activity-meta" }, [
            node("small", {
              text: t("activity.category", { value: activityCategory(event.category) })
            }),
            event.providerId
              ? node("small", {
                text: t("activity.providerId", { value: event.providerId })
              })
              : null,
            event.errorCode
              ? node("small", {
                text: t("activity.errorCode", { value: event.errorCode })
              })
              : null
          ])
        ]),
        node("span", { className: "activity-result-cell" }, [
          node("strong", {
            className: `activity-result ${result === "failed" ? "is-failure" : ""} ${result === "degraded" ? "is-degraded" : ""}`.trim(),
            text: t(`activity.${result}`)
          }),
          repairRequired
            ? node("small", { text: t("activity.degradedAction") })
            : null
        ])
      ]));
    }
    return list;
  }

  function renderOverview() {
    const fragment = document.createDocumentFragment();
    const heading = pageHeading(t("titles.overview"), t("overview.subtitle"));
    const updated = heading.lastElementChild;
    const headingActions = node("div", { className: "page-heading-actions" });
    updated.replaceWith(headingActions);
    headingActions.append(updated);
    fragment.append(heading);
    if (state.pageError && errorGroup(state.pageError) !== "session") {
      fragment.append(errorPanel(state.pageError));
    }

    const active = state.status?.activeProvider ?? null;
    const worker = state.status?.worker ?? null;
    const running = worker?.phase === "running" && worker?.state?.listening === true;
    const inFlight = worker?.state?.inFlight ?? 0;
    if (running) {
      const stop = button(t("overview.stopWorker"), "secondary-button");
      stop.addEventListener("click", () => void lifecycleWorker("stop", stop));
      const restart = button(t("overview.restartWorker"), "secondary-button");
      restart.addEventListener("click", () => void restartWorker(restart));
      headingActions.append(stop, restart);
    } else {
      const start = button(t("overview.startWorker"), "primary-button");
      start.addEventListener("click", () => void lifecycleWorker("start", start));
      headingActions.append(start);
    }
    if (worker?.error?.code) fragment.append(errorPanel(new UiError(worker.error.code)));
    const statusBand = node("section", {
      className: `status-band ${running ? "" : "is-warning"}`.trim()
    }, [
      node("div", { className: "status-primary" }, [
        node("div", { className: "status-title" }, [
          node("span", { className: "status-dot", attributes: { "aria-hidden": "true" } }),
          node("span", { text: t(running ? "overview.proxyReady" : "overview.proxyStopped") })
        ]),
        node("p", {
          text: running
            ? t("overview.readyDetail", { name: active?.name ?? "CRP" })
            : t("overview.stoppedDetail")
        })
      ]),
      node("div", { className: "metric" }, [
        node("span", { className: "metric-label", text: t("overview.proxyAddress") }),
        node("strong", { text: `:${state.settings?.proxyPort ?? 15100}` }),
        node("small", { text: t("overview.fixedLoopback") })
      ]),
      node("div", { className: "metric" }, [
        node("span", { className: "metric-label", text: t("overview.worker") }),
        node("strong", {
          text: worker?.pid ? t("overview.pid", { value: worker.pid }) : t("overview.notRunning")
        }),
        node("small", { text: t("overview.generation", { value: numberFormatter.format(state.status?.generation ?? 0) }) })
      ]),
      node("div", { className: "metric" }, [
        node("span", { className: "metric-label", text: t("overview.inFlight") }),
        node("strong", { text: numberFormatter.format(inFlight) }),
        node("small", { text: t("overview.safeRestart") })
      ])
    ]);
    fragment.append(statusBand);

    const manageProviders = node("button", {
      className: "text-button",
      text: t("overview.manageProviders"),
      attributes: { type: "button" }
    });
    manageProviders.addEventListener("click", () => navigateTo("providers"));
    const activeHeading = node("div", { className: "section-heading" }, [
      node("h2", { text: t("overview.activeProvider") }),
      manageProviders
    ]);
    const quickSelect = node("select", { attributes: { "aria-label": t("overview.quickSwitch") } });
    quickSelect.disabled = !state.mutationAllowed || state.pending;
    for (const provider of state.providers) {
      const option = node("option", {
        text: provider.name,
        attributes: { value: provider.id }
      });
      option.selected = provider.id === state.status?.activeProviderId;
      quickSelect.append(option);
    }
    const switchButton = button(t("overview.switchProvider"), "secondary-button");
    switchButton.disabled = switchButton.disabled || quickSelect.value === state.status?.activeProviderId;
    quickSelect.addEventListener("change", () => {
      switchButton.disabled = !state.mutationAllowed
        || state.pending
        || quickSelect.value === state.status?.activeProviderId;
    });
    switchButton.addEventListener("click", async () => {
      const providerId = quickSelect.value;
      const switched = await runMutation(async () => {
        await requestJson(`/api/v1/providers/${encodeURIComponent(providerId)}/activate`, {
          method: "POST"
        });
        await loadWorkspace();
        return true;
      });
      if (switched) {
        announce(t("announcements.providerSwitched"));
        render();
      }
    });
    const providerBand = node("section", { className: "provider-band" }, [
      node("div", { className: "provider-identity" }, [
        node("span", { className: "provider-avatar", text: active?.name?.charAt(0)?.toUpperCase() ?? "P" }),
        node("span", {}, [
          node("strong", { text: active?.name ?? "-" }),
          node("small", { text: t("overview.activeConfigured") })
        ])
      ]),
      node("div", { className: "data-pair" }, [
        node("span", { className: "eyebrow", text: t("onboarding.baseUrl") }),
        node("strong", { text: active?.baseUrl ?? "-" })
      ]),
      node("div", { className: "data-pair" }, [
        node("span", { className: "eyebrow", text: t("onboarding.stepTest") }),
        compatibility(active)
      ]),
      node("div", { className: "quick-switch" }, [
        node("span", { className: "eyebrow", text: t("overview.quickSwitch") }),
        quickSelect,
        switchButton
      ])
    ]);
    fragment.append(activeHeading, providerBand);

    const viewAll = node("button", {
      className: "text-button",
      text: t("overview.viewAll"),
      attributes: { type: "button" }
    });
    viewAll.addEventListener("click", () => navigateTo("activity"));
    const activityHeading = node("div", { className: "section-heading" }, [
      node("h2", { text: t("overview.recentActivity") }),
      viewAll
    ]);
    const runtimeHeading = node("div", { className: "section-heading" }, [
      node("h2", { text: t("overview.runtime") })
    ]);
    const runtime = node("section", { className: "runtime-panel" }, [
      runtimeRow(t("overview.supervisor"), t("overview.pid", { value: state.status?.supervisor?.pid ?? "-" })),
      runtimeRow(t("overview.codexProvider"), state.status?.codex?.modelProvider ?? "-"),
      runtimeRow(t("overview.credentialStore"), state.settings?.credentialBackend === "native"
        ? t("settings.native")
        : state.settings?.credentialBackend ?? "-"),
      runtimeRow(t("overview.sessionExpires"), t("overview.minutes", { value: numberFormatter.format(60) })),
      node("p", { className: "runtime-note", text: state.status?.codex?.proxyUrl ?? t("overview.readOnlyNote") })
    ]);
    fragment.append(node("div", { className: "overview-lower" }, [
      node("div", {}, [activityHeading, renderActivityList(state.events)]),
      node("div", {}, [runtimeHeading, runtime])
    ]));
    return fragment;
  }

  async function restartWorker(trigger) {
    const inFlight = state.status?.worker?.state?.inFlight ?? 0;
    if (inFlight > 0) {
      const accepted = await confirmAction({
        translate: () => ({
          title: t("restart.title"),
          message: t("restart.message", { count: numberFormatter.format(inFlight) }),
          confirmLabel: t("restart.confirm")
        }),
        trigger
      });
      if (!accepted) return;
    }
    const restarted = await runMutation(async () => {
      await requestJson("/api/v1/proxy/restart", { method: "POST" });
      await loadWorkspace();
      return true;
    });
    if (restarted) {
      announce(t("announcements.workerRestarted"));
      render();
    }
  }

  async function lifecycleWorker(action, trigger) {
    const completed = await runMutation(async () => {
      await requestJson(`/api/v1/proxy/${action}`, { method: "POST" });
      return await loadWorkspace();
    });
    if (completed && !state.authTerminal) {
      announce(t(action === "start" ? "announcements.workerStarted" : "announcements.workerStopped"));
      render();
      trigger?.focus({ preventScroll: true });
    }
  }

  function runtimeRow(label, value) {
    return node("div", { className: "runtime-row" }, [
      node("span", { text: label }),
      node("strong", { text: value })
    ]);
  }

  function renderProviders() {
    const fragment = document.createDocumentFragment();
    fragment.append(pageHeading(t("titles.providers"), t("providers.subtitle")));
    if (state.pageError && errorGroup(state.pageError) !== "session") {
      fragment.append(errorPanel(state.pageError));
    }
    const list = node("section", { className: "provider-list" });
    if (state.providers.length === 0) {
      list.append(node("p", { className: "empty-state", text: t("providers.empty") }));
    }
    for (const provider of state.providers) {
      const isActive = provider.id === state.status?.activeProviderId;
      const testProvider = button(t("nav.providers"), "text-button", {
        "aria-label": t("actions.testProvider", { name: provider.name })
      });
      testProvider.textContent = t("providers.testAction");
      testProvider.addEventListener("click", () => openTestDialog(provider, testProvider));

      const editProvider = button(t("actions.save"), "text-button", {
        "aria-label": t("actions.editProvider", { name: provider.name }),
        disabled: isActive
      });
      editProvider.textContent = t("providers.editAction");
      editProvider.addEventListener("click", () => openProviderEditor(provider, editProvider));

      const deleteProvider = button(t("providers.deleteConfirm"), "text-button danger-text", {
        "aria-label": t("actions.deleteProvider", { name: provider.name }),
        disabled: isActive
      });
      deleteProvider.textContent = t("providers.deleteAction");
      deleteProvider.addEventListener("click", () => void deleteProviderFlow(provider, deleteProvider));

      const activateProvider = button(t("providers.activateAction"), "text-button", {
        disabled: isActive || provider.lastTestStatus !== "passed"
      });
      activateProvider.addEventListener("click", async () => {
        const activated = await runMutation(async () => {
          await requestJson(`/api/v1/providers/${encodeURIComponent(provider.id)}/activate`, {
            method: "POST"
          });
          return await loadWorkspace();
        });
        if (activated && !state.authTerminal) {
          announce(t("announcements.providerActivated"));
          render();
        }
      });

      list.append(node("article", { className: "provider-row" }, [
        node("div", { className: "provider-identity" }, [
          node("span", { className: "provider-avatar", text: provider.name.charAt(0).toUpperCase() }),
          node("span", {}, [
            node("strong", { text: provider.name }),
            node("small", { text: provider.credentialConfigured ? t("overview.activeConfigured") : "-" })
          ])
        ]),
        node("div", { className: "data-pair" }, [
          node("span", { className: "eyebrow", text: t("onboarding.baseUrl") }),
          node("strong", { text: provider.baseUrl })
        ]),
        node("div", {}, [
          compatibility(provider),
          isActive ? node("span", { className: "active-label", text: ` • ${t("providers.active")}` }) : null,
          isActive ? node("small", { text: t("providers.activeEditReason") }) : null
        ]),
        node("div", { className: "provider-actions" }, [
          testProvider,
          activateProvider,
          editProvider,
          deleteProvider
        ])
      ]));
    }
    fragment.append(list);
    return fragment;
  }

  function openProviderEditor(provider, trigger) {
    if (!state.mutationAllowed || state.pending) return;
    const editing = provider !== null;
    const draft = createProviderDraft();
    if (editing) updateDraftFromProvider(draft, provider);
    draft.advanced = true;
    const modal = createModal({
      title: t(editing ? "providers.editTitle" : "providers.createTitle"),
      help: t(editing ? "providers.editHelp" : "providers.createHelp"),
      trigger
    });
    const formId = `provider-form-${Date.now()}`;
    const form = node("form", { className: "form-grid", attributes: { id: formId } });
    let built = null;
    let focusFrame = null;
    let rebuildVersion = 0;
    const rebuildFields = () => {
      rebuildVersion += 1;
      const version = rebuildVersion;
      if (focusFrame !== null) {
        cancelAnimationFrame(focusFrame);
        focusFrame = null;
      }
      const focusedElement = form.contains(document.activeElement) ? document.activeElement : null;
      const focusedName = focusedElement?.name ?? null;
      built = buildProviderFields(draft, {
        credentialLabelKey: editing ? "providers.replacement" : "onboarding.apiKey",
        credentialHelpKey: editing ? "providers.replacementHelp" : "onboarding.apiKeyHelp",
        credentialRequired: !editing,
        includeFallback: !editing,
        onDirty: () => {},
        onStructureChange: rebuildFields
      });
      form.replaceChildren(...built.controls);
      if (focusedName !== null) {
        focusFrame = requestAnimationFrame(() => {
          focusFrame = null;
          if (version !== rebuildVersion) return;
          const activeElement = document.activeElement;
          const noNewFocus = activeElement === focusedElement
            || activeElement === document.body
            || activeElement === document.documentElement
            || activeElement === modal.dialog;
          if (noNewFocus) {
            form.elements.namedItem(focusedName)?.focus({ preventScroll: true });
          }
        });
      }
    };
    rebuildFields();
    const cancel = node("button", {
      className: "secondary-button",
      text: t("actions.cancel"),
      attributes: { type: "button" }
    });
    cancel.addEventListener("click", () => modal.dialog.close("cancel"));
    const submit = node("button", {
      className: "primary-button",
      text: editing ? t("actions.save") : t("onboarding.save"),
      attributes: { type: "submit", form: formId }
    });
    modal.body.append(form);
    modal.footer.append(cancel, submit);
    activeDialogSecretClearer = () => {
      draft.credential = "";
      built.credential.input.value = "";
    };
    activeDialogTranslator = () => {
      modal.titleElement.textContent = t(editing ? "providers.editTitle" : "providers.createTitle");
      modal.helpElement.textContent = t(editing ? "providers.editHelp" : "providers.createHelp");
      cancel.textContent = t("actions.cancel");
      submit.textContent = t(editing ? "actions.save" : "onboarding.save");
      translateDynamicFields(form);
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.pending) return;
      const replacementCredential = takeCredential(draft, built.credential.input);
      if (!validateProviderForm(form, built.credential.input, replacementCredential, !editing)) return;
      submit.disabled = true;
      const saved = await runMutation(async () => {
        if (editing) {
          await requestJson(`/api/v1/providers/${encodeURIComponent(provider.id)}`, {
            method: "PATCH",
            body: {
              patch: providerInputFromDraft(draft),
              ...(replacementCredential.length > 0 ? { replacementCredential } : {})
            }
          });
        } else {
          await requestJson("/api/v1/providers", {
            method: "POST",
            body: {
              provider: providerInputFromDraft(draft),
              credential: replacementCredential,
              fallbackConsent: draft.fallbackConsent
            }
          });
        }
        return await loadWorkspace();
      });
      activeDialogSecretClearer?.();
      if (saved && !state.authTerminal) {
        modal.dialog.close("saved");
        announce(t("announcements.providerSaved"));
        render();
      } else if (!state.authTerminal) {
        submit.disabled = false;
      }
    });
    form.querySelector("input[name='name']")?.focus();
  }

  function openTestDialog(provider, trigger) {
    if (!state.mutationAllowed || state.pending) return;
    const modal = createModal({
      title: t("providers.testTitle"),
      help: t("onboarding.testHelp"),
      trigger
    });
    const formId = `test-form-${Date.now()}`;
    const form = node("form", { attributes: { id: formId } });
    const model = field({
      label: t("onboarding.testModel"),
      name: "model",
      value: state.onboarding.draft.testModel
    });
    bindDraftControl(model.input, state.onboarding.draft, "testModel");
    form.append(model.wrapper);
    const cancel = node("button", {
      className: "secondary-button",
      text: t("actions.cancel"),
      attributes: { type: "button" }
    });
    cancel.addEventListener("click", () => modal.dialog.close("cancel"));
    const submit = node("button", {
      className: "primary-button",
      text: t("providers.runTest"),
      attributes: { type: "submit", form: formId }
    });
    modal.body.append(form);
    modal.footer.append(cancel, submit);
    activeDialogTranslator = () => {
      modal.titleElement.textContent = t("providers.testTitle");
      modal.helpElement.textContent = t("onboarding.testHelp");
      model.labelElement.textContent = t("onboarding.testModel");
      cancel.textContent = t("actions.cancel");
      submit.textContent = t("providers.runTest");
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity() || state.pending) return;
      submit.disabled = true;
      const testModel = model.input.value.trim();
      const payload = await runMutation(async () => await requestJson(
        `/api/v1/providers/${encodeURIComponent(provider.id)}/test`,
        { method: "POST", body: { model: testModel } }
      ));
      if (payload?.result?.ok === true) {
        await loadWorkspace();
        state.pageError = null;
        modal.dialog.close("passed");
        announce(t("announcements.compatible"));
      } else if (!state.authTerminal) {
        state.pageError = new UiError(payload?.result?.code ?? "INTERNAL_ERROR");
        modal.dialog.close("failed");
      }
      if (!state.authTerminal) render();
    });
    model.input.focus();
  }

  async function deleteProviderFlow(provider, trigger) {
    if (provider.id === state.status?.activeProviderId) return;
    const accepted = await confirmAction({
      translate: () => ({
        title: t("providers.deleteTitle"),
        message: t("providers.deleteMessage", { name: provider.name }),
        confirmLabel: t("providers.deleteConfirm")
      }),
      trigger
    });
    if (!accepted) return;
    const deleted = await runMutation(async () => {
      await requestJson(`/api/v1/providers/${encodeURIComponent(provider.id)}`, {
        method: "DELETE"
      });
      await loadWorkspace();
      return true;
    });
    if (deleted) {
      announce(t("announcements.providerDeleted"));
      render();
    }
  }

  function renderActivity() {
    const fragment = document.createDocumentFragment();
    const heading = pageHeading(t("titles.activity"), t("activity.subtitle"));
    const exportButton = button(t("activity.export"), "secondary-button");
    exportButton.addEventListener("click", async () => {
      const exported = await runMutation(async () => {
        return await requestJson("/api/v1/diagnostics/export", { method: "POST" });
      });
      if (exported && !state.authTerminal) {
        state.diagnostics = exported.diagnostics;
        announce(t("announcements.diagnostics"));
        render();
      }
    });
    const updated = heading.lastElementChild;
    const headingActions = node("div", { className: "page-heading-actions" });
    updated.replaceWith(headingActions);
    headingActions.append(updated, exportButton);
    fragment.append(heading);
    if (state.pageError && errorGroup(state.pageError) !== "session") {
      fragment.append(errorPanel(state.pageError));
    }
    if (state.diagnostics) {
      fragment.append(node("div", { className: "inline-notice" }, [
        node("span", { text: "✓", attributes: { "aria-hidden": "true" } }),
        node("div", {}, [
          node("strong", { text: t("activity.diagnosticsTitle") }),
          node("span", {
            text: t("activity.diagnosticsCreatedAt", {
              value: state.diagnostics.generatedAt
                ? new Date(state.diagnostics.generatedAt).toLocaleString(locale)
                : "-"
            })
          }),
          node("small", {
            text: t("activity.diagnosticsCount", {
              value: numberFormatter.format(state.diagnostics.eventCount ?? 0)
            })
          })
        ])
      ]));
    }
    fragment.append(renderActivityList(state.events, state.events.length || 1));
    const loadPage = async (offset) => {
      const payload = await runRead(() => requestJson(
        `/api/v1/activity?limit=${ACTIVITY_PAGE_SIZE}&offset=${offset}`
      ));
      if (payload && !state.authTerminal) {
        state.events = payload.events;
        state.activityOffset = offset;
        state.activityNextOffset = payload.page?.nextOffset ?? null;
        announce(t("announcements.activityPage"));
        render();
      }
    };
    const previous = button(t("activity.previous"), "secondary-button", {
      disabled: state.activityOffset === 0,
      readOnlyAllowed: true
    });
    const next = button(t("activity.next"), "secondary-button", {
      disabled: state.activityNextOffset === null,
      readOnlyAllowed: true
    });
    previous.addEventListener("click", () => {
      void loadPage(Math.max(0, state.activityOffset - ACTIVITY_PAGE_SIZE));
    });
    next.addEventListener("click", () => {
      if (state.activityNextOffset !== null) void loadPage(state.activityNextOffset);
    });
    fragment.append(node("nav", {
      className: "form-actions pagination-actions",
      attributes: { "aria-label": t("titles.activity") }
    }, [previous, next]));
    return fragment;
  }

  function settingRow(label, value) {
    return node("div", { className: "setting-row" }, [
      node("dt", { text: label }),
      node("dd", { text: value })
    ]);
  }

  function renderSettings() {
    const fragment = document.createDocumentFragment();
    fragment.append(pageHeading(t("titles.settings"), t("settings.subtitle")));
    fragment.append(node("div", { className: "inline-notice" }, [
      node("span", { text: "i", attributes: { "aria-hidden": "true" } }),
      node("strong", { text: t("settings.readOnly") })
    ]));
    const proxyHost = state.settings?.proxyHost ?? "127.0.0.1";
    const adminHost = state.settings?.adminHost ?? "127.0.0.1";
    fragment.append(node("dl", { className: "settings-list" }, [
      settingRow(t("settings.proxy"), `${proxyHost}:${state.settings?.proxyPort ?? 15100}`),
      settingRow(t("settings.admin"), `${adminHost}:${state.settings?.adminPort ?? 15101}`),
      settingRow(t("settings.backend"), state.settings?.credentialBackend === "native"
        ? t("settings.native")
        : state.settings?.credentialBackend ?? "-"),
      settingRow(t("settings.capture"), state.settings?.captureEnabled
        ? t("settings.enabled")
        : t("settings.disabled")),
      settingRow(t("settings.codex"), state.status?.codex?.modelProvider ?? "-"),
      settingRow(t("settings.codexProxy"), state.status?.codex?.proxyUrl ?? "-")
    ]));
    return fragment;
  }

  function renderStub() {
    return node("section", {}, [
      pageHeading(t(`titles.${state.route}`), t(`${state.route}.subtitle`)),
      node("p", { className: "empty-state", text: t("stub.coming") })
    ]);
  }

  function render() {
    updateChrome();
    if (state.authTerminal || !state.ready) {
      document.documentElement.setAttribute("aria-busy", "false");
      return;
    }
    if (!state.status?.activeProviderId) {
      elements.main.replaceChildren();
      elements.onboardingMain.replaceChildren(renderOnboarding());
      document.documentElement.setAttribute("aria-busy", "false");
      return;
    }
    elements.onboardingMain.replaceChildren();
    const renderers = {
      overview: renderOverview,
      providers: renderProviders,
      activity: renderActivity,
      settings: renderSettings
    };
    const content = (renderers[state.route] ?? renderStub)();
    elements.main.replaceChildren(content);
    document.documentElement.setAttribute("aria-busy", "false");
  }

  function navigateTo(route) {
    if (!Object.hasOwn({ overview: true, providers: true, activity: true, settings: true }, route)) {
      return;
    }
    state.route = route;
    state.pageError = null;
    render();
    elements.main.focus({ preventScroll: true });
  }

  let controlToken = readAndClearControlToken();

  async function initialize() {
    applyStaticTranslations();
    elements.adminAddress.textContent = location.host;
    if (controlToken !== null) {
      try {
        await exchangeSession(controlToken);
      } catch (error) {
        if (!state.authTerminal) {
          terminateSession(error instanceof UiError ? error : new UiError("INTERNAL_ERROR"));
        }
      } finally {
        controlToken = null;
      }
    } else {
      state.readOnlyReason = "readonly";
    }

    if (state.authTerminal) return;
    try {
      const loaded = await loadWorkspace();
      if (!loaded || state.authTerminal) return;
      if (!state.status?.activeProviderId && state.providers.length > 0) {
        const provider = state.providers[0];
        state.onboarding.providerId = provider.id;
        state.onboarding.phase = provider.lastTestStatus === "passed" ? "activate" : "test";
        updateDraftFromProvider(state.onboarding.draft, provider);
      }
    } catch (error) {
      if (state.authTerminal) return;
      state.pageError = error instanceof UiError ? error : new UiError("INTERNAL_ERROR");
    }
    state.ready = true;
    render();
  }

  for (const localeControl of elements.localeControls) {
    localeControl.addEventListener("keydown", (event) => {
      const currentIndex = SUPPORTED_LOCALES.indexOf(localeControl.value);
      let nextIndex = null;
      if (event.key === "ArrowDown") nextIndex = Math.min(SUPPORTED_LOCALES.length - 1, currentIndex + 1);
      if (event.key === "ArrowUp") nextIndex = Math.max(0, currentIndex - 1);
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = SUPPORTED_LOCALES.length - 1;
      if (nextIndex === null || nextIndex === currentIndex) return;
      event.preventDefault();
      localeControl.value = SUPPORTED_LOCALES[nextIndex];
      localeControl.dispatchEvent(new Event("change", { bubbles: true }));
    });
    localeControl.addEventListener("change", () => {
      if (!SUPPORTED_LOCALES.includes(localeControl.value)) return;
      locale = localeControl.value;
      try {
        localStorage.setItem("crp.locale", locale);
      } catch {
        // Locale persistence is optional; no other state is written to storage.
      }
      applyStaticTranslations();
      if (!state.authTerminal) render();
    });
  }

  for (const link of document.querySelectorAll("[data-route]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigateTo(link.dataset.route);
    });
  }

  elements.refresh.addEventListener("click", async () => {
    if (state.pending || state.authTerminal) return;
    try {
      const loaded = await loadWorkspace();
      if (!loaded || state.authTerminal) return;
      state.pageError = null;
      announce(t("announcements.refreshed"));
    } catch (error) {
      if (state.authTerminal) return;
      state.pageError = error instanceof UiError ? error : new UiError("INTERNAL_ERROR");
    }
    if (!state.authTerminal) render();
  });

  elements.addProvider.addEventListener("click", () => {
    if (!state.mutationAllowed || state.pending) return;
    if (state.status?.activeProviderId) {
      openProviderEditor(null, elements.addProvider);
      return;
    }
    navigateTo("overview");
    elements.main.querySelector("input")?.focus();
  });

  elements.confirmCancel.addEventListener("click", () => finishConfirmation(false));
  elements.confirmAccept.addEventListener("click", () => finishConfirmation(true));
  elements.confirmDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finishConfirmation(false);
  });

  void initialize();
})();
