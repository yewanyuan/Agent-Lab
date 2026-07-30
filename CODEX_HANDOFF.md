# Agent Lab 新线程交接文档

> 更新时间：2026-07-22  
> 工作目录：`/home/det/python_project/Study/demo-project`  
> 当前目录不是 Git 仓库，不能依赖 commit、branch 或 `git status` 作为交接基线。应以本文件、当前源码和测试结果为准。

## 1. 项目目标和技术栈

### 1.1 项目目标

Agent Lab 是一个本地优先的 Agent 设计验证平台，主要面向 Agent 工程师和需要比较 Agent 架构方案的开发者。

核心目标不是生成通用的无代码 Agent，而是把 Agent 的模式、工具、控制机制、记忆、Guardrail、评测和 Harness 机制拆成可组合积木，使用户能够：

- 从最小可运行模板开始设计 Agent。
- 在画布中增删、复制、剪切、粘贴、连接和调整积木。
- 对单个积木实例修改代码，而不改变全局积木目录中的原始代码。
- 保存不可变版本并比较两个 Agent 设计的结构变化。
- 运行 Agent，查看节点级 Trace、输入输出和指标。
- 使用持久化评测集对两个版本执行成对 A/B 验证。
- 导入自定义 Python 积木，导出工程包或 Python 运行时代码。

当前产品形态是 Web 工作台加本地 Runner。Tauri 桌面端仍是后续方向。

### 1.2 技术栈

前端：

- React 18
- TypeScript 5
- Vite 6
- React Flow / `@xyflow/react`
- Zustand
- TanStack Query
- Monaco Editor
- Lucide React
- Vitest、Testing Library、Playwright

后端与运行时：

- Python
- FastAPI
- Pydantic v2
- SQLite
- Server-Sent Events（SSE）
- `httpx`
- 可选系统 Keyring
- Docker 或 Podman 隔离运行自定义 Python

## 2. 已实现功能

### 2.1 Agent 设计工作台

- React Flow 画布，支持拖放、连线、节点/连线选择与删除、平移、滚轮缩放、Minimap 和 Controls。
- 支持复制、剪切、粘贴、删除、Duplicate、Undo 和 Redo。
- 支持 Config、Code、Ports、Docs 四类 Inspector。
- Monaco 支持积木实例级 Python code override。
- 实例代码修改只影响当前图中的积木，不修改 catalog 原始定义。
- 支持图校验、运行、取消和节点状态反馈。
- 底部区域包含 Console、Trace、I/O、Metrics 和 Problems。Metrics 显示最近一次运行的真实 Token、耗时和费用（来自 `run_completed` 事件），费用不可得时显示 `—`，不再使用演示估值。
- 左侧 rail 的 Projects 按钮打开真正的项目列表弹窗：按更新时间列出 Runner 中已保存项目，支持打开、重命名、删除和"从模板新建"；删除当前项目会把工作区脱离为本地未保存状态；项目存在活动 run/evaluation 时删除返回 409 并提示稍后重试。
- Runs 视图支持行点击展开运行详情：远程 run 拉取 `GET /api/runs/{id}` 显示节点 span 表（状态、耗时、Token、费用）和脱敏后的输入输出；本地模拟 run 显示 trace 事件。
- 刷新会恢复上次已保存项目的最新 revision 和 Design/Runs/Evaluations/Versions 子视图；未保存图和代码不写入 localStorage。

### 2.2 模板和积木

- Tool Use / Augmented LLM
- ReAct
- Plan-and-Execute
- Router
- Supervisor Multi-Agent
- Memory-augmented Agent
- Harness Evolution Lab，包含有序的 `s01` 到 `s20` Harness 机制基线

Harness Lab 表达的是机制演进和组合流程，不应把 `s01-s20` 描述为二十个彼此完全独立的生产级 Agent。

### 2.3 工程、版本和运行

- 项目创建、更新、查询和删除。
- 不可变 revision，包含项目内 `sequence` 和 canonical graph SHA256 `graph_hash`。
- 保存、导入和导出 `.agentlab.zip` 工程包。
- Python code export ZIP。
- 持久化 Runs 列表、输入输出摘要、状态、时间和指标。
- 持久化节点 span 和 run event。
- Run SSE 支持执行过程回传，事件带 `id:` 序号并支持 `Last-Event-ID` 断点续传；内存缓存清理后可从数据库恢复事件。`run_completed` 事件携带完整 run metrics（Token 分项、duration_ms、cost_usd）。
- 保存项目、更新项目和新建 revision 的响应带 `credential_warnings`（凭据扫描警告，不阻断保存）。
- 工程导出与代码导出在图中发现疑似凭据时返回 422 和 finding 列表；`allow_secrets=true` 显式放行。前端弹确认框列出 finding 路径后重试。
- Runs CSV 导出包含 RFC 4180 quoting、公式注入防护和敏感内容脱敏。

### 2.4 自定义 Python 积木

