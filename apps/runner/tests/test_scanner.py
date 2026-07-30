import json
import os

from fastapi.testclient import TestClient

os.environ.setdefault("RUNNER_DB_PATH", ":memory:")

try:
    from apps.runner import scanner
    from apps.runner.main import app
except ModuleNotFoundError:
    import scanner
    from main import app


client = TestClient(app)

# Obviously fake fixtures shaped like credentials; never place real values here.
FAKE_OPENAI_STYLE_KEY = "sk-" + "0" * 24
FAKE_BEARER = "Bearer " + "x" * 20


def test_scan_graph_flags_sensitive_keys_and_values_without_leaking():
    graph = {
        "blocks": [
            {"id": "a", "block_type": "llm", "config": {"api_key": "placeholder-value", "model": "m"}},
            {"id": "b", "block_type": "tool", "config": {"note": FAKE_BEARER}},
            {"id": "c", "block_type": "tool", "config": {"secret_ref": "vault://ok"}, "code_override": f"KEY = '{FAKE_OPENAI_STYLE_KEY}'"},
        ],
        "edges": [],
    }
    findings = scanner.scan_graph(graph)
    located = {(finding["path"], finding["kind"]) for finding in findings}
    assert ("blocks[0].config.api_key", "sensitive-key") in located
    assert ("blocks[1].config.note", "bearer-token") in located
    assert ("blocks[2].code_override", "api-key-literal") in located
    encoded = json.dumps(findings)
    assert "placeholder-value" not in encoded and FAKE_OPENAI_STYLE_KEY not in encoded and "x" * 20 not in encoded
    assert not any(finding["path"].endswith("secret_ref") for finding in findings)


def test_scan_graph_clean_graph_has_no_findings():
    graph = {
        "blocks": [
            {"id": "a", "block_type": "input", "config": {"url": "https://api.example.com", "temperature": 0}},
            {"id": "b", "block_type": "llm", "config": {"provider": "", "model": "", "base_url": ""}},
        ],
        "edges": [],
    }
    assert scanner.scan_graph(graph) == []


def test_save_warns_and_export_blocks_until_allowed():
    graph = {"blocks": [{"id": "m", "block_type": "llm", "config": {"api_key": "placeholder-not-real"}}], "edges": []}
    created = client.post("/api/projects", json={"name": "scanner-demo", "graph": graph}).json()
    assert any("sensitive-key" in warning for warning in created["credential_warnings"])
    assert "placeholder-not-real" not in json.dumps(created["credential_warnings"])
    pid = created["project"]["id"]
    blocked = client.get(f"/api/projects/{pid}/export")
    assert blocked.status_code == 422
    assert "placeholder-not-real" not in blocked.text
    assert client.get(f"/api/projects/{pid}/export", params={"allow_secrets": "true"}).status_code == 200
    assert client.get(f"/api/projects/{pid}/code-export").status_code == 422
    assert client.get(f"/api/projects/{pid}/code-export", params={"allow_secrets": "true"}).status_code == 200


def test_update_and_revision_endpoints_report_credential_warnings():
    clean = {"blocks": [{"id": "a", "block_type": "input"}], "edges": []}
    created = client.post("/api/projects", json={"name": "scanner-update", "graph": clean}).json()
    assert created["credential_warnings"] == []
    pid = created["project"]["id"]
    leaky = {"blocks": [{"id": "a", "block_type": "tool", "config": {"password": "placeholder"}}], "edges": []}
    updated = client.patch(f"/api/projects/{pid}", json={"graph": leaky}).json()
    assert any("sensitive-key" in warning for warning in updated["credential_warnings"])
    revision = client.post(f"/api/projects/{pid}/revisions", json=leaky).json()
    assert any("sensitive-key" in warning for warning in revision["credential_warnings"])
    assert "placeholder" not in json.dumps(revision["credential_warnings"])


def test_python_import_reports_credential_warnings():
    source = f"TOKEN = '{FAKE_OPENAI_STYLE_KEY}'\n\ndef run(x):\n    return x\n"
    result = client.post("/api/import/python", files={"file": ("leaky.py", source.encode())}).json()
    assert any("credential-like content" in warning for warning in result["warnings"])
    clean = client.post("/api/import/python", files={"file": ("clean.py", b"def run(x):\n    return x\n")}).json()
    assert not any("credential-like content" in warning for warning in clean["warnings"])
