import type { BlockManifest, Template, AgentNode, AgentEdge, BlockCategory } from '../types';

const code = (body: string) => `async def execute(context, inputs, config):\n${body.split('\n').map((line) => `    ${line}`).join('\n')}`;
const port = (id: string, label: string, type: string, required = false) => ({ id, label, type, required });

export const catalog: BlockManifest[] = [
  { id: 'input.user', version: '1.0.0', name: 'User Input', category: 'input', description: 'Accept a prompt or structured request.', icon: 'message', color: '#4f7cff', inputPorts: [], outputPorts: [port('request', 'request', 'string', true)], code: code("return {'request': inputs.get('request', '')}"), docs: 'Entry point for a run. Pass text or JSON from the input panel.' },
  { id: 'model.chat', version: '1.2.0', name: 'Chat Model', category: 'model', description: 'Call a provider through the secure model gateway.', icon: 'sparkles', color: '#a66cff', inputPorts: [port('prompt', 'prompt', 'string', true), port('tools', 'tools', 'tool[]')], outputPorts: [port('response', 'response', 'string', true)], code: code("response = await context.llm.chat(inputs['prompt'], tools=inputs.get('tools', []))\nreturn {'response': response}"), docs: 'Provider-agnostic model call. Secrets stay outside the sandbox.', capabilities: ['streaming', 'tool-calling', 'structured-output'] },
  { id: 'control.react', version: '1.0.0', name: 'ReAct Loop', category: 'control', description: 'Alternate reasoning and tool use until a final answer.', icon: 'repeat', color: '#e7a74e', inputPorts: [port('request', 'request', 'string', true), port('tools', 'tools', 'tool[]')], outputPorts: [port('answer', 'answer', 'string', true)], code: code("for step in range(config.get('max_steps', 8)):\n    decision = await context.llm.chat(inputs['request'], tools=inputs.get('tools', []))\n    if decision.is_final:\n        return {'answer': decision.text}\nreturn {'answer': 'Max steps reached'}"), docs: 'Bounded loop with explicit max steps, timeout and tool budget.' },
  { id: 'control.plan', version: '1.0.0', name: 'Plan & Execute', category: 'control', description: 'Create a plan, execute steps, then synthesize.', icon: 'list-checks', color: '#e7a74e', inputPorts: [port('request', 'request', 'string', true), port('tools', 'tools', 'tool[]')], outputPorts: [port('answer', 'answer', 'string', true)], code: code("plan = await context.llm.chat(f'Plan this request: {inputs[\"request\"]}')\nresults = await context.execute_plan(plan, inputs.get('tools', []))\nreturn {'answer': await context.llm.chat(f'Synthesize: {results}')}"), docs: 'Separate planning from execution for inspectable multi-step tasks.' },
  { id: 'control.router', version: '1.0.0', name: 'Router', category: 'control', description: 'Route each request to a specialist path.', icon: 'route', color: '#e7a74e', inputPorts: [port('request', 'request', 'string', true)], outputPorts: [port('route', 'route', 'string'), port('request', 'request', 'string')], code: code("route = await context.llm.classify(inputs['request'], config['routes'])\nreturn {'route': route, 'request': inputs['request']}"), docs: 'Use named routes and fallback handling for specialist agents.' },
  { id: 'agent.supervisor', version: '1.0.0', name: 'Supervisor', category: 'control', description: 'Coordinate specialist agents with a shared task state.', icon: 'network', color: '#e7a74e', inputPorts: [port('request', 'request', 'string', true), port('agents', 'agents', 'agent[]')], outputPorts: [port('answer', 'answer', 'string', true)], code: code("return {'answer': await context.supervise(inputs['request'], inputs.get('agents', []))}"), docs: 'Delegates work and merges specialist outputs with a supervisor policy.' },
  { id: 'memory.store', version: '1.0.0', name: 'Memory Store', category: 'memory', description: 'Persist and retrieve relevant run context.', icon: 'database', color: '#39b78b', inputPorts: [port('query', 'query', 'string')], outputPorts: [port('context', 'context', 'string')], code: code("context = await context.memory.search(inputs.get('query', ''), limit=config.get('limit', 5))\nreturn {'context': context}"), docs: 'Memory is explicit state. Choose a backend and retention policy.' },
  { id: 'tool.http', version: '1.0.0', name: 'HTTP Request', category: 'tool', description: 'Call an allow-listed HTTP endpoint.', icon: 'globe', color: '#3aa4cc', inputPorts: [port('request', 'request', 'json', true)], outputPorts: [port('response', 'response', 'json', true)], code: code("response = await context.http.request(config['url'], inputs['request'])\nreturn {'response': response}"), docs: 'Network access is disabled unless a domain is explicitly approved.', permissions: ['network:allowlist'] },
  { id: 'tool.mcp', version: '1.0.0', name: 'MCP Server', category: 'tool', description: 'Expose tools from a Model Context Protocol server.', icon: 'plug', color: '#3aa4cc', inputPorts: [port('request', 'request', 'json')], outputPorts: [port('result', 'result', 'json')], code: code("result = await context.mcp.call(config['server'], config['tool'], inputs.get('request', {}))\nreturn {'result': result}"), docs: 'MCP tools run with declared permissions and are included in the trace.', permissions: ['mcp:invoke'] },
  { id: 'guardrail.approval', version: '1.0.0', name: 'Human Approval', category: 'guardrail', description: 'Pause before an irreversible action.', icon: 'shield-check', color: '#d67b91', inputPorts: [port('proposal', 'proposal', 'json', true)], outputPorts: [port('decision', 'decision', 'boolean', true)], code: code("decision = await context.approval.request(inputs['proposal'])\nreturn {'decision': decision}"), docs: 'Require a human decision before a tool or state mutation.' },
  { id: 'guardrail.policy', version: '1.0.0', name: 'Policy Gate', category: 'guardrail', description: 'Check input or output against a policy.', icon: 'scan', color: '#d67b91', inputPorts: [port('value', 'value', 'any', true)], outputPorts: [port('value', 'value', 'any', true)], code: code("context.policy.check(inputs['value'], config.get('policy', 'default'))\nreturn {'value': inputs['value']}"), docs: 'Fail closed when a policy is unavailable or ambiguous.' },
  { id: 'harness.trace', version: '1.0.0', name: 'Trace Hook', category: 'harness', description: 'Capture lifecycle spans and state diffs.', icon: 'activity', color: '#8c98a8', inputPorts: [], outputPorts: [], code: code("context.trace.emit('checkpoint', {'state': context.state.snapshot()})\nreturn {}"), docs: 'Attach to a lifecycle slot to make execution inspectable.' },
  { id: 'harness.compact', version: '1.0.0', name: 'Context Compact', category: 'harness', description: 'Summarize context when the budget is reached.', icon: 'minimize-2', color: '#8c98a8', inputPorts: [], outputPorts: [], code: code("if context.tokens > config.get('budget', 10000):\n    await context.state.compact()\nreturn {}"), docs: 'Keep long-running agents within a predictable context budget.' },
  { id: 'eval.assert', version: '1.0.0', name: 'Evaluator', category: 'eval', description: 'Score output with assertions or a judge.', icon: 'badge-check', color: '#d09a45', inputPorts: [port('output', 'output', 'any', true)], outputPorts: [port('score', 'score', 'number', true)], code: code("score = await context.evaluate(inputs['output'], config)\nreturn {'score': score}"), docs: 'Use this block for exact, schema, trajectory or LLM-as-judge checks.' },
  { id: 'output.answer', version: '1.0.0', name: 'Final Answer', category: 'output', description: 'Return a user-facing answer.', icon: 'arrow-up-right', color: '#4f7cff', inputPorts: [port('answer', 'answer', 'string', true)], outputPorts: [], code: code("return {'output': inputs['answer']}"), docs: 'Terminal output shown in the run panel.' },
];

