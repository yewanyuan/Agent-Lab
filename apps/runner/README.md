# AgentLab Runner

Local FastAPI runner for the Agent design validation platform.

```bash
cd apps/runner
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The API is JSON-first under `/api`. When `apps/web/dist` exists, the runner also serves the production workbench at `http://127.0.0.1:8000`.

Built-in blocks use the deterministic runtime unless a block selects a configured provider. The LLM block and the LLM-backed control blocks (Planner, Router, Supervisor, ReAct) call the provider when one is set on the node and fall back to deterministic output otherwise. A Router only activates the outgoing connections whose route label matches its chosen route, so unselected branches are skipped; connections left unlabeled are unconditional and always run. Imported Python files are parsed with `ast` and run in a network-disabled Docker/Podman container; execution is refused when a safe container runtime is unavailable. API keys use the system keyring when available, otherwise session memory, and values never appear in projects, exports, or API responses.

`GET /api/providers` returns each provider's non-secret `default_model`, and `PUT /api/providers/{provider}/settings` updates it independently from the credential. A node-level model wins over the Provider default. Evaluations snapshot the resolved Provider defaults so later settings changes cannot alter an in-flight baseline/candidate pair.

The runner uses versioned SQLite migrations, immutable revision IDs with project-local sequences and graph hashes, persisted run spans/events, evaluation-suite CRUD, and project-scoped A/B evaluation APIs. Evaluations run baseline/candidate pairs serially with case, token, wall-time, and cost budgets. Exact OpenAI and Anthropic model snapshots listed by `GET /api/pricing` can run cost-bounded A/B: the runner reserves a conservative worst-case cost before every provider request and records input/output token usage against a versioned price registry. Rolling aliases, unknown models, and OpenAI-compatible endpoints remain fail closed.

Evaluation detail, cancellation, deletion, and SSE endpoints require the owning `project_id`. Stored run/evaluation payloads are redacted and capped before they reach SQLite or event streams.

Evaluation-suite creation and updates reject credential-like values and direct users to `secret_ref`. This prevents long-lived plaintext credentials in datasets while keeping ordinary fixture values unchanged for exact assertions.