- 上传 Python 文件后使用 AST 分析函数、类、参数、返回值和敏感 import。
- 自动生成自定义积木实例和入口配置。
- 自定义代码和所有 instance override 只能通过 Docker 或 Podman 运行。
- 无安全容器运行时时拒绝执行自定义代码，不回退到宿主机直接执行。

### 2.5 Provider 设置

- 支持 OpenAI、Anthropic 和 OpenAI-compatible Provider（openai-compatible 默认接受任意合法 base_url，免重启接入各类 LLM；可用 env allowlist 收紧）。
- 设置界面只提交新凭据，不读取或回显已保存凭据值。
- Provider Key 优先写入系统 Keyring；不可用时只保存在 Runner 会话内存。
- Provider Key 不进入项目、revision、Trace、SQLite 工程数据或导出包。
- 每个 Provider 可保存非敏感默认模型；节点 `config.model` 优先于 Runner 默认模型。
- Evaluation 固定创建时的 Provider/model snapshot，设置变化不会改变进行中的 baseline/candidate。

### 2.6 A/B 评测

- 独立 Evaluations 一级视图。
- 持久化 Eval Suite 创建、编辑、删除和 JSON 导入。
- 每个 case 包含名称、输入、期望值和 assertion。
- 当前 assertion 类型：`exact`、`contains`、`regex`、`json_schema`、`max_steps`、`tool_called`、`max_cost_usd`。断言逻辑位于 `apps/runner/assertions.py`，main.py re-export 保持兼容。
- `regex`：pattern 上限 512 字符、subject 截断 1 MiB、无效 pattern 安全失败；`json_schema` 使用 `jsonschema` 库，失败信息只含 JSON 路径不含输出值。
- 套件创建/更新前预校验断言（未知类型、无效 regex、非法 schema、非数值上限返回 422）。
- 套件编辑器支持每 case 多 assertion 列表编辑（增删行、类型下拉、json_schema 用 JSON 文本域）。
- 终态实验（completed/failed/partial/cancelled）在详情头部提供删除按钮，确认后调用删除 API；running/queued 只显示取消。
- 使用两个不可变 revision ID 进行 baseline/candidate 成对执行。
- 每个 case 严格先执行 baseline，再执行 candidate。
- 支持最大 case 数、Token、费用和总时长预算。
- 支持取消、partial 状态、持久化 evaluation event 和 SSE 进度。
- Evaluation SSE 带事件 ID，并支持 `Last-Event-ID`。
- 汇总 baseline/candidate pass rate、regression、improvement、unchanged、skipped、Token、费用和 stop reason。
- Case 状态包括 `both_pass`、`both_fail`、`regression`、`improvement` 和 `not_evaluable`。
- 评测结果输出和错误在持久化与展示前脱敏、限制大小。
- 版本化 Provider/model 价格注册表，包含官方来源和精确模型快照。
- 真实 Provider 调用记录 input/output Token、实际费用和价格表版本。
- A/B 在每次 Provider HTTP 请求前预留保守最坏费用；预算不足时不发请求。

### 2.7 版本对比

- Versions 使用真实服务端 revision ID 和 sequence，不使用浏览器本地自增编号作为事实来源。
- 用户可选择 baseline A 和 candidate B。
- Diff 区分 added、removed、modified、layout-only 和 edge changes。
- 对比 block type、source、version、config、code override 和位置。
- Config 和 code override 支持并排查看。
- SecretRef 和敏感配置使用原值判断是否变化，只在展示时脱敏。
- 对真正旧 schema 缺少 graph arrays 或 position 的情况使用安全默认值。

### 2.8 字体设置

- Settings 包含 Appearance 和 Providers。
- UI 字体支持 `90%`、`100%`、`110%`、`120%` 四档。
- 设置写入版本化的 `agentlab.ui.preferences.v1` localStorage 信封。
- 无效版本、损坏 JSON 或未知档位回退到 `100%`。
- localStorage 写入失败时保留当前浏览器会话中的内存设置。
- 字体偏好不进入 graph、revision、项目包或代码导出。
- 普通导航、面板、表单、日志、表格和弹窗随设置缩放。
- Canvas 节点、React Flow 控件和 Monaco 保持独立固定字号。

### 2.9 中英文界面

- 完整前端支持 English 与简体中文切换，首次按浏览器语言选择。
- 语言偏好写入 `agentlab.ui.locale.v1`，不进入项目或导出。
- 工作台、设置、模板、积木、Inspector、Runs、Versions 和 Evaluations 文案随语言切换。
- 默认 catalog 文案只在展示层翻译，不改写 graph；用户自定义名称和技术错误保持原文。

### 2.10 凭据扫描

