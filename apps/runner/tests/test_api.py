import io
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import time
import zipfile

from fastapi.testclient import TestClient
import httpx
import pytest

os.environ["RUNNER_DB_PATH"] = ":memory:"

try:
    from apps.runner.main import Store, app, _assert_result, _evaluate_case, _run_process_capped, _sanitize_proxy_env, _validated_compatible_base_url, run_events
except ModuleNotFoundError:
    from main import Store, app, _assert_result, _evaluate_case, _run_process_capped, _sanitize_proxy_env, _validated_compatible_base_url, run_events


client = TestClient(app)


def _await_run(run_id, attempts=100):
    for _ in range(attempts):
        detail = client.get(f"/api/runs/{run_id}").json()
        if detail["status"] != "running":
            return detail
        time.sleep(0.02)
    return client.get(f"/api/runs/{run_id}").json()


def test_health_templates():
    assert client.get("/api/health").status_code == 200
    templates = client.get("/api/templates").json()
    assert len(templates) >= 7

    pricing = client.get("/api/pricing").json()
    assert pricing["version"] == "2026-07-17"
    priced_models = {(item["provider"], item["model"]) for item in pricing["models"]}
    assert ("openai", "gpt-4.1-2025-04-14") in priced_models
    assert ("openai", "gpt-4.1") not in priced_models


def test_schema_v2_upgrades_provider_settings_and_evaluation_snapshot(monkeypatch):
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "legacy.db")
        connection = sqlite3.connect(path)
        connection.execute("PRAGMA user_version=2")
        connection.commit(); connection.close()
        monkeypatch.setenv("RUNNER_DB_PATH", path)
        migrated = Store()
        assert migrated.conn.execute("PRAGMA user_version").fetchone()[0] == 3
        assert migrated.conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_settings'").fetchone()
        columns = {row[1] for row in migrated.conn.execute("PRAGMA table_info(evaluations)")}
        assert "provider_snapshot" in columns
        migrated.conn.close()


def test_project_validate_run():
    p = client.post("/api/projects", json={"name": "demo", "graph": {"blocks": [{"id": "a", "block_type": "input"}, {"id": "b", "block_type": "output"}], "edges": [{"source": "a", "target": "b"}]}})
    assert p.status_code == 200
    pid = p.json()["project"]["id"]
    run = client.post("/api/runs", json={"project_id": pid, "input": "hello"})
    assert run.status_code == 200
    rid = run.json()["id"]
    for _ in range(30):
        detail = client.get(f"/api/runs/{rid}").json()
        if detail["status"] != "running": break
        time.sleep(0.02)
    assert detail["status"] == "completed"


def test_python_import_and_export():
    r = client.post("/api/import/python", files={"file": ("x.py", b"def foo(x): return x\nclass Bar: pass")})
    assert r.status_code == 200
    assert r.json()["functions"][0]["name"] == "foo"
    assert len(r.json()["sha256"]) == 64


def test_cycle_validation_and_secret_redaction():
    graph = {
        "blocks": [{"id": "a", "block_type": "input"}, {"id": "b", "block_type": "output"}],
        "edges": [{"source": "a", "target": "b"}, {"source": "b", "target": "a"}],
    }
    result = client.post("/api/validate", json=graph).json()
    assert result["valid"] is False
    assert any("cycle" in error for error in result["errors"])

    saved = client.put("/api/providers/openai/secret", json={"api_key": "not-returned", "persist": False})
    assert saved.status_code == 200 and "api_key" not in saved.json()
    providers = client.get("/api/providers").json()
    assert "not-returned" not in json.dumps(providers)


def test_project_and_code_archives():
    created = client.post("/api/projects", json={
        "name": "archive-demo",
        "graph": {"blocks": [{"id": "a", "block_type": "input"}, {"id": "b", "block_type": "output"}], "edges": [{"source": "a", "target": "b"}]},
    }).json()
    pid = created["project"]["id"]
    for endpoint, required in (("export", "project.json"), ("code-export", "graph.json")):
        response = client.get(f"/api/projects/{pid}/{endpoint}")
        assert response.status_code == 200
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            assert required in archive.namelist()


@pytest.mark.skipif(not (shutil.which("docker") or shutil.which("podman")), reason="container runtime unavailable")
def test_builtin_instance_code_override_executes_in_container():
    code = "async def execute(context, inputs, config):\n    return {'changed': inputs['message'].upper()}\n"
    graph = {
        "blocks": [
            {"id": "input", "block_type": "input"},
            {"id": "model", "block_type": "llm", "code_override": code},
            {"id": "output", "block_type": "output"},
        ],
        "edges": [{"source": "input", "target": "model"}, {"source": "model", "target": "output"}],
    }
    created = client.post("/api/projects", json={"name": "override", "graph": graph}).json()
    run = client.post("/api/runs", json={"project_id": created["project"]["id"], "input": {"message": "hello"}}).json()
    for _ in range(100):
        detail = client.get(f"/api/runs/{run['id']}").json()
        if detail["status"] != "running":
            break
        time.sleep(0.03)
    assert detail["status"] == "completed"
    assert detail["output"] == {"changed": "HELLO"}