const harnessLessons = [
  ['s01', 'Agent Loop', 'Core model/tool execution loop', 'BeforeRun'],
  ['s02', 'Tool Registry', 'Typed tool schemas and handler dispatch', 'BeforeTool'],
  ['s03', 'Permission Gate', 'Deny, allow and approval policies', 'BeforeTool'],
  ['s04', 'Lifecycle Hooks', 'Stable extension points around execution', 'BeforeRun'],
  ['s05', 'Todo Planning', 'Persistent bounded task planning', 'AfterModel'],
  ['s06', 'Subagent', 'Fresh-context delegated execution', 'AfterModel'],
  ['s07', 'Skill Loading', 'Load domain knowledge on demand', 'BeforeModel'],
  ['s08', 'Context Compact', 'Reduce context before budget overflow', 'BeforeModel'],
  ['s09', 'Memory', 'Select, extract and consolidate memory', 'AfterRun'],
  ['s10', 'Prompt Assembly', 'Build runtime prompts from sections', 'BeforeModel'],
  ['s11', 'Error Recovery', 'Retry, compact or select another path', 'OnError'],
  ['s12', 'Task Graph', 'Persist tasks and dependencies', 'BeforeRun'],
  ['s13', 'Background Tasks', 'Run slow operations asynchronously', 'AfterTool'],
  ['s14', 'Cron Trigger', 'Start runs from a bounded schedule', 'BeforeRun'],
  ['s15', 'Agent Teams', 'Create persistent specialist teammates', 'BeforeRun'],
  ['s16', 'Team Protocols', 'Structured request and response messages', 'AfterModel'],
  ['s17', 'Autonomous Claim', 'Let workers claim eligible tasks', 'AfterTool'],
  ['s18', 'Workspace Isolation', 'Bind tasks to isolated workspaces', 'BeforeTool'],
  ['s19', 'MCP Connector', 'Add external tools through MCP', 'BeforeRun'],
  ['s20', 'Comprehensive Harness', 'Composite reference of all mechanisms', 'BeforeRun'],
] as const;