- `apps/runner/scanner.py` 扫描工程图（block config、code_override、metadata）和导入的 Python 源码。
- 检测两类：敏感键名（复用 `SENSITIVE_KEY_PARTS`，`secret_ref` 豁免）和高置信度值模式（`sk-` 前缀 key、AWS AKIA、Bearer 长 token、带引号的凭据赋值）。
- Finding 只含 `path` 和 `kind`，绝不包含匹配到的值本身；模式刻意保守以避免误报噪音。
- 保存/更新/新 revision：响应附 `credential_warnings` 字符串数组，不阻断。
- 导出/代码导出：有 finding 时 422 + finding 列表，`allow_secrets=true` 显式放行。
- Python 导入：finding 并入返回的 `warnings`。

## 3. 当前前后端架构

### 3.1 前端架构

入口由 `main.tsx` 初始化 React 和 TanStack Query，`App.tsx` 中的 Workbench 负责整体布局和主要工作流。

状态分层：

- Editor Store：图节点、边、历史、选择、剪贴板、工作区身份、当前运行和底部面板状态。
- Preferences Store：设备级字体偏好。
- TanStack Query：Provider、Runs、Revisions、Eval Suites 和 Evaluations 等服务端状态。
- React 组件本地状态：Modal、选择器、评测进度和临时表单。

主要数据流：

1. React Flow 图通过 API adapter 转换为 Runner Graph IR。
2. 保存或运行时创建项目或新 revision。
3. Runner 创建绑定 revision 的 run。
4. 前端通过 SSE 接收节点事件，并通过查询接口恢复持久状态。
5. A/B 评测从 Eval Suite 和两个 revision 创建 evaluation。
6. Evaluation worker 创建普通 child runs，完成 assertion 和汇总。

当前没有前端 URL Router；设备级 workspace session 会恢复最后保存项目和当前子视图，但 URL 本身仍不可分享或深链。

### 3.2 Runner 架构

Runner 当前集中在单个 FastAPI 应用中，包含：

- Pydantic API 模型。
- SQLite Store 和 schema migration。
- 项目、revision、run、evaluation 和 provider 路由。
- 图验证和拓扑执行逻辑。
- SSE generator。
- Provider adapter。
- 版本化模型价格注册表和评测费用守卫。
- Python AST import、工程导入导出和代码导出。
- Docker/Podman 自定义代码执行器。

如果 `apps/web/dist` 存在，Runner 同时提供前端生产静态资源。

SQLite 默认位于 `~/.agentlab/runner.db`，可使用 `RUNNER_DB_PATH` 覆盖。

当前 schema `user_version=3`，主要表：

- `projects`
- `revisions`
- `runs`
- `run_events`
- `run_spans`
- `secrets`（只保存配置状态和存储类型，不保存 Key 值）
- `provider_settings`（只保存非敏感默认模型）
- `eval_suites`
- `evaluations`
- `evaluation_cases`
- `evaluation_events`

`evaluations.provider_snapshot` 固定实验创建时解析的 Provider 默认模型。

文件数据库启用 foreign keys 和 WAL。高于当前支持版本的数据库会被拒绝启动。

### 3.3 执行架构

内置积木由 Runner 的确定性执行逻辑处理；未配置真实 Provider 的 LLM 使用 simulator。

配置 Provider 的未修改 LLM block 可以由宿主 Runner 调用真实模型。自定义代码和 instance override 不允许获得真实 Provider Key，其 `context.llm` 仍是确定性 simulator，HTTP 和 MCP connector 禁用。

自定义 Python 容器参数包括：

- `--network none`
- 只读 root filesystem
- `--cap-drop ALL`
- `no-new-privileges`
- 非 root 用户
- 临时 `tmpfs`
- 内存、CPU、PID、超时和输出限制
- 随机容器名称和异常清理

## 4. 关键文件

### 根目录

- `README.md`：产品现状、启动方式和安全边界。
- `Makefile`：安装、构建、测试、E2E 和启动命令。
- `CODEX_HANDOFF.md`：新线程的交接基线。
- `examples/blocks/text_stats.py`：Python 积木导入示例。
- `examples/evals/basic-agent-eval.json`：评测集 JSON 示例。
- `github-llm-agent-cv-report-2026-07-14.md`：前期 GitHub 调研报告。

### 前端

- `apps/web/src/main.tsx`：React 和 Query Client 初始化。
- `apps/web/src/App.tsx`：Workbench、画布、保存、运行、导入导出和视图编排。
- `apps/web/src/types.ts`：前端领域类型和 Runner 数据契约。
- `apps/web/src/api/client.ts`：Graph IR 转换、HTTP API 和 SSE client。
- `apps/web/src/store/editor.ts`：编辑器 Zustand 状态。
- `apps/web/src/store/preferences.ts`：字体偏好 Zustand 状态和 localStorage 兼容处理。
- `apps/web/src/store/workspaceSession.ts`：最后保存项目和子视图的版本化恢复指针。
- `apps/web/src/i18n.ts`：English/简体中文资源、浏览器检测和语言持久化。
- `apps/web/src/data/catalog.ts`：积木 catalog、模板和 Harness Lab。
- `apps/web/src/components/AgentNode.tsx`：React Flow 节点。
- `apps/web/src/components/ProjectsModal.tsx`：项目列表弹窗（打开/重命名/删除/从模板新建）。
- `apps/web/src/components/SettingsModal.tsx`：Appearance 和 Provider 设置。
- `apps/web/src/components/RunsView.tsx`：持久 Runs、CSV 导出和行展开的 span 详情。
- `apps/web/src/components/VersionsView.tsx`：revision 列表和结构对比。
- `apps/web/src/components/EvaluationsView.tsx`：Eval Suite、预算、A/B 启动、进度和结果。
- `apps/web/src/utils/revisionDiff.ts`：canonical diff、展示脱敏和 CSV 安全处理。
- `apps/web/src/styles.css`：IDE 风格、响应式布局和字体变量。
- `apps/web/tests/workbench.e2e.mjs`：完整浏览器工作流测试。