def test_validation_returns_structured_errors():
    unknown = client.post("/api/validate", json={"blocks": [{"id": "a", "block_type": "input"}], "edges": [{"source": "missing", "target": "a"}]})
    assert unknown.status_code == 200
    assert unknown.json()["valid"] is False

    bad_loop = client.post("/api/validate", json={"blocks": [{"id": "loop", "block_type": "react_loop", "config": {"max_steps": "oops"}}], "edges": []})
    assert bad_loop.status_code == 200
    assert any("integer" in error for error in bad_loop.json()["errors"])


def test_revision_must_belong_to_project():
    graph = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    first = client.post("/api/projects", json={"name": "first", "graph": graph}).json()
    second = client.post("/api/projects", json={"name": "second", "graph": graph}).json()
    response = client.post("/api/runs", json={"project_id": first["project"]["id"], "revision_id": second["revision"]["id"], "input": None})
    assert response.status_code == 400


def test_code_export_sanitizes_paths_and_runs_async_block():
    code = "async def execute(context, inputs, config):\n    return {'exported': inputs['message']}\n"
    graph = {"blocks": [{"id": "../../escape", "block_type": "custom:block.py", "source": "custom:block.py", "code_override": code, "config": {"entrypoint": "execute"}}], "edges": []}
    created = client.post("/api/projects", json={"name": "export-security", "graph": graph}).json()
    archive_response = client.get(f"/api/projects/{created['project']['id']}/code-export")
    with zipfile.ZipFile(io.BytesIO(archive_response.content)) as archive:
        assert all(".." not in name.split("/") for name in archive.namelist())
        with tempfile.TemporaryDirectory() as directory:
            archive.extractall(directory)
            completed = subprocess.run(["python", "agent.py"], cwd=directory, input='{"message":"ok"}', text=True, capture_output=True, check=True)
            assert json.loads(completed.stdout) == {"exported": "ok"}


def test_openai_compatible_open_by_default_and_env_lockdown(monkeypatch):
    # Open by default: any valid base_url is accepted without an allowlist.
    monkeypatch.delenv("AGENTLAB_OPENAI_COMPATIBLE_ALLOWLIST", raising=False)
    assert _validated_compatible_base_url("https://api.deepseek.com/v1") == "https://api.deepseek.com/v1"
    # Malformed base_url is still rejected (missing scheme).
    with pytest.raises(RuntimeError, match="valid base_url"):
        _validated_compatible_base_url("api.deepseek.com")
    # Opt-in lockdown: once the env allowlist is set it becomes a hard restriction.
    monkeypatch.setenv("AGENTLAB_OPENAI_COMPATIBLE_ALLOWLIST", "trusted.example.com")
    assert _validated_compatible_base_url("https://trusted.example.com/v1") == "https://trusted.example.com/v1"
    with pytest.raises(RuntimeError, match="allow-listed"):
        _validated_compatible_base_url("https://attacker.invalid/v1")


def test_openai_compatible_run_reaches_endpoint_when_open(monkeypatch):
    monkeypatch.delenv("AGENTLAB_OPENAI_COMPATIBLE_ALLOWLIST", raising=False)
    calls = []

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": "compatible answer"}}], "usage": {"prompt_tokens": 3, "completion_tokens": 2}}

    def fake_post(url, **kwargs):
        calls.append(url)
        return Response()

    monkeypatch.setattr(httpx, "post", fake_post)
    client.put("/api/providers/openai-compatible/secret", json={"api_key": "fake-compatible", "persist": False})
    graph = {"blocks": [{"id": "model", "block_type": "llm", "config": {"provider": "openai-compatible", "model": "deepseek-test", "base_url": "https://api.deepseek.com/v1"}}], "edges": []}
    created = client.post("/api/projects", json={"name": "compatible-open", "graph": graph}).json()
    run = client.post("/api/runs", json={"project_id": created["project"]["id"], "input": "hello"}).json()
    for _ in range(50):
        detail = client.get(f"/api/runs/{run['id']}").json()
        if detail["status"] != "running":
            break
        time.sleep(0.02)
    assert detail["status"] == "completed"
    assert detail["output"]["text"] == "compatible answer"
    assert calls and calls[-1] == "https://api.deepseek.com/v1/chat/completions"


