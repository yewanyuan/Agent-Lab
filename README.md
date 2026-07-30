# Agent Lab

Agent Lab is a local-first Web workbench for composing, validating, running, and exporting Agent designs. It combines a typed node canvas with instance-level Python overrides and a FastAPI runner that keeps provider credentials outside project files and custom code containers.

## Included

- Six runnable design templates plus a 20-block Harness Evolution Lab based on `learn-claude-code` s01-s20.
- Drag/drop canvas, selectable/deletable typed connections, copy/cut/paste/delete, undo/redo, code overrides, config and port inspection.
- A Projects modal for opening, renaming, and deleting saved projects; deletion is refused while runs or evaluations are still active.
- Project revisions, graph validation, node-level SSE traces with resumable `Last-Event-ID` streams, cancellation, real token/duration/cost metrics, per-run node span drill-down, project archives, and Python code export.
- Persistent evaluation suites with per-case multi-assertion editing (`exact`, `contains`, `regex`, `json_schema`, `max_steps`, `tool_called`, `max_cost_usd`), serial paired A/B runs, regression/improvement summaries, experiment deletion, and structural revision comparison.
- Refresh restores the last saved project and active Runs, Evaluations, Versions, or Design view from the local Runner.
- Device-level 90/100/110/120% interface text and English/Chinese language preferences. Canvas nodes, React Flow controls, and Monaco keep independent fixed sizing.
- AST-based Python block import. Imported code runs only through Docker/Podman with network disabled, a read-only root filesystem, and resource limits.
- Anthropic, OpenAI, and OpenAI-compatible provider adapters. Each provider can define a free-text default model that nodes may override. API keys are held by the local runner through the system keyring or session memory and are never exported.

## Quick Start

```bash
make install
make build
make run
```

Open <http://127.0.0.1:8000>. The production Web bundle is served by FastAPI.

For separate development servers:

```bash
# terminal 1
make runner-dev

# terminal 2
make web-dev
```

The Vite UI is then available at <http://127.0.0.1:5173> and proxies `/api` to port `8000`.

## Verification

```bash
make check
```

The command runs backend tests, frontend tests, TypeScript checks, and the production build.

## Security Boundary

The removable Permission and Guardrail blocks are experimental Agent mechanisms. They cannot disable the runner's container, secret, resource, and audit boundary. Custom Python receives graph data, not raw LLM API keys. Network access for imported code is disabled in v1.

OpenAI-compatible endpoints accept any valid `base_url` by default, so users can connect DeepSeek, local models, or other providers without restarting the runner. Because the stored openai-compatible key is sent to whatever host a graph's LLM node names, operators who run graphs from untrusted sources can re-enable a hard allowlist with `AGENTLAB_OPENAI_COMPATIBLE_ALLOWLIST=host1,host2`; when it is set, only those hosts are permitted. Malformed URLs are always rejected.

If Docker or Podman is unavailable, built-in blocks still run through the deterministic simulator, while imported Python execution is refused.

In this MVP, unmodified LLM and LLM-backed control blocks (Planner, Router, Supervisor, ReAct) can call configured providers through the host runner; with no provider set on the node they produce deterministic output. Imported Python and instance code overrides remain offline inside the container: their `context.llm` is deterministic and HTTP/MCP connectors are disabled. A future Unix-socket provider gateway can extend real model access without exposing raw keys to custom code.

Evaluation experiments persist immutable suite snapshots, run spans, metrics, and SSE events. Models listed in the versioned price registry get a hard worst-case USD reservation before each request from the shared evaluation budget. Unpriced models (OpenAI-compatible endpoints and unknown snapshots) are allowed to run without that reservation—spend stays bounded by the token, case, and wall-time budgets and cost is reported as unavailable—and adding a price restores the hard USD cap. Deterministic simulator evaluations remain fully available.

Evaluation suites reject credential-like fixture fields such as `api_key`, `password`, and `Authorization`; use a `secret_ref` placeholder instead. Run and evaluation result views remain redacted without changing the original non-secret values used by assertions.

A credential scanner checks project graphs, code overrides, and imported Python for credential-like keys and high-confidence token shapes. Saving reports findings as non-blocking warnings; project and code exports are refused with HTTP 422 until `allow_secrets=true` is explicitly passed. Findings identify only the path and pattern kind — matched values are never echoed back.

Run and evaluation payloads are size-limited and secret-like fields are redacted before persistence. Project deletion requests cancellation first and refuses to remove a project while its runs or evaluations are still active.

## Layout

- `apps/web`: React, React Flow, Monaco, Zustand, and the IDE-style workbench.
- `apps/runner`: FastAPI API, SQLite revisions, execution runtime, providers, imports, exports, and SSE traces.
- `examples`: sample Python block and evaluation data.

The desktop application remains a later Tauri shell over the same Web UI and runner API.