### 后端

- `apps/runner/main.py`：当前 Runner 的 API、SQLite、执行、Provider、容器和导入导出实现。
- `apps/runner/assertions.py`：断言执行（含 regex/json_schema）与套件断言预校验。
- `apps/runner/scanner.py`：图/代码/导入的凭据扫描（finding 只含路径和类型）。
- `apps/runner/pricing.py`：价格注册表加载、Token 费用计算和共享费用预算守卫。
- `apps/runner/pricing.json`：经官方页面核对的精确 Provider/model snapshot 价格与来源。
- `apps/runner/tests/test_api.py`：后端 API、安全、revision、run 和 evaluation 测试。
- `apps/runner/tests/test_scanner.py`：凭据扫描单元与 API 集成测试。
- `apps/runner/requirements.txt`：Python 依赖。
- `apps/runner/README.md`：Runner 启动方式和安全说明。

## 5. 已确定的产品和安全决策

### 5.1 产品决策

- 主要用户是 Agent 工程师。
- 核心价值是设计验证、运行观察和版本比较，不是通用无代码 Agent 生成。
- Web 加本地 Runner 优先，Tauri 后置。
- v1 只支持 Python 自定义代码。
- 图主体保持 DAG；ReAct 等循环逻辑封装在受限积木内部，普通图环会被校验拒绝。
- Harness `s01-s20` 作为有序机制演进基线建模。
- 移动端当前不是完整编辑体验。

### 5.2 Provider 和密钥决策

- Provider Key 只能经 Runner Secret API 进入 Keyring 或会话内存。
- API 不返回已保存的 Key 值。
- Key 不得进入浏览器持久状态、项目、revision、Trace、SQLite 工程数据、日志或导出。
- OpenAI-compatible host 默认放行任意合法 base_url（免重启接入 DeepSeek/本地模型/网关）；已存的 openai-compatible Key 会被发送到节点指定 host。设置 `AGENTLAB_OPENAI_COMPATIBLE_ALLOWLIST` 后转为硬 allowlist，仅允许列出的 host。运行来自不可信来源的图前应启用该 allowlist。
- Provider 默认模型是非敏感 Runner 设置，不进入项目导出；节点模型覆盖默认值。
- Evaluation 必须固定 Provider 默认模型 snapshot，不能在配对过程中读取变化后的设置。
- README 中"Key 不会导出"只保证 Runner 管理的 Provider Key。凭据扫描器已覆盖 graph/code/Python 导入：保存只警告，导出默认阻断并要求 `allow_secrets=true` 显式放行；finding 不得包含匹配值本身。

### 5.3 自定义代码决策

- 自定义代码和 override 必须在容器中执行。
- Guardrail、Permission 或 Harness 积木不能关闭 Runner 的容器、密钥、资源和审计边界。
- 自定义代码不能获得 raw Provider Key。
- 无容器运行时时拒绝执行，不在宿主 Python 进程中降级运行。

### 5.4 评测决策

- A/B 使用相同 Eval Suite snapshot、相同 case 输入和两个不可变 revision。
- baseline/candidate 串行成对执行，当前全进程 evaluation 并发为 1，队列最多 8 个活动或等待任务。
- Evaluation 必须固定 suite snapshot/hash 和 budgets。
- Real-provider A/B：价格注册表登记的精确快照做硬性美元预留；未登记模型（OpenAI-compatible/DeepSeek 等）允许运行，跳过美元预留，花费由 token/case/wall-time 预算约束、费用报告为不可用。
- 登记价格的模型每次真实 Provider 调用前必须按保守输入 Token 上界与显式 `max_tokens` 预留最坏费用；预留失败时不得发出该 HTTP 请求。
- Eval Suite 创建和更新拒绝 credential-like 字段或字符串，并提示使用 `secret_ref`。
- `secret_ref` 当前只是安全占位符，不会解析或注入真实凭据。
- Evaluation detail、delete、cancel 和 SSE 必须带 owning `project_id` 并验证归属。

### 5.5 数据和展示安全决策