def test_sanitize_proxy_env_keeps_http_and_handles_bare_socks(monkeypatch):
    monkeypatch.setenv("ALL_PROXY", "socks://127.0.0.1:7897")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7897")
    monkeypatch.setenv("HTTP_PROXY", "ftp://127.0.0.1:21")
    _sanitize_proxy_env()
    # A working http(s) proxy is preserved so provider calls still route through it.
    assert os.environ.get("HTTPS_PROXY") == "http://127.0.0.1:7897"
    # An unsupported scheme is dropped rather than crashing httpx client construction.
    assert os.environ.get("HTTP_PROXY") is None
    # A bare socks:// is normalized to socks5://; dropped only when socksio is absent.
    all_proxy = os.environ.get("ALL_PROXY")
    assert all_proxy is None or all_proxy.startswith("socks5://")


def test_subprocess_output_is_capped():
    with pytest.raises(RuntimeError, match="output exceeded"):
        _run_process_capped(["python", "-c", "print('x' * 2000000)"], "", timeout=5, max_output=100000)


def test_sse_reconnect_receives_terminal_event_after_cache_cleanup():
    graph = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    created = client.post("/api/projects", json={"name": "sse-reconnect", "graph": graph}).json()
    run = client.post("/api/runs", json={"project_id": created["project"]["id"], "input": "done"}).json()
    for _ in range(50):
        detail = client.get(f"/api/runs/{run['id']}").json()
        if detail["status"] != "running":
            break
        time.sleep(0.02)
    run_events.pop(run["id"], None)
    with client.stream("GET", f"/api/runs/{run['id']}/events") as response:
        body = "\n".join(response.iter_lines())
    assert "run_completed" in body


def test_revision_sequence_hash_and_persisted_run_trace():
    graph = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    created = client.post("/api/projects", json={"name": "revision-metadata", "graph": graph}).json()
    second = client.post(f"/api/projects/{created['project']['id']}/revisions", json=graph).json()
    assert created["revision"]["sequence"] == 1
    assert second["sequence"] == 2 and len(second["graph_hash"]) == 64
    run = client.post("/api/runs", json={"project_id": created["project"]["id"], "revision_id": second["id"], "input": "trace"}).json()
    for _ in range(50):
        detail = client.get(f"/api/runs/{run['id']}").json()
        if detail["status"] != "running": break
        time.sleep(.02)
    assert detail["metrics"]["duration_ms"] >= 0
    listed = client.get(f"/api/projects/{created['project']['id']}/runs").json()
    assert listed[0]["revision_sequence"] == 2
    assert detail["spans"][0]["status"] == "completed"


def test_eval_suite_ab_snapshot_comparison_and_history_protection():
    graph = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    created = client.post("/api/projects", json={"name": "eval-project", "graph": graph}).json()
    pid, baseline = created["project"]["id"], created["revision"]["id"]
    candidate = client.post(f"/api/projects/{pid}/revisions", json=graph).json()["id"]
    suite = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "smoke", "cases": [{"name": "same", "input": "hello", "expected": "hello", "assertions": [{"type": "exact", "value": "hello"}]}]}).json()
    evaluation = client.post(f"/api/projects/{pid}/evaluations", json={"eval_suite_id": suite["id"], "baseline_revision_id": baseline, "candidate_revision_id": candidate, "budgets": {"max_cases": 1, "max_tokens": 100, "max_wall_seconds": 10, "max_cost_usd": 1}})
    assert evaluation.status_code == 200
    eid = evaluation.json()["id"]
    for _ in range(100):
        result = client.get(f"/api/evaluations/{eid}", params={"project_id": pid}).json()
        if result["status"] not in ("queued", "running"): break
        time.sleep(.02)
    assert result["status"] == "completed"
    assert result["metrics"]["baseline_pass_rate"] == 1
    assert result["metrics"]["candidate_pass_rate"] == 1
    assert result["metrics"]["unchanged"] == 1
    assert len(result["eval_suite_hash"]) == 64
    assert client.delete(f"/api/projects/{pid}/eval-suites/{suite['id']}").status_code == 409
    assert client.get(f"/api/projects/{pid}/evaluations").json()[0]["id"] == eid


def test_evaluation_rejects_cross_project_revision_and_limits_cases():
    graph = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    first = client.post("/api/projects", json={"name": "eval-first", "graph": graph}).json()
    second = client.post("/api/projects", json={"name": "eval-second", "graph": graph}).json()
    pid = first["project"]["id"]
    suite = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "suite", "cases": []}).json()
    response = client.post(f"/api/projects/{pid}/evaluations", json={"eval_suite_id": suite["id"], "baseline_revision_id": first["revision"]["id"], "candidate_revision_id": second["revision"]["id"]})
    assert response.status_code == 400