catalog.push(...harnessLessons.map(([lesson, name, description, lifecycle]) => ({
  id: `harness.${lesson}`,
  version: '1.0.0',
  name: `${lesson.toUpperCase()} ${name}`,
  category: 'harness' as const,
  description,
  icon: lesson === 's20' ? 'network' : 'activity',
  color: lesson === 's20' ? '#596675' : '#8c98a8',
  inputPorts: lesson === 's01' ? [port('request', 'request', 'any')] : [port('value', 'value', 'any')],
  outputPorts: lesson === 's20' ? [port('output', 'output', 'any')] : [port('value', 'value', 'any')],
  code: code(`context.trace.emit('${lesson}', {'lifecycle': '${lifecycle}'})\nreturn {'value': inputs.get('value', inputs.get('request'))}`),
  docs: `${description}. Compatible lifecycle: ${lifecycle}. Platform sandbox and secret protection remain outside removable blocks.`,
  capabilities: [lesson, lifecycle, 'traceable'],
})));

const llmBackedManifests = new Set(['model.chat', 'control.react', 'control.plan', 'control.router', 'agent.supervisor']);
const node = (manifestId: string, id: string, x: number, y: number, config: Record<string, unknown> = {}): AgentNode => {
  const b = catalog.find((item) => item.id === manifestId)!;
  const defaults = llmBackedManifests.has(manifestId) ? { provider: '', model: '', base_url: '', temperature: 0 } : {};
  return { id, type: 'agent', position: { x, y }, data: { label: b.name, manifestId: b.id, category: b.category, description: b.description, color: b.color, icon: b.icon, code: b.code, originalCode: b.code, isOverride: false, config: { ...defaults, ...config } }, };
};

const edge = (source: string, target: string, sourceHandle?: string, targetHandle?: string): AgentEdge => ({ id: `${source}-${target}`, source, target, sourceHandle, targetHandle, type: 'smoothstep', animated: false, interactionWidth: 20 });