- Run/evaluation 持久化前必须递归脱敏并限制大小。
- 截断数据必须包含 `truncated`、原始字节数和 preview，不能静默裁剪。
- Assertion 使用进程内短期原始结果，原始结果不能进入 API、SSE 或 SQLite。
- `run_private_results` 的清理不能早于 evaluation assertion 读取。
- Diff 使用原值做 canonical 比较，只在 UI 展示时脱敏。
- CSV 必须同时处理公式注入、对象敏感键、Bearer 和赋值形式的敏感字符串。
- 项目存在活动 run/evaluation 时，删除先请求取消并返回 409；资源终止后才能真正删除。

## 6. 最新的 A/B 评测、版本对比、字体设置实施计划

这一里程碑已经完成实施，后续开发不得把以下内容误写为尚未落地的纯计划。

### 6.1 A/B 评测实施结果

已完成：

- Eval Suite 持久化和 JSON 导入。
- 不可变 suite snapshot/hash。
- 两个 revision 的 baseline/candidate 串行 child runs。
- Case、Token、费用、总时长预算。
- 取消传播、partial 状态和重启 terminal event。
- Evaluation SSE event ID 和 `Last-Event-ID`。
- 两侧 pass rate 和 regression/improvement/not-evaluable 汇总。
- 结果脱敏、大小限制、项目归属和 credential-like fixture 拒绝。
- UI 中可调整预算并显示最大 paired run 数。
- 精确模型快照的真实 Provider A/B、分项 Token 费用记录和调用前最坏费用预留。

本阶段明确限制：

- 真实 Provider A/B 仅支持 `apps/runner/pricing.json` 中登记的精确模型快照；价格表需要持续人工核对官方来源。
- 滚动模型别名、未知模型和 OpenAI-compatible endpoint 的费用仍不可验证，因此会在创建时拒绝。
- `max_cost_usd` 在费用不可获得时不能被假定为 0。
- 当前每个 case 的界面只编辑第一个 assertion；后端数据结构允许 assertion 数组。

### 6.2 版本对比实施结果

已完成：

- 服务端 revision ID、sequence 和 graph hash。
- baseline/candidate 双选。
- Block、config、code override、edge 和 layout-only 差异。
- 嵌套配置 canonical 比较。
- SecretRef 变化识别和展示脱敏。
- 缺失旧 graph arrays/position 时的降级处理。
- 从 Versions 预填 A/B Evaluation。

尚未包含：revision restore、merge、图形叠加视图和逐行代码 diff。

### 6.3 字体实施结果

已完成：

- Settings Appearance 页。
- 四档设备字体偏好。
- 版本化 localStorage 和损坏回退。
- storage 写失败时内存回退。
- 非画布 UI 语义字体变量。
- Canvas、React Flow 和 Monaco 固定独立字号。
- E2E 验证普通 UI 字号变化且节点字号不变。

尚未包含：主题系统、Monaco 独立字号设置和跨设备偏好同步。

### 6.4 2026-07-22 里程碑实施结果（Projects / 扫描 / 断言 / 观察性）

已完成并通过后端 31 测试、前端 17 测试、TypeScript 检查、生产构建和全部 13 项 E2E 场景验证：

- 真正的 Projects 列表弹窗：打开、重命名、删除（活动任务 409 提示）、从模板新建；删除当前项目自动脱离工作区身份。
- 凭据扫描（`scanner.py`）：保存警告、导出 422 阻断 + `allow_secrets=true` 放行、Python 导入警告。
- 断言增强（`assertions.py`）：`regex` 和 `json_schema` 类型、套件保存前预校验、每 case 多 assertion 编辑器。
- Evaluation 删除 UI（终态实验，确认后删除）。
- Run SSE 事件 `id:` 和 `Last-Event-ID` 续传。
- Runs 行展开 span 详情（节点状态/耗时/Token/费用 + 脱敏 IO）。
- 底部 Metrics 用 `run_completed` 事件的真实 metrics（Token/耗时/费用），移除了硬编码 `$0.012` 演示值。

本阶段明确限制：

- 扫描模式刻意保守（高置信度值形态 + 敏感键名），不承诺捕获所有凭据形态。
- `json_schema` 失败信息只含 JSON 路径；regex pattern 上限 512 字符，无超时机制（依赖长度与输入截断缓解）。
- Runs 列表仍无筛选和分页；span 详情来自单次查询，无自动刷新。

### 6.5 openai-compatible 默认开放（产品决策变更）

原设计 openai-compatible 必须由 env allowlist 显式信任、localhost 也不例外。经产品负责人决策改为**默认开放**以方便接入各类 LLM：