def test_persisted_run_payloads_redact_secret_like_fields():
    graph = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    created = client.post("/api/projects", json={"name": "redacted-run", "graph": graph}).json()
    run = client.post("/api/runs", json={"project_id": created["project"]["id"], "input": {"api_key": "do-not-store", "nested": {"Authorization": "Bearer hidden"}}}).json()
    for _ in range(50):
        detail = client.get(f"/api/runs/{run['id']}").json()
        if detail["status"] != "running": break
        time.sleep(.02)
    encoded = json.dumps(detail)
    assert "do-not-store" not in encoded and "Bearer hidden" not in encoded
    assert detail["input"]["api_key"] == "[REDACTED]"


def test_evaluation_detail_is_project_scoped_and_unpriced_provider_allowed():
    graph = {"blocks": [{"id": "model", "block_type": "llm", "config": {"provider": "openai"}}], "edges": []}
    first = client.post("/api/projects", json={"name": "priced-first", "graph": graph}).json()
    second = client.post("/api/projects", json={"name": "priced-second", "graph": {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}}).json()
    pid = first["project"]["id"]
    candidate = client.post(f"/api/projects/{pid}/revisions", json=graph).json()["id"]
    suite = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "suite", "cases": [{"name": "case", "input": "hello"}]}).json()
    response = client.post(f"/api/projects/{pid}/evaluations", json={"eval_suite_id": suite["id"], "baseline_revision_id": first["revision"]["id"], "candidate_revision_id": candidate})
    # Unpriced models are now allowed; the USD budget just isn't pre-reserved for them.
    assert response.status_code == 200
    assert response.json().get("cost_unenforced_models")

    safe_graph = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    safe = client.post("/api/projects", json={"name": "scoped-eval", "graph": safe_graph}).json()
    safe_pid = safe["project"]["id"]
    safe_candidate = client.post(f"/api/projects/{safe_pid}/revisions", json=safe_graph).json()["id"]
    safe_suite = client.post(f"/api/projects/{safe_pid}/eval-suites", json={"name": "safe", "cases": [{"name": "same", "input": "hello", "assertions": [{"type": "exact", "value": "hello"}]}]}).json()
    evaluation = client.post(f"/api/projects/{safe_pid}/evaluations", json={"eval_suite_id": safe_suite["id"], "baseline_revision_id": safe["revision"]["id"], "candidate_revision_id": safe_candidate}).json()
    assert client.get(f"/api/evaluations/{evaluation['id']}", params={"project_id": second["project"]["id"]}).status_code == 404
    assert client.get(f"/api/evaluations/{evaluation['id']}", params={"project_id": safe_pid}).status_code == 200


def test_unpriced_compatible_ab_runs_without_cost_enforcement(monkeypatch):
    monkeypatch.delenv("AGENTLAB_OPENAI_COMPATIBLE_ALLOWLIST", raising=False)

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": "compatible"}}], "usage": {"prompt_tokens": 3, "completion_tokens": 2}}

    monkeypatch.setattr(httpx, "post", lambda url, **kwargs: Response())
    client.put("/api/providers/openai-compatible/secret", json={"api_key": "fake-eval", "persist": False})
    graph = {"blocks": [{"id": "model", "block_type": "llm", "config": {"provider": "openai-compatible", "model": "deepseek-test", "base_url": "https://api.deepseek.com/v1"}}], "edges": []}
    created = client.post("/api/projects", json={"name": "unpriced-ab", "graph": graph}).json()
    pid = created["project"]["id"]
    candidate = client.post(f"/api/projects/{pid}/revisions", json=graph).json()["id"]
    suite = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "unpriced", "cases": [{"name": "case", "input": "hello", "assertions": [{"type": "contains", "value": "compatible"}]}]}).json()
    evaluation = client.post(f"/api/projects/{pid}/evaluations", json={"eval_suite_id": suite["id"], "baseline_revision_id": created["revision"]["id"], "candidate_revision_id": candidate, "budgets": {"max_cases": 1, "max_tokens": 1000, "max_wall_seconds": 10, "max_cost_usd": 1}})
    assert evaluation.status_code == 200
    eid = evaluation.json()["id"]
    for _ in range(100):
        result = client.get(f"/api/evaluations/{eid}", params={"project_id": pid}).json()
        if result["status"] not in ("queued", "running"):
            break
        time.sleep(.02)
    assert result["status"] == "completed"
    assert result["metrics"]["unchanged"] == 1
    # Cost stays unavailable for unpriced models; the token budget bounds spend instead.
    assert result["metrics"]["total_cost_usd"] is None