export const templates: Template[] = [
  { id: 'tool-use', name: 'Tool Use Starter', mode: 'Tool Use / Augmented LLM', description: 'A minimal model + tool path for calling APIs safely.', accent: '#3aa4cc', difficulty: 'Starter', tags: ['LLM', 'Tools'], nodes: [node('input.user', 'input', 80, 170), node('model.chat', 'model', 350, 170), node('tool.http', 'tool', 650, 170, { url: 'https://api.example.com', approval: true }), node('output.answer', 'output', 920, 170)], edges: [edge('input', 'model', 'request', 'prompt'), edge('model', 'tool'), edge('tool', 'output')] },
  { id: 'react', name: 'ReAct Loop', mode: 'ReAct', description: 'Reason, act, observe and stop inside a bounded control block.', accent: '#e7a74e', difficulty: 'Starter', tags: ['Control', 'Loop'], nodes: [node('input.user', 'input', 80, 180), node('control.react', 'react', 400, 180, { max_steps: 8 }), node('tool.http', 'tool', 700, 180), node('output.answer', 'output', 960, 180)], edges: [edge('input', 'react', 'request', 'request'), edge('react', 'tool'), edge('tool', 'output')] },
  { id: 'plan-execute', name: 'Plan & Execute', mode: 'Plan-and-Execute', description: 'Separate planning, execution, and synthesis.', accent: '#e7a74e', difficulty: 'Intermediate', tags: ['Planning', 'Tools'], nodes: [node('input.user', 'input', 70, 180), node('control.plan', 'plan', 350, 180, { max_steps: 12 }), node('tool.mcp', 'tool', 680, 180), node('output.answer', 'output', 980, 180)], edges: [edge('input', 'plan', 'request', 'request'), edge('plan', 'tool'), edge('tool', 'output')] },
  { id: 'router', name: 'Router', mode: 'Router', description: 'Route requests to specialist paths with a safe fallback.', accent: '#9b7cf1', difficulty: 'Intermediate', tags: ['Multi-path', 'Routing'], nodes: [node('input.user', 'input', 70, 180), node('control.router', 'router', 370, 180, { routes: ['research', 'support', 'fallback'] }), node('model.chat', 'specialist', 680, 110), node('output.answer', 'output', 980, 180)], edges: [edge('input', 'router', 'request', 'request'), edge('router', 'specialist', 'request', 'prompt'), edge('specialist', 'output', 'response', 'answer')] },
  { id: 'supervisor', name: 'Supervisor Team', mode: 'Supervisor / Multi-agent', description: 'A supervisor dispatches work to parallel specialist workers.', accent: '#cb7f9f', difficulty: 'Advanced', tags: ['Agents', 'Parallel'], nodes: [node('input.user', 'input', 70, 180), node('agent.supervisor', 'supervisor', 350, 180, { workers: 2 }), node('model.chat', 'worker-a', 650, 90), node('model.chat', 'worker-b', 650, 280), node('output.answer', 'output', 970, 180)], edges: [edge('input', 'supervisor', 'request', 'request'), edge('supervisor', 'worker-a'), edge('supervisor', 'worker-b'), edge('worker-a', 'output'), edge('worker-b', 'output')] },
  { id: 'memory', name: 'Memory Agent', mode: 'Memory-augmented', description: 'Retrieve context, answer, and persist a useful memory.', accent: '#39b78b', difficulty: 'Intermediate', tags: ['Memory', 'RAG'], nodes: [node('input.user', 'input', 70, 180), node('memory.store', 'memory', 340, 300, { limit: 5 }), node('model.chat', 'model', 620, 180), node('output.answer', 'output', 960, 180)], edges: [edge('input', 'memory', 'request', 'query'), edge('memory', 'model', 'context', 'prompt'), edge('input', 'model', 'request', 'prompt'), edge('model', 'output', 'response', 'answer')] },
  { id: 'harness-lab', name: 'Harness Evolution Lab', mode: 's01-s20 Harness mechanisms', description: 'Twenty progressively layered harness capabilities with explicit dependency order.', accent: '#8c98a8', difficulty: 'Advanced', tags: ['Harness', 's01-s20'], nodes: harnessLessons.map(([lesson], index) => node(`harness.${lesson}`, lesson, 70 + (index % 5) * 245, 70 + Math.floor(index / 5) * 145, { order: index + 1 })), edges: harnessLessons.slice(0, -1).map(([lesson], index) => edge(lesson, harnessLessons[index + 1][0])) },
];

export const categoryMeta: Record<BlockCategory, { label: string; color: string }> = {
  input: { label: 'Input / Output', color: '#4f7cff' }, model: { label: 'LLM & Prompt', color: '#a66cff' }, control: { label: 'Control Flow', color: '#e7a74e' }, tool: { label: 'Tools & MCP', color: '#3aa4cc' }, memory: { label: 'State & Memory', color: '#39b78b' }, guardrail: { label: 'Guardrails', color: '#d67b91' }, eval: { label: 'Evaluation', color: '#d09a45' }, output: { label: 'Input / Output', color: '#4f7cff' }, harness: { label: 'Harness Hooks', color: '#8c98a8' },
};