- `_validated_compatible_base_url` 默认放行任意合法 http(s) base_url；仅当 `AGENTLAB_OPENAI_COMPATIBLE_ALLOWLIST` 非空时作为硬锁生效。malformed URL 始终拒绝。
- 残留风险：已存的 openai-compatible Key 会随节点 base_url 发送到任意 host；分享/运行不可信来源的图前应设置 env allowlist 收紧。
- A/B 评测的价格 fail-closed 边界未变：openai-compatible 无价格快照，评测仍拒绝（约束 #12 不受影响）。
- 顺带修复：Runs 详情面板对失败 run 显示完整错误横幅；Design 底部 Trace 错误行显示完整 error 而非仅 "node error"。
- 代理健壮性：启动时 `_sanitize_proxy_env()` 规整/丢弃 httpx 无法解析的代理环境变量（裸 `socks://` → `socks5://`，无法支持的 scheme 丢弃并保留可用的 http(s) 代理），避免单个坏代理变量（常见于 Clash/mihomo 的 `ALL_PROXY=socks://...`）导致所有 provider 调用崩溃。需要 socks 代理时可 `pip install 'httpx[socks]'`。
- A/B 未定价放开：`create_evaluation` 不再拒绝未登记模型；`_call_llm` 对无价格模型跳过美元预留而非报错。未登记模型（DeepSeek/openai-compatible）可跑 A/B，花费由 max_tokens/max_cases/max_wall_seconds 兜底、`total_cost_usd` 为 null；创建响应带非阻断 `cost_unenforced_models`。登记价格后自动恢复硬美元上限。

### 6.6 UI 打磨轮（Projects/版本切换 · 版本删除 · 自定义字号 · 布局加固）

后端 35 测试通过；前端改动待重启后 `make check` + `make e2e` 复验（分类器不可用时由用户执行）。

- **顶部工作区切换器**（`apps/web/src/components/WorkspaceSwitcher.tsx`）：原顶栏项目信息区的下拉箭头此前是死的，现改为可点下拉，列出已保存项目（切换 Agent，复用 `openProject`）和当前项目历史版本（`openRevision` 加载 revision 到画布，保存后即成为新版本 = 轻量 restore）；含"管理项目"入口打开 ProjectsModal。
- **版本删除**：`DELETE /api/projects/{pid}/revisions/{rid}`——被 A/B 评测引用或仅剩一个版本时 409；否则**连带删除该版本的 Runs**（run_events/run_spans 经 FK 级联），再删版本。策略从最初的「任何 run/评测引用都拒绝」调整为「连带删 Runs、保护评测」，因为正常使用中每次运行都会钉住版本导致几乎无法删除。VersionsView 每行加删除按钮，当前版本禁用，409 显示评测保护提示。
- **顶栏切换器修正**：`.topbar` 不再用 `overflow: hidden`（会裁掉下方绝对定位的下拉菜单）；`.project-switcher-wrap` 由占满宽度改为 `max-width: 320px` 内容自适应，避免长条留白。

### 6.7 控制积木接入真实 LLM（Planner / Router / Supervisor / ReAct）

后端 37 测试通过；前端改动待重启后 `make check` + `make e2e` 复验。

- `_call_llm` 拆出可复用的 `_resolve_llm_target`（provider 为空→None 回退）与 `_provider_chat`（单次 Provider 调用 + 价格预留/结算 + metrics）。`_call_llm` 现为薄封装，llm 行为不变。
- 新增 `_run_planner/_run_router/_run_supervisor/_run_react`：节点配了 provider 时调用真实模型（Planner 出计划步骤、Router 分类到 routes 之一、Supervisor 协调答复、ReAct 有界推理循环最多 max_steps 次），空 provider 时回退到原确定性结构。它们在宿主 Runner 内运行，复用 LLM 积木同一调用路径，**不改任何密钥/沙箱边界**。
- `_run_worker` 指标累加通用化：任何返回 metrics 的积木（llm + 四控制积木）都汇入 run Token/费用；`_revision_unpriced_models` 扩展为识别配 provider 的控制积木。
- 前端 catalog/editor：控制积木默认 config 增 `provider/model/base_url/temperature`（ConfigPanel 通用渲染）。
- **仍为占位/待办**：Memory（需存储后端）、Tool/HTTP/MCP（v1 禁网络）、Harness hooks（机制标记）、以及条件分支执行——Router 输出真实路由值但 DAG 仍执行所有下游节点，真正的分支路由是独立的执行器里程碑。

### 6.8 条件分支执行器（Router 真正分支）

后端 39 测试通过；前端 18 Vitest + tsc + 生产构建全绿（上一轮 6.7 前端亦已复验）。