def test_tool_called_assertion_handles_scalar_span_output():
    ok, message = _assert_result({"type": "tool_called", "value": "read_file"}, None, [{"block_type": "tool", "status": "completed", "output": "1"}], {})
    assert ok is False and "tool identity" in message
    result = _evaluate_case({"assertions": [{"type": "max_cost_usd", "value": 1}]}, {"status": "completed", "output": "ok", "metrics": {}}, [])
    assert result["skipped"] is True and result["passed"] is False


def test_regex_and_json_schema_assertions():
    ok, _ = _assert_result({"type": "regex", "value": "hel+o"}, "hello world", [], {})
    assert ok is True
    ok, message = _assert_result({"type": "regex", "value": "hel+o"}, {"text": "hello"}, [], {})
    assert ok is True
    ok, message = _assert_result({"type": "regex", "value": "["}, "hello", [], {})
    assert ok is False and "invalid regex" in message
    ok, _ = _assert_result({"type": "json_schema", "value": {"type": "object", "required": ["text"]}}, {"text": "hi"}, [], {})
    assert ok is True
    ok, message = _assert_result({"type": "json_schema", "value": {"type": "object", "required": ["missing"]}}, {"text": "hi"}, [], {})
    assert ok is False and "schema mismatch" in message and "hi" not in message


def test_suite_rejects_invalid_assertions():
    graph = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    created = client.post("/api/projects", json={"name": "assertion-validation", "graph": graph}).json()
    pid = created["project"]["id"]
    bad_type = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "bad", "cases": [{"name": "case", "input": "x", "assertions": [{"type": "nope", "value": 1}]}]})
    assert bad_type.status_code == 422 and "unsupported assertion type" in bad_type.text
    bad_regex = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "bad-regex", "cases": [{"name": "case", "input": "x", "assertions": [{"type": "regex", "value": "["}]}]})
    assert bad_regex.status_code == 422
    bad_schema = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "bad-schema", "cases": [{"name": "case", "input": "x", "assertions": [{"type": "json_schema", "value": {"type": "nope"}}]}]})
    assert bad_schema.status_code == 422
    good = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "good", "cases": [{"name": "case", "input": "x", "assertions": [{"type": "regex", "value": "^x$"}, {"type": "json_schema", "value": {"type": "string"}}]}]})
    assert good.status_code == 200


def test_regex_json_schema_end_to_end_evaluation():
    graph = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    created = client.post("/api/projects", json={"name": "assert-e2e", "graph": graph}).json()
    pid = created["project"]["id"]
    candidate = client.post(f"/api/projects/{pid}/revisions", json=graph).json()["id"]
    suite = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "regex-schema", "cases": [{"name": "case", "input": "hello", "assertions": [{"type": "regex", "value": "^hel"}, {"type": "json_schema", "value": {"type": "string"}}]}]}).json()
    evaluation = client.post(f"/api/projects/{pid}/evaluations", json={"eval_suite_id": suite["id"], "baseline_revision_id": created["revision"]["id"], "candidate_revision_id": candidate, "budgets": {"max_cases": 1, "max_tokens": 100, "max_wall_seconds": 10, "max_cost_usd": 1}}).json()
    for _ in range(100):
        result = client.get(f"/api/evaluations/{evaluation['id']}", params={"project_id": pid}).json()
        if result["status"] not in ("queued", "running"): break
        time.sleep(.02)
    assert result["status"] == "completed"
    assert result["cases"][0]["status"] == "both_pass"


def test_revision_delete_cascades_runs_but_protects_evaluations_and_last():
    graph = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    created = client.post("/api/projects", json={"name": "rev-delete", "graph": graph}).json()
    pid, first_rev = created["project"]["id"], created["revision"]["id"]
    # The only revision cannot be deleted.
    assert client.delete(f"/api/projects/{pid}/revisions/{first_rev}").status_code == 409
    second = client.post(f"/api/projects/{pid}/revisions", json=graph).json()["id"]
    # A run pins the second revision, but deletion now cascades the run away.
    run = client.post("/api/runs", json={"project_id": pid, "revision_id": second, "input": "x"}).json()
    for _ in range(50):
        if client.get(f"/api/runs/{run['id']}").json()["status"] != "running":
            break
        time.sleep(0.02)
    assert client.delete(f"/api/projects/{pid}/revisions/{second}").status_code == 200
    assert client.get(f"/api/runs/{run['id']}").status_code == 404
    assert client.get(f"/api/projects/{pid}/revisions/{second}").status_code == 404
    # A revision referenced by an A/B evaluation is protected.
    third = client.post(f"/api/projects/{pid}/revisions", json=graph).json()["id"]
    suite = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "s", "cases": [{"name": "c", "input": "hello", "assertions": [{"type": "exact", "value": "hello"}]}]}).json()
    evaluation = client.post(f"/api/projects/{pid}/evaluations", json={"eval_suite_id": suite["id"], "baseline_revision_id": first_rev, "candidate_revision_id": third, "budgets": {"max_cases": 1, "max_tokens": 100, "max_wall_seconds": 10, "max_cost_usd": 1}})
    assert evaluation.status_code == 200
    eid = evaluation.json()["id"]
    for _ in range(100):
        if client.get(f"/api/evaluations/{eid}", params={"project_id": pid}).json()["status"] not in ("queued", "running"):
            break
        time.sleep(0.02)
    protected = client.delete(f"/api/projects/{pid}/revisions/{third}")
    assert protected.status_code == 409 and "evaluation" in protected.text
    # Deleting a revision from another project is a 404.
    other = client.post("/api/projects", json={"name": "rev-delete-other", "graph": graph}).json()
    assert client.delete(f"/api/projects/{other['project']['id']}/revisions/{first_rev}").status_code == 404


def test_control_blocks_fall_back_to_deterministic_without_provider():
    for block_type, graph_extra in (
        ("planner", {}),
        ("router", {"config": {"default_route": "fallback"}}),
        ("supervisor", {}),
        ("react_loop", {}),
    ):
        block = {"id": "c", "block_type": block_type, **graph_extra}
        graph = {"blocks": [block], "edges": []}
        created = client.post("/api/projects", json={"name": f"det-{block_type}", "graph": graph}).json()
        run = client.post("/api/runs", json={"project_id": created["project"]["id"], "input": "hello"}).json()
        for _ in range(50):
            detail = client.get(f"/api/runs/{run['id']}").json()
            if detail["status"] != "running":
                break
            time.sleep(0.02)
        assert detail["status"] == "completed"
        assert detail["metrics"].get("tokens", 0) == 0  # no real calls made


def test_control_blocks_use_real_provider_when_configured(monkeypatch):
    responses = {}

    class Response:
        def __init__(self, content):
            self._content = content

        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": self._content}}], "usage": {"prompt_tokens": 5, "completion_tokens": 3}}

    def fake_post(url, **kwargs):
        # Return a route label for router prompts, otherwise a generic answer/plan.
        prompt = kwargs.get("json", {}).get("messages", [{}])[0].get("content", "")
        content = "support" if "Classify the request" in prompt else "FINAL: done" if "FINAL:" in prompt else "step one\nstep two"
        responses.setdefault("count", 0)
        responses["count"] += 1
        return Response(content)

    monkeypatch.setattr(httpx, "post", fake_post)
    client.put("/api/providers/openai-compatible/secret", json={"api_key": "fake-control", "persist": False})
    cfg = {"provider": "openai-compatible", "model": "deepseek-test", "base_url": "https://api.deepseek.com/v1"}

    planner = client.post("/api/projects", json={"name": "real-planner", "graph": {"blocks": [{"id": "p", "block_type": "planner", "config": cfg}], "edges": []}}).json()
    run = client.post("/api/runs", json={"project_id": planner["project"]["id"], "input": "ship the feature"}).json()
    detail = _await_run(run["id"])
    assert detail["status"] == "completed"
    assert detail["output"]["steps"] == ["step one", "step two"]
    assert detail["metrics"]["tokens"] == 8

    router = client.post("/api/projects", json={"name": "real-router", "graph": {"blocks": [{"id": "r", "block_type": "router", "config": {**cfg, "routes": ["research", "support"]}}], "edges": []}}).json()
    run = client.post("/api/runs", json={"project_id": router["project"]["id"], "input": "my order is late"}).json()
    detail = _await_run(run["id"])
    assert detail["status"] == "completed"
    assert detail["output"]["route"] == "support"

    supervisor = client.post("/api/projects", json={"name": "real-supervisor", "graph": {"blocks": [{"id": "s", "block_type": "supervisor", "config": cfg}], "edges": []}}).json()
    run = client.post("/api/runs", json={"project_id": supervisor["project"]["id"], "input": "coordinate the launch"}).json()
    detail = _await_run(run["id"])
    assert detail["status"] == "completed"
    assert detail["output"]["coordination"] == "supervised" and detail["output"]["answer"]

    react = client.post("/api/projects", json={"name": "real-react", "graph": {"blocks": [{"id": "x", "block_type": "react_loop", "config": {**cfg, "max_steps": 3}}], "edges": []}}).json()
    run = client.post("/api/runs", json={"project_id": react["project"]["id"], "input": "answer the question"}).json()
    detail = _await_run(run["id"])
    assert detail["status"] == "completed"
    assert detail["output"]["iterations"] >= 1 and detail["output"]["answer"] == "done"
    assert detail["metrics"]["tokens"] >= 8