- `_run_worker` 加可达性门控：每条数据边按下标记为激活/未激活；Router 执行后只激活 `source_port`（路由标签）为空或等于所选 route 的出边，仅通过未激活边到达的节点被跳过（`emit("node_skipped")` + run_span status=`skipped`）。value 只取激活父节点。**完全向后兼容**——无 source_port 标签的边=无条件，整图照旧执行。
- `validate_graph`：对 source 为 router 的边跳过固定 ports_out 校验，改为软告警（route 不在 config.routes 时）。
- 前端：连线的 route 存于 `edge.data.route`（`toRunnerGraph`↔`source_port`，连线显示 label）；新增 `EdgeInspector`——选中一条从 Router 出发的连线时在右栏选择它属于哪个 route（或"无条件"）；`store.setEdgeRoute`。
- **仍待办**：循环执行（需真实 Tool）、并行 join 语义/子图、真实 HTTP 工具、Memory 检索。
- **自定义字号**：`preferences` store 由 4 档枚举改为数值百分比（80–140，兼容旧枚举字符串），SettingsModal 保留 4 预设并新增滑块 + 数字输入；`--ui-font-scale` 现由 App 内联样式驱动（原 `[data-ui-font]` 离散规则移除）。画布/Monaco 仍固定字号不变。
- **布局加固**：顶栏改为 overflow 隐藏 + 切换器可收缩省略号、top-actions 不收缩，view-heading 长中文可换行不遮挡，修正相关断点；缓解不同窗口尺寸/中英文切换下的分区遮挡（首轮针对最易冲突处，后续按反馈继续）。

## 7. 尚未完成的工作

### 7.1 高优先级

- 持续维护和扩展 Provider/model/version 价格表，处理新模型、退役和特殊计费模式。
- Unix-socket Provider Gateway，使 sandbox code override 能安全调用真实 LLM，而不暴露 Key。
- `secret_ref` 的受控运行时解析和短期凭据注入。
- 真实 HTTP/MCP 工具、域名 allowlist、权限声明和审批流程。
- 更完整的 Memory 运行语义、真实工具循环，以及循环/并行 join 执行器；Planner/Router/Supervisor/ReAct 已在配置 provider 时调用真实 LLM（6.7），Router 已支持条件分支（6.8，按 route 只执行选中路径），但 Memory 仍是确定性、真实工具循环仍待真实 Tool。

### 7.2 评测能力

- 自定义容器 evaluator。
- LLM-as-judge 和 prompt injection 防护。
- 重复采样、随机种子、统计显著性和置信区间。
- Evaluation 结果导出。
- failed、partial、cancel、预算终止和 SSE 重连的更完整浏览器 E2E。

### 7.3 版本和运行观察

- Revision restore as new revision。
- 图形化 revision overlay、merge 和逐行代码 diff。
- Runs 筛选和分页（行内 span 详情已完成，独立详情页未做）。
- 两个 Run 的 Trace 对比。
- 分页式 event JSON 查询接口。

### 7.4 平台和工程化

- 前端 URL Router、可分享深链和多项目导航；刷新后的最后项目/视图恢复和 Projects 列表弹窗已经完成。
- 清理 App.tsx 中残留的未使用 store 选择器和图标导入。
- 与平台完整语义等价的 code export runtime；当前 LLM/provider adapter 仍是占位行为。
- 独立 migration 文件、降级策略和更完整旧数据库测试；main.py 主体仍是单文件（assertions/scanner/pricing 已拆出）。
- 多进程或远程 Runner；当前 lock、semaphore 和队列只适用于本地单进程。
- Tauri 桌面端。
- 团队协作、认证、RBAC、多租户、Git 同步和插件注册表。
- 完整移动编辑体验和更多编程语言。

## 8. 当前测试结果和启动命令

### 8.1 最新验证结果

在 2026-07-22 重新执行：

```text
后端 pytest：31 passed（含 assertions、scanner、SSE 续传新测试）
前端 Vitest：17 passed
TypeScript 检查（tsc --noEmit）：passed
Vite production build：passed

E2E（workbench.e2e.mjs，BASE_URL=http://127.0.0.1:8000，临时 RUNNER_DB_PATH）：
  appearance：passed
  edgeDeletion：passed
  providers：passed
  workspaceRestore：passed
  starterRun：passed
  projectsList：passed（新增：保存后打开 Projects 弹窗并打开项目）
  evaluations：passed
  evaluationDelete：passed（新增：删除终态实验）
  runDetail：passed（新增：Runs 行展开 span 详情）
  versions / Compare：passed
  language：passed
  Harness Lab：passed，20 nodes
  Python import：passed
```

后端依赖新增 `jsonschema>=4.21`（见 `apps/runner/requirements.txt`）。

### 8.2 安装和生产启动

```bash
make install
make run
```

访问：

```text
http://127.0.0.1:8000
```

`make run` 会先构建 Web，然后由 Runner 提供生产静态资源。

默认数据库：

```text
~/.agentlab/runner.db
```

可使用环境变量覆盖路径：

```bash
RUNNER_DB_PATH=/path/to/runner.db make run
```

不要在测试或并行开发中复用真实用户数据库。

### 8.3 分离开发启动

终端 1：

```bash
make runner-dev
```

终端 2：

```bash
make web-dev
```

开发地址：

```text
Web:    http://127.0.0.1:5173
Runner: http://127.0.0.1:8000
```

Vite 将 `/api` 代理到 Runner。

### 8.4 验证命令

```bash
make check
make e2e
```

E2E 要求 Runner 已在目标地址启动。可使用 `BASE_URL` 覆盖默认地址。

## 9. 新线程继续开发时必须遵守的约束

1. 不得把 API Key、Bearer Token、密码、Authorization 值或其他真实凭据写入代码、文档、测试 fixture、示例或日志。
2. 不得读取并输出用户 Keyring、session secret、真实数据库凭据或环境变量中的密钥值。
3. Provider Key 只能由 Runner Secret API 管理，禁止进入前端 store、project graph、revision、Trace、SQLite 工程数据和导出。
4. 不得把 Runner 直接暴露到 LAN 或公网。当前系统没有认证、RBAC 或多租户隔离，只应绑定 loopback。
5. OpenAI-compatible endpoint 默认接受任意合法 base_url（免重启接入各类 LLM）；已存的 openai-compatible Key 会被发送到节点指定的 host。需要收紧时用 `AGENTLAB_OPENAI_COMPATIBLE_ALLOWLIST` 设为硬 allowlist，设置后仅允许列出的 host；运行来自不可信来源的图前应启用它。malformed base_url 始终拒绝。
6. 自定义和 override Python 必须继续使用受限 Docker/Podman；无容器运行时时必须拒绝。
7. 不得向自定义代码传递 raw Provider Key；真实 Provider Gateway 完成前，custom `context.llm` 保持 simulator，HTTP/MCP 保持禁用。
8. Guardrail、Permission 和 Harness 积木不能关闭 Runner 的硬安全边界。
9. Run/evaluation 持久化、SSE、CSV 和 UI 展示必须继续脱敏并限制大小。
10. Assertion 必须使用短期原始结果，不能为了展示脱敏而改写执行输入或比较语义。
11. Eval Suite 必须拒绝 credential-like fixture；`secret_ref` 目前不能解析真实凭据。
12. Real-provider A/B 中，价格注册表登记的精确模型快照享受硬性美元预算预留；未登记模型（含 OpenAI-compatible/DeepSeek）允许运行但不做美元预留，花费由 max_tokens/max_cases/max_wall_seconds 预算约束、费用显示为不可用。登记价格后自动恢复硬美元上限。混合图中登记模型仍逐调用预留。
13. Evaluation API 必须校验 owning `project_id`，两个 revision 必须属于同一项目。
14. A/B 必须保持相同 snapshot 和相同输入的 baseline/candidate 配对，取消和预算检查不能回退。
15. 项目有活动任务时不得直接级联删除；必须先取消并等待资源终止。
16. Revision ID 不可变，版本比较以服务端 ID、sequence 和 hash 为准。
17. Diff 必须用原值判断变化，只在展示时脱敏；旧 graph 数据必须降级处理而不是崩溃。
18. 字体偏好只影响非画布 UI，不得改变 Canvas 节点、React Flow 或 Monaco 的独立字号，也不得进入项目数据。
19. 语言偏好和 workspace session 只保存在设备 localStorage；不得把未保存 graph、code override 或 Provider Key 写入浏览器持久化。
20. Provider 默认模型是 Runner 级非敏感设置；节点模型优先，Evaluation 必须使用创建时固定的 `provider_snapshot`。
21. 修改 SQLite schema 时必须保持现有数据库升级兼容；高于支持版本的数据库必须拒绝而不是覆盖。
22. 修改代码后至少执行 `make check`；修改 API、布局、评测、版本、字体或浏览器流程后还必须启动最新 Runner 并执行 `make e2e`。
23. 后端或生产前端变更后必须重启 Runner，避免 E2E 命中旧进程或旧路由。
24. 不得把尚未完成的路线图功能描述为已实现。
25. 当前工作区不是 Git 仓库；不要执行依赖 Git 历史的破坏性操作，也不要假设可以通过 commit 恢复文件。
26. 凭据扫描 finding 只能包含路径和模式类型，不得回传、记录或持久化匹配到的值；扫描模式宁可保守也不要制造误报噪音。
27. 导出接口默认因凭据 finding 阻断；`allow_secrets=true` 只能由用户在前端确认后携带，不得在任何自动流程中静默附加。
28. 断言失败信息不得嵌入运行输出或 fixture 值（json_schema 只报 JSON 路径）；套件保存前必须预校验断言合法性。

## 交接结论

当前里程碑已经形成可运行的 Agent 设计、保存、刷新恢复、执行、观察、版本比较、simulator A/B、受费用预留约束的精确模型快照真实 Provider A/B、Runner 级默认模型，以及中英文工作台闭环。2026-07-22 里程碑补齐了 Projects 列表弹窗、凭据扫描（保存警告/导出阻断）、regex 与 json_schema 断言、多 assertion 编辑器、评测删除 UI、Run SSE 断点续传、Runs span 详情下钻和真实 Metrics 展示。下一线程应优先 Provider Gateway（建议先出设计再实施）、价格表持续维护、`secret_ref` 受控解析和真实 HTTP/MCP 工具，同时保持本文件列出的容器、密钥、数据脱敏、凭据扫描、项目归属、workspace session 和设备偏好边界。