def test_router_conditional_branch_skips_unselected_path():
    graph = {
        "blocks": [
            {"id": "in", "block_type": "input"},
            {"id": "r", "block_type": "router", "config": {"routes": ["left", "right"], "default_route": "right"}},
            {"id": "L", "block_type": "tool"},
            {"id": "R", "block_type": "memory"},
        ],
        "edges": [
            {"id": "e-in", "source": "in", "target": "r"},
            {"id": "e-left", "source": "r", "target": "L", "source_port": "left"},
            {"id": "e-right", "source": "r", "target": "R", "source_port": "right"},
        ],
    }
    created = client.post("/api/projects", json={"name": "branch", "graph": graph}).json()
    run = client.post("/api/runs", json={"project_id": created["project"]["id"], "input": "hi"}).json()
    detail = _await_run(run["id"])
    assert detail["status"] == "completed"
    spans = {span["node_id"]: span["status"] for span in detail["spans"]}
    # The deterministic router (no provider) picks default_route "right", so only R runs.
    assert spans.get("R") == "completed"
    assert spans.get("L") == "skipped"


def test_unrouted_edges_run_all_branches():
    graph = {
        "blocks": [
            {"id": "in", "block_type": "input"},
            {"id": "r", "block_type": "router", "config": {"routes": ["left", "right"], "default_route": "right"}},
            {"id": "L", "block_type": "tool"},
            {"id": "R", "block_type": "memory"},
        ],
        "edges": [
            {"id": "e-in", "source": "in", "target": "r"},
            {"id": "e-left", "source": "r", "target": "L"},
            {"id": "e-right", "source": "r", "target": "R"},
        ],
    }
    created = client.post("/api/projects", json={"name": "no-branch", "graph": graph}).json()
    run = client.post("/api/runs", json={"project_id": created["project"]["id"], "input": "hi"}).json()
    detail = _await_run(run["id"])
    assert detail["status"] == "completed"
    spans = {span["node_id"]: span["status"] for span in detail["spans"]}
    # No source_port labels means unconditional edges: both branches execute (backward compatible).
    assert spans.get("L") == "completed" and spans.get("R") == "completed"


def test_run_sse_resumes_from_last_event_id():
    graph = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    created = client.post("/api/projects", json={"name": "sse-resume", "graph": graph}).json()
    run = client.post("/api/runs", json={"project_id": created["project"]["id"], "input": "resume"}).json()
    for _ in range(50):
        detail = client.get(f"/api/runs/{run['id']}").json()
        if detail["status"] != "running": break
        time.sleep(0.02)
    with client.stream("GET", f"/api/runs/{run['id']}/events") as response:
        full = "\n".join(response.iter_lines())
    assert "id: 1" in full and "run_started" in full and "run_completed" in full
    with client.stream("GET", f"/api/runs/{run['id']}/events", headers={"Last-Event-ID": "1"}) as response:
        resumed = "\n".join(response.iter_lines())
    assert "run_started" not in resumed and "run_completed" in resumed


def test_redaction_does_not_change_exact_evaluation_semantics():
    graph = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    created = client.post("/api/projects", json={"name": "semantic-redaction", "graph": graph}).json()
    pid = created["project"]["id"]
    candidate = client.post(f"/api/projects/{pid}/revisions", json=graph).json()["id"]
    suite = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "private-values", "cases": [{"name": "different", "input": {"private_value": "real-value"}, "assertions": [{"type": "exact", "value": {"private_value": "different-value"}}]}]}).json()
    assert suite["cases"][0]["input"]["private_value"] == "real-value"
    evaluation = client.post(f"/api/projects/{pid}/evaluations", json={"eval_suite_id": suite["id"], "baseline_revision_id": created["revision"]["id"], "candidate_revision_id": candidate}).json()
    for _ in range(100):
        result = client.get(f"/api/evaluations/{evaluation['id']}", params={"project_id": pid}).json()
        if result["status"] not in ("queued", "running"): break
        time.sleep(.02)
    assert result["cases"][0]["status"] == "both_fail"

    rejected = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "credentials", "cases": [{"name": "secret", "input": {"password": "must-not-persist"}}]})
    assert rejected.status_code == 422 and "secret_ref" in rejected.text


def test_priced_provider_usage_enables_cost_bounded_evaluation(monkeypatch):
    calls = []

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [{"message": {"content": "mocked answer"}}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6, "prompt_tokens_details": {"cached_tokens": 1}},
            }

    def fake_post(url, **kwargs):
        calls.append({"url": url, "json": kwargs.get("json")})
        return Response()

    monkeypatch.setattr(httpx, "post", fake_post)
    client.put("/api/providers/openai/secret", json={"api_key": "fake-priced-key", "persist": False})
    settings = client.put("/api/providers/openai/settings", json={"default_model": "gpt-4.1-2025-04-14"})
    assert settings.status_code == 200 and settings.json()["default_model"] == "gpt-4.1-2025-04-14"
    assert "fake-priced-key" not in json.dumps(client.get("/api/providers").json())
    graph = {
        "blocks": [{"id": "model", "block_type": "llm", "config": {"provider": "openai", "model": "", "max_tokens": 8}}],
        "edges": [],
    }
    created = client.post("/api/projects", json={"name": "priced-evaluation", "graph": graph}).json()
    pid = created["project"]["id"]
    candidate = client.post(f"/api/projects/{pid}/revisions", json=graph).json()["id"]

    run = client.post("/api/runs", json={"project_id": pid, "revision_id": created["revision"]["id"], "input": "hello"}).json()
    for _ in range(100):
        run_detail = client.get(f"/api/runs/{run['id']}").json()
        if run_detail["status"] != "running":
            break
        time.sleep(.02)
    assert run_detail["status"] == "completed"
    assert run_detail["metrics"]["tokens"] == 6
    assert run_detail["metrics"]["input_tokens"] == 4
    assert run_detail["metrics"]["cached_input_tokens"] == 1
    assert run_detail["spans"][0]["metrics"]["cached_input_tokens"] == 1
    assert run_detail["metrics"]["output_tokens"] == 2
    assert run_detail["metrics"]["cost_usd"] == pytest.approx(0.0000225)
    assert run_detail["metrics"]["pricing_version"] == "2026-07-17"
    assert run_detail["spans"][0]["metrics"]["pricing_version"] == "2026-07-17"
    assert calls[-1]["json"]["max_tokens"] == 8
    assert calls[-1]["json"]["model"] == "gpt-4.1-2025-04-14"

    suite = client.post(f"/api/projects/{pid}/eval-suites", json={
        "name": "priced suite",
        "cases": [{"name": "answer", "input": "hello", "assertions": [{"type": "contains", "value": "mocked"}]}],
    }).json()
    evaluation = client.post(f"/api/projects/{pid}/evaluations", json={
        "eval_suite_id": suite["id"],
        "baseline_revision_id": created["revision"]["id"],
        "candidate_revision_id": candidate,
        "budgets": {"max_cases": 1, "max_tokens": 100, "max_wall_seconds": 10, "max_cost_usd": 0.01},
    })
    assert evaluation.status_code == 200
    for _ in range(100):
        result = client.get(f"/api/evaluations/{evaluation.json()['id']}", params={"project_id": pid}).json()
        if result["status"] not in ("queued", "running"):
            break
        time.sleep(.02)
    assert result["status"] == "completed"
    assert result["metrics"]["total_cost_usd"] == pytest.approx(0.000045)
    assert result["metrics"]["pricing_version"] == "2026-07-17"
    assert result["provider_snapshot"]["openai"] == "gpt-4.1-2025-04-14"
    assert result["metrics"]["unchanged"] == 1


def test_cost_guard_blocks_provider_call_before_spend(monkeypatch):
    called = False

    def forbidden_post(*args, **kwargs):
        nonlocal called
        called = True
        raise AssertionError("provider request must not be sent")

    monkeypatch.setattr(httpx, "post", forbidden_post)
    client.put("/api/providers/openai/secret", json={"api_key": "fake-budget-key", "persist": False})
    graph = {
        "blocks": [{"id": "model", "block_type": "llm", "config": {"provider": "openai", "model": "gpt-4.1-2025-04-14", "max_tokens": 1024}}],
        "edges": [],
    }
    created = client.post("/api/projects", json={"name": "hard-cost-budget", "graph": graph}).json()
    pid = created["project"]["id"]
    candidate = client.post(f"/api/projects/{pid}/revisions", json=graph).json()["id"]
    suite = client.post(f"/api/projects/{pid}/eval-suites", json={"name": "budget suite", "cases": [{"name": "case", "input": "hello"}]}).json()
    evaluation = client.post(f"/api/projects/{pid}/evaluations", json={
        "eval_suite_id": suite["id"],
        "baseline_revision_id": created["revision"]["id"],
        "candidate_revision_id": candidate,
        "budgets": {"max_cases": 1, "max_tokens": 10000, "max_wall_seconds": 10, "max_cost_usd": 0.001},
    })
    assert evaluation.status_code == 200
    for _ in range(100):
        result = client.get(f"/api/evaluations/{evaluation.json()['id']}", params={"project_id": pid}).json()
        if result["status"] not in ("queued", "running"):
            break
        time.sleep(.02)
    assert result["status"] == "partial"
    assert result["metrics"]["stop_reason"] == "max_cost_usd"
    assert called is False
