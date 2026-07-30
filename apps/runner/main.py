from __future__ import annotations

import ast
import hashlib
import io
import json
import os
import selectors
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from .pricing import CostBudgetGuard, conservative_input_token_limit, get_model_price, pricing_metadata
    from .assertions import SUPPORTED_ASSERTION_TYPES, _assert_result, _evaluate_case, assertion_problems
    from .scanner import credential_warnings, scan_graph, scan_text
except ImportError:  # pragma: no cover - direct execution from apps/runner
    from pricing import CostBudgetGuard, conservative_input_token_limit, get_model_price, pricing_metadata
    from assertions import SUPPORTED_ASSERTION_TYPES, _assert_result, _evaluate_case, assertion_problems
    from scanner import credential_warnings, scan_graph, scan_text

try:
    import keyring
except ImportError:  # pragma: no cover - optional on minimal installations
    keyring = None


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class Port(BaseModel):
    name: str
    type: str = "any"
    required: bool = False


class BlockManifest(BaseModel):
    id: str
    type: str
    label: str
    version: str = "1.0.0"
    ports_in: List[Port] = Field(default_factory=list)
    ports_out: List[Port] = Field(default_factory=list)
    config_schema: Dict[str, Any] = Field(default_factory=dict)
    source: str = "builtin"
    permissions: List[str] = Field(default_factory=list)
    lifecycle: Optional[str] = None
    side_effect: str = "none"


class BlockInstance(BaseModel):
    id: str
    block_type: str
    label: Optional[str] = None
    config: Dict[str, Any] = Field(default_factory=dict)
    code_override: Optional[str] = None
    source: str = "builtin"
    version: str = "1.0.0"
    position: Dict[str, float] = Field(default_factory=dict)


class Edge(BaseModel):
    id: Optional[str] = None
    source: str
    target: str
    source_port: Optional[str] = None
    target_port: Optional[str] = None
    kind: str = "data"


class Graph(BaseModel):
    blocks: List[BlockInstance] = Field(default_factory=list)
    edges: List[Edge] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ProjectCreate(BaseModel):
    name: str = "Untitled Agent"
    description: str = ""
    graph: Graph = Field(default_factory=Graph)


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    graph: Optional[Graph] = None


class RunCreate(BaseModel):
    project_id: str
    revision_id: Optional[str] = None
    input: Any = None
    provider: Optional[str] = None


class EvalAssertion(BaseModel):
    type: str
    value: Any = None


class EvalCase(BaseModel):
    id: Optional[str] = None
    name: str = "case"
    input: Any = None
    expected: Any = None
    assertions: List[EvalAssertion] = Field(default_factory=list)


class EvalSuiteCreate(BaseModel):
    name: str
    description: str = ""
    cases: List[EvalCase] = Field(default_factory=list, max_length=100)


class EvaluationBudgets(BaseModel):
    max_cases: int = Field(default=100, ge=1, le=100)
    max_tokens: int = Field(default=1_000_000, ge=1, le=10_000_000)
    max_wall_seconds: float = Field(default=600, gt=0, le=3600)
    max_cost_usd: float = Field(default=10.0, ge=0, le=1000)


class EvaluationCreate(BaseModel):
    eval_suite_id: str
    baseline_revision_id: str
    candidate_revision_id: str
    provider: Optional[str] = None
    budgets: EvaluationBudgets = Field(default_factory=EvaluationBudgets)


class SecretMetadata(BaseModel):
    provider: str
    configured: bool = False
    storage: str = "session"
    updated_at: Optional[str] = None
    default_model: str = ""


class SecretSet(BaseModel):
    api_key: str
    persist: bool = False


class ProviderSettingsUpdate(BaseModel):
    default_model: str = Field(default="", max_length=200)


BUILTIN_BLOCKS: Dict[str, BlockManifest] = {
    "input": BlockManifest(id="input", type="input", label="Input", ports_out=[Port(name="value")]),
    "output": BlockManifest(id="output", type="output", label="Output", ports_in=[Port(name="value")]),
    "llm": BlockManifest(id="llm", type="llm", label="LLM", ports_in=[Port(name="prompt", required=True)], ports_out=[Port(name="response")], permissions=["llm"]),
    "tool": BlockManifest(id="tool", type="tool", label="Tool", ports_in=[Port(name="input")], ports_out=[Port(name="result")], permissions=["tool"]),
    "react_loop": BlockManifest(id="react_loop", type="control", label="ReAct Loop", ports_in=[Port(name="input")], ports_out=[Port(name="output")]),
    "planner": BlockManifest(id="planner", type="control", label="Planner", ports_in=[Port(name="goal")], ports_out=[Port(name="plan")]),
    "executor": BlockManifest(id="executor", type="agent", label="Executor", ports_in=[Port(name="plan")], ports_out=[Port(name="result")]),
    "router": BlockManifest(id="router", type="control", label="Router", ports_in=[Port(name="input")], ports_out=[Port(name="route")]),
    "supervisor": BlockManifest(id="supervisor", type="agent", label="Supervisor", ports_in=[Port(name="input")], ports_out=[Port(name="result")]),
    "memory": BlockManifest(id="memory", type="memory", label="Memory", ports_in=[Port(name="query")], ports_out=[Port(name="context")]),
    "human_approval": BlockManifest(id="human_approval", type="guardrail", label="Human Approval", ports_in=[Port(name="value")], ports_out=[Port(name="approved")], permissions=["approval"]),
    "harness": BlockManifest(id="harness", type="harness", label="Harness Hook", ports_in=[Port(name="value")], ports_out=[Port(name="value")]),
}


def _node(block_type: str, label: str | None = None) -> BlockInstance:
    return BlockInstance(id=str(uuid.uuid4()), block_type=block_type, label=label)


def _linear(types: List[str]) -> Graph:
    blocks = [BlockInstance(id=f"{index + 1:02d}-{block_type}", block_type=block_type) for index, block_type in enumerate(types)]
    edges = [Edge(source=blocks[i].id, target=blocks[i + 1].id, id=f"edge-{i + 1:02d}") for i in range(len(blocks) - 1)]
    return Graph(blocks=blocks, edges=edges)


def _harness_lab() -> Graph:
    blocks = [BlockInstance(id=f"s{i:02d}", block_type="harness", label=f"s{i:02d}", config={"order": i}) for i in range(1, 21)]
    edges = [Edge(id=f"harness-{i:02d}-{i + 1:02d}", source=blocks[i - 1].id, target=blocks[i].id) for i in range(1, 20)]
    return Graph(blocks=blocks, edges=edges, metadata={"kind": "harness-evolution", "mechanisms": [block.id for block in blocks]})


TEMPLATES = [
    {"id": "tool-use", "name": "Tool Use / Augmented LLM", "description": "Minimal LLM with a tool", "graph": _linear(["input", "llm", "tool", "output"]).model_dump()},
    {"id": "react", "name": "ReAct", "description": "Reason and act loop", "graph": _linear(["input", "react_loop", "llm", "tool", "output"]).model_dump()},
    {"id": "plan-execute", "name": "Plan-and-Execute", "description": "Plan then execute", "graph": _linear(["input", "planner", "executor", "output"]).model_dump()},
    {"id": "router", "name": "Router", "description": "Route requests to agents", "graph": _linear(["input", "router", "llm", "output"]).model_dump()},
    {"id": "supervisor", "name": "Supervisor Multi-Agent", "description": "Supervisor coordinating workers", "graph": _linear(["input", "supervisor", "tool", "output"]).model_dump()},
    {"id": "memory", "name": "Memory-augmented", "description": "Retrieve context before LLM", "graph": _linear(["input", "memory", "llm", "output"]).model_dump()},
    {"id": "harness-lab", "name": "Harness Lab (s01-s20)", "description": "Twenty ordered, composable harness mechanisms", "graph": _harness_lab().model_dump(), "mechanisms": [f"s{i:02d}" for i in range(1, 21)]},
]


class Store:
    def __init__(self) -> None:
        path = os.getenv("RUNNER_DB_PATH", str(Path.home() / ".agentlab" / "runner.db"))
        if path != ":memory:":
            Path(path).expanduser().parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self.conn.execute("PRAGMA foreign_keys=ON")
        if path != ":memory:":
            self.conn.execute("PRAGMA journal_mode=WAL")
        current_version = int(self.conn.execute("PRAGMA user_version").fetchone()[0])
        if current_version > 3:
            raise RuntimeError(f"unsupported runner database version: {current_version}")
        self._migrate()
        self.conn.execute("UPDATE runs SET status='failed', error='runner restarted before completion', completed_at=? WHERE status='running'", (utcnow(),))
        restarted_at = utcnow()
        stale = self.conn.execute("SELECT id FROM evaluations WHERE status IN ('queued','running')").fetchall()
        self.conn.execute("UPDATE evaluations SET status='partial', error='runner restarted before completion', completed_at=? WHERE status IN ('queued','running')", (restarted_at,))
        for row in stale:
            seq = int(self.conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM evaluation_events WHERE evaluation_id=?", (row[0],)).fetchone()[0])
            payload = json.dumps({"id": seq, "evaluation_id": row[0], "type": "evaluation_completed", "status": "partial", "error": "runner restarted before completion", "timestamp": restarted_at})
            self.conn.execute("INSERT OR IGNORE INTO evaluation_events VALUES (?,?,?,?,?)", (row[0], seq, "evaluation_completed", payload, restarted_at))
        self.conn.commit()

    def _columns(self, table: str) -> set[str]:
        return {row[1] for row in self.conn.execute(f"PRAGMA table_info({table})")}

    def _migrate(self) -> None:
        with self.conn:
            self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, description TEXT, created_at TEXT, updated_at TEXT);
            CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, project_id TEXT, graph TEXT, created_at TEXT, message TEXT);
            CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project_id TEXT, revision_id TEXT, status TEXT, input TEXT, output TEXT, error TEXT, created_at TEXT, completed_at TEXT);
            CREATE TABLE IF NOT EXISTS secrets (provider TEXT PRIMARY KEY, configured INTEGER, storage TEXT, updated_at TEXT);
            CREATE TABLE IF NOT EXISTS provider_settings (provider TEXT PRIMARY KEY, default_model TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
            """)
            if "sequence" not in self._columns("revisions"):
                self.conn.execute("ALTER TABLE revisions ADD COLUMN sequence INTEGER")
            if "graph_hash" not in self._columns("revisions"):
                self.conn.execute("ALTER TABLE revisions ADD COLUMN graph_hash TEXT")
            if "metrics" not in self._columns("runs"):
                self.conn.execute("ALTER TABLE runs ADD COLUMN metrics TEXT NOT NULL DEFAULT '{}'")
            self.conn.executescript("""
            CREATE UNIQUE INDEX IF NOT EXISTS revisions_project_sequence ON revisions(project_id, sequence);
            CREATE INDEX IF NOT EXISTS revisions_graph_hash ON revisions(project_id, graph_hash);
            CREATE INDEX IF NOT EXISTS runs_project_created ON runs(project_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS run_events (
              run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
              event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
              PRIMARY KEY(run_id, seq));
            CREATE TABLE IF NOT EXISTS run_spans (
              id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
              node_id TEXT NOT NULL, block_type TEXT, status TEXT NOT NULL, input TEXT, output TEXT,
              error TEXT, metrics TEXT NOT NULL DEFAULT '{}', started_at TEXT, completed_at TEXT);
            CREATE INDEX IF NOT EXISTS run_spans_run ON run_spans(run_id, started_at);
            CREATE TABLE IF NOT EXISTS eval_suites (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', cases TEXT NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS evaluations (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              suite_id TEXT NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
              baseline_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
              candidate_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
              status TEXT NOT NULL, provider TEXT, max_cost_usd REAL NOT NULL, metrics TEXT NOT NULL DEFAULT '{}',
              error TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS evaluation_cases (
              id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
              case_index INTEGER NOT NULL, name TEXT NOT NULL, input TEXT, expected TEXT,
              baseline_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL, candidate_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
              baseline_result TEXT, candidate_result TEXT, status TEXT NOT NULL, error TEXT,
              UNIQUE(evaluation_id, case_index));
            CREATE TABLE IF NOT EXISTS evaluation_events (
              evaluation_id TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
              event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
              PRIMARY KEY(evaluation_id, seq));
            """)
            if "suite_snapshot" not in self._columns("evaluations"):
                self.conn.execute("ALTER TABLE evaluations ADD COLUMN suite_snapshot TEXT")
            if "suite_hash" not in self._columns("evaluations"):
                self.conn.execute("ALTER TABLE evaluations ADD COLUMN suite_hash TEXT")
            if "budgets" not in self._columns("evaluations"):
                self.conn.execute("ALTER TABLE evaluations ADD COLUMN budgets TEXT NOT NULL DEFAULT '{}'")
            if "provider_snapshot" not in self._columns("evaluations"):
                self.conn.execute("ALTER TABLE evaluations ADD COLUMN provider_snapshot TEXT NOT NULL DEFAULT '{}'")
            # Backfill deterministic sequence and canonical graph hash for legacy DBs.
            project_ids = [row[0] for row in self.conn.execute("SELECT id FROM projects")]
            for project_id in project_ids:
                rows = self.conn.execute("SELECT id, graph FROM revisions WHERE project_id=? ORDER BY created_at, rowid", (project_id,)).fetchall()
                for sequence, row in enumerate(rows, 1):
                    try:
                        graph_payload = json.loads(row["graph"])
                    except Exception as exc:
                        raise RuntimeError(f"invalid legacy graph in revision {row['id']}: {exc}") from exc
                    canonical = json.dumps(graph_payload, sort_keys=True, separators=(",", ":"))
                    self.conn.execute("UPDATE revisions SET sequence=?, graph_hash=? WHERE id=?", (sequence, hashlib.sha256(canonical.encode()).hexdigest(), row["id"]))
            self.conn.execute("PRAGMA user_version=3")

    def project(self, pid: str) -> Optional[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()


store = Store()
run_events: Dict[str, List[Dict[str, Any]]] = {}
run_cancel: Dict[str, bool] = {}
run_private_results: Dict[str, Dict[str, Any]] = {}
evaluation_current_runs: Dict[str, List[str]] = {}
evaluation_slots = threading.BoundedSemaphore(1)
session_secrets: Dict[str, str] = {}
KEYRING_SERVICE = "agentlab-runner"
MAX_PYTHON_UPLOAD = 5 * 1024 * 1024
MAX_PROJECT_UPLOAD = 20 * 1024 * 1024
MAX_JSON_BYTES = 5 * 1024 * 1024
MAX_CASE_INPUT_BYTES = 1 * 1024 * 1024

SENSITIVE_KEY_PARTS = ("api_key", "apikey", "secret", "password", "authorization", "access_token", "refresh_token")


def _redact_sensitive(value: Any) -> Any:
    if isinstance(value, dict):
        result: Dict[str, Any] = {}
        for key, item in value.items():
            normalized = str(key).lower().replace("-", "_")
            if normalized == "secret_ref":
                result[str(key)] = item
            else:
                result[str(key)] = "[REDACTED]" if any(part in normalized for part in SENSITIVE_KEY_PARTS) else _redact_sensitive(item)
        return result
    if isinstance(value, (list, tuple)):
        return [_redact_sensitive(item) for item in value]
    if isinstance(value, str) and value.lower().startswith("bearer "):
        return "[REDACTED]"
    return value


def _compact_value(value: Any, max_bytes: int = MAX_JSON_BYTES) -> Any:
    redacted = _redact_sensitive(value)
    encoded = json.dumps(redacted, ensure_ascii=False, default=str)
    size = len(encoded.encode())
    if size <= max_bytes:
        return redacted
    return {"truncated": True, "original_bytes": size, "retained_bytes": 4096, "preview": encoded[:4096]}


def _dump_compact(value: Any, max_bytes: int = MAX_JSON_BYTES) -> str:
    return json.dumps(_compact_value(value, max_bytes), ensure_ascii=False, default=str)


def _sensitive_fixture_paths(value: Any, path: str = "case") -> List[str]:
    found: List[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = str(key).lower().replace("-", "_")
            child_path = f"{path}.{key}"
            if normalized != "secret_ref" and any(part in normalized for part in SENSITIVE_KEY_PARTS):
                found.append(child_path)
            else:
                found.extend(_sensitive_fixture_paths(item, child_path))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(_sensitive_fixture_paths(item, f"{path}[{index}]"))
    elif isinstance(value, str):
        lowered = value.lower()
        if lowered.startswith("bearer ") or any(marker in lowered for marker in ("api_key=", "apikey=", "password=", "authorization:")):
            found.append(path)
    return found

try:
    import socksio as _socksio  # noqa: F401
    _SOCKS_SUPPORTED = True
except ImportError:  # pragma: no cover - optional socks proxy support
    _SOCKS_SUPPORTED = False


def _sanitize_proxy_env() -> None:
    """Normalize or drop proxy env vars whose scheme httpx cannot construct.

    With trust_env on, httpx eagerly builds a transport for every ``*_PROXY`` variable
    and raises "Unknown scheme for proxy URL" if any is unparseable (e.g. a bare
    ``socks://`` from a Clash/mihomo shell profile), which breaks every provider call.
    A bare ``socks://`` is normalized to ``socks5://``; schemes we still cannot use are
    removed so a working ``http(s)://`` proxy keeps applying.
    """
    supported = {"http", "https"} | ({"socks5", "socks5h"} if _SOCKS_SUPPORTED else set())
    for name in ("ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        value = os.environ.get(name)
        if not value:
            continue
        if urlparse(value).scheme.lower() == "socks" and "://" in value:
            value = "socks5://" + value.split("://", 1)[1]
            os.environ[name] = value
        scheme = urlparse(value).scheme.lower()
        if scheme and scheme not in supported:
            os.environ.pop(name, None)
            print(f"[agentlab] ignoring {name}: unsupported proxy scheme {scheme!r}; install 'httpx[socks]' or use an http:// proxy")


_sanitize_proxy_env()

app = FastAPI(title="AgentLab Runner", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> Dict[str, Any]:
    docker = shutil.which("docker") or shutil.which("podman")
    return {"status": "ok", "version": app.version, "safe_runtime": bool(docker), "container_runtime": docker, "isolation": {"network": "disabled-by-default", "root_filesystem": "read-only", "resource_limits": True}}


@app.get("/api/runtime")
def runtime_metadata() -> Dict[str, Any]:
    runtime = shutil.which("docker") or shutil.which("podman")
    return {
        "mode": "container" if runtime else "builtin-simulator-only",
        "runtime": runtime,
        "imported_code_live_execution": bool(runtime),
        "defaults": {"network": "none", "read_only_root": True, "timeout_seconds": 30, "memory_mb": 512, "cpus": 1},
    }


@app.get("/api/pricing")
def provider_pricing() -> Dict[str, Any]:
    return pricing_metadata()


@app.get("/api/templates")
def templates() -> List[Dict[str, Any]]:
    return TEMPLATES


@app.get("/api/blocks")
def blocks() -> List[Dict[str, Any]]:
    return [b.model_dump() for b in BUILTIN_BLOCKS.values()]


def _project_json(row: sqlite3.Row) -> Dict[str, Any]:
    return {"id": row["id"], "name": row["name"], "description": row["description"], "created_at": row["created_at"], "updated_at": row["updated_at"]}


def _graph_hash(graph: Graph) -> str:
    canonical = json.dumps(graph.model_dump(), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _next_revision_sequence(pid: str) -> int:
    return int(store.conn.execute("SELECT COALESCE(MAX(sequence),0)+1 FROM revisions WHERE project_id=?", (pid,)).fetchone()[0])


@app.post("/api/projects")
def create_project(req: ProjectCreate) -> Dict[str, Any]:
    pid, now, rid = str(uuid.uuid4()), utcnow(), str(uuid.uuid4())
    with store.lock:
        store.conn.execute("INSERT INTO projects VALUES (?,?,?,?,?)", (pid, req.name, req.description, now, now))
        store.conn.execute("INSERT INTO revisions(id,project_id,graph,created_at,message,sequence,graph_hash) VALUES (?,?,?,?,?,?,?)", (rid, pid, req.graph.model_dump_json(), now, "initial", 1, _graph_hash(req.graph)))
        store.conn.commit()
    return {"project": {"id": pid, "name": req.name, "description": req.description, "created_at": now, "updated_at": now}, "revision": {"id": rid, "project_id": pid, "graph": req.graph.model_dump(), "created_at": now, "message": "initial", "sequence": 1, "graph_hash": _graph_hash(req.graph)}, "credential_warnings": credential_warnings(req.graph.model_dump())}


@app.get("/api/projects")
def list_projects() -> List[Dict[str, Any]]:
    return [_project_json(r) for r in store.conn.execute("SELECT * FROM projects ORDER BY updated_at DESC")]


@app.get("/api/projects/{pid}")
def get_project(pid: str) -> Dict[str, Any]:
    row = store.project(pid)
    if not row:
        raise HTTPException(404, "project not found")
    rev = store.conn.execute("SELECT * FROM revisions WHERE project_id=? ORDER BY created_at DESC LIMIT 1", (pid,)).fetchone()
    return {"project": _project_json(row), "revision": _revision_json(rev) if rev else None}


def _revision_json(r: sqlite3.Row) -> Dict[str, Any]:
    return {"id": r["id"], "project_id": r["project_id"], "graph": json.loads(r["graph"]), "created_at": r["created_at"], "message": r["message"], "sequence": r["sequence"], "graph_hash": r["graph_hash"]}


@app.patch("/api/projects/{pid}")
def update_project(pid: str, req: ProjectUpdate) -> Dict[str, Any]:
    row = store.project(pid)
    if not row:
        raise HTTPException(404, "project not found")
    name, desc = req.name or row["name"], req.description if req.description is not None else row["description"]
    now = utcnow()
    with store.lock:
        store.conn.execute("UPDATE projects SET name=?, description=?, updated_at=? WHERE id=?", (name, desc, now, pid))
        rid = None
        if req.graph is not None:
            rid = str(uuid.uuid4())
            store.conn.execute("INSERT INTO revisions(id,project_id,graph,created_at,message,sequence,graph_hash) VALUES (?,?,?,?,?,?,?)", (rid, pid, req.graph.model_dump_json(), now, "update", _next_revision_sequence(pid), _graph_hash(req.graph)))
        store.conn.commit()
    result = get_project(pid)
    if req.graph is not None:
        result["credential_warnings"] = credential_warnings(req.graph.model_dump())
    return result


@app.get("/api/projects/{pid}/revisions")
def revisions(pid: str) -> List[Dict[str, Any]]:
    if not store.project(pid):
        raise HTTPException(404, "project not found")
    return [_revision_json(r) for r in store.conn.execute("SELECT * FROM revisions WHERE project_id=? ORDER BY created_at DESC", (pid,))]


@app.post("/api/projects/{pid}/revisions")
def create_revision(pid: str, graph: Graph, message: str = "manual") -> Dict[str, Any]:
    if not store.project(pid):
        raise HTTPException(404, "project not found")
    rid, now = str(uuid.uuid4()), utcnow()
    with store.lock:
        store.conn.execute("INSERT INTO revisions(id,project_id,graph,created_at,message,sequence,graph_hash) VALUES (?,?,?,?,?,?,?)", (rid, pid, graph.model_dump_json(), now, message, _next_revision_sequence(pid), _graph_hash(graph)))
        store.conn.execute("UPDATE projects SET updated_at=? WHERE id=?", (now, pid))
        store.conn.commit()
    payload = _revision_json(store.conn.execute("SELECT * FROM revisions WHERE id=?", (rid,)).fetchone())
    payload["credential_warnings"] = credential_warnings(graph.model_dump())
    return payload


@app.get("/api/projects/{pid}/revisions/{revision_id}")
def get_revision(pid: str, revision_id: str) -> Dict[str, Any]:
    rev = store.conn.execute("SELECT * FROM revisions WHERE id=? AND project_id=?", (revision_id, pid)).fetchone()
    if not rev:
        raise HTTPException(404, "revision not found")
    return _revision_json(rev)


@app.delete("/api/projects/{pid}/revisions/{revision_id}")
def delete_revision(pid: str, revision_id: str) -> Dict[str, Any]:
    if not store.project(pid):
        raise HTTPException(404, "project not found")
    rev = store.conn.execute("SELECT id FROM revisions WHERE id=? AND project_id=?", (revision_id, pid)).fetchone()
    if not rev:
        raise HTTPException(404, "revision not found")
    total = int(store.conn.execute("SELECT COUNT(*) FROM revisions WHERE project_id=?", (pid,)).fetchone()[0])
    if total <= 1:
        raise HTTPException(409, "cannot delete the only revision of a project")
    eval_refs = int(store.conn.execute("SELECT COUNT(*) FROM evaluations WHERE baseline_revision_id=? OR candidate_revision_id=?", (revision_id, revision_id)).fetchone()[0])
    if eval_refs:
        raise HTTPException(409, f"revision is referenced by {eval_refs} A/B evaluation(s); delete those experiments first")
    with store.lock:
        # Runs are disposable observability records; delete them (run_events/run_spans cascade) so the version can be removed.
        store.conn.execute("DELETE FROM runs WHERE revision_id=?", (revision_id,))
        store.conn.execute("DELETE FROM revisions WHERE id=?", (revision_id,))
        store.conn.commit()
    return {"deleted": True, "id": revision_id}


@app.delete("/api/projects/{pid}")
def delete_project(pid: str) -> Dict[str, Any]:
    if not store.project(pid):
        raise HTTPException(404, "project not found")
    active_runs = store.conn.execute("SELECT id FROM runs WHERE project_id=? AND status='running'", (pid,)).fetchall()
    for row in active_runs: run_cancel[row[0]] = True
    active_evaluations = store.conn.execute("SELECT id FROM evaluations WHERE project_id=? AND status IN ('queued','running')", (pid,)).fetchall()
    if active_runs or active_evaluations:
        with store.lock:
            store.conn.execute("UPDATE evaluations SET cancel_requested=1 WHERE project_id=? AND status IN ('queued','running')", (pid,))
            store.conn.commit()
        raise HTTPException(409, "active runs or evaluations are cancelling; retry deletion after they stop")
    with store.lock:
        store.conn.execute("DELETE FROM revisions WHERE project_id=?", (pid,))
        store.conn.execute("DELETE FROM runs WHERE project_id=?", (pid,))
        store.conn.execute("DELETE FROM projects WHERE id=?", (pid,))
        store.conn.commit()
    return {"deleted": True, "id": pid}


@app.post("/api/validate")
def validate_graph(graph: Graph) -> Dict[str, Any]:
    errors: List[str] = []
    warnings: List[str] = []
    ids = {b.id for b in graph.blocks}
    if len(ids) != len(graph.blocks):
        errors.append("duplicate block ids")
    for e in graph.edges:
        if e.source not in ids or e.target not in ids:
            errors.append(f"edge references unknown block: {e.source}->{e.target}")
            continue
        source = next(b for b in graph.blocks if b.id == e.source)
        target = next(b for b in graph.blocks if b.id == e.target)
        source_manifest = BUILTIN_BLOCKS.get(source.block_type)
        target_manifest = BUILTIN_BLOCKS.get(target.block_type)
        if e.source_port and source.block_type == "router":
            # Router source ports are route labels (config-driven), not fixed manifest ports.
            routes = source.config.get("routes")
            allowed = {str(route) for route in routes} if isinstance(routes, list) else set()
            allowed.add(str(source.config.get("default_route", "default")))
            if e.source_port not in allowed:
                warnings.append(f"router {source.id} routes a connection to '{e.source_port}', which is not in its routes")
        elif e.source_port and source_manifest and e.source_port not in {p.name for p in source_manifest.ports_out}:
            errors.append(f"unknown output port {e.source_port} on {source.id}")
        if e.target_port and target_manifest and e.target_port not in {p.name for p in target_manifest.ports_in}:
            errors.append(f"unknown input port {e.target_port} on {target.id}")
    # detect cycles among ordinary data edges
    adj = {i: [] for i in ids}
    for e in graph.edges:
        if e.kind == "data" and e.source in ids and e.target in ids:
            adj[e.source].append(e.target)
    visiting, visited = set(), set()
    def dfs(n: str) -> None:
        if n in visiting: errors.append("graph contains cycle; use explicit loop block"); return
        if n in visited: return
        visiting.add(n)
        for m in adj[n]: dfs(m)
        visiting.remove(n); visited.add(n)
    for n in ids: dfs(n)
    for b in graph.blocks:
        if b.block_type not in BUILTIN_BLOCKS and not b.source.startswith("custom:"):
            errors.append(f"unknown block type: {b.block_type}")
        if b.block_type == "react_loop":
            try:
                max_steps = int(b.config.get("max_steps", 8))
                if not 1 <= max_steps <= 50:
                    errors.append(f"loop {b.id} max_steps must be between 1 and 50")
            except (TypeError, ValueError):
                errors.append(f"loop {b.id} max_steps must be an integer")
        if b.source.startswith("custom:") and not b.code_override:
            errors.append(f"custom block {b.id} has no code snapshot")
    if graph.blocks and not any(b.block_type == "input" for b in graph.blocks):
        warnings.append("graph has no explicit Input block")
    if graph.blocks and not any(b.block_type == "output" for b in graph.blocks):
        warnings.append("graph has no explicit Output block")
    return {"valid": not errors, "errors": list(dict.fromkeys(errors)), "warnings": warnings, "safe_runtime": bool(shutil.which("docker") or shutil.which("podman"))}


def _execution_order(graph: Graph) -> List[BlockInstance]:
    by_id = {block.id: block for block in graph.blocks}
    incoming = {block.id: 0 for block in graph.blocks}
    outgoing: Dict[str, List[str]] = {block.id: [] for block in graph.blocks}
    for edge in graph.edges:
        if edge.kind == "data" and edge.source in by_id and edge.target in by_id:
            incoming[edge.target] += 1
            outgoing[edge.source].append(edge.target)
    ready = [block.id for block in graph.blocks if incoming[block.id] == 0]
    ordered: List[BlockInstance] = []
    while ready:
        node_id = ready.pop(0)
        ordered.append(by_id[node_id])
        for target in outgoing[node_id]:
            incoming[target] -= 1
            if incoming[target] == 0:
                ready.append(target)
    return ordered


def _secret_for(provider: str) -> Optional[str]:
    if provider in session_secrets:
        return session_secrets[provider]
    if keyring is not None:
        try:
            return keyring.get_password(KEYRING_SERVICE, provider)
        except Exception:
            return None
    return None


def _provider_default_models() -> Dict[str, str]:
    return {str(row["provider"]): str(row["default_model"]) for row in store.conn.execute("SELECT provider,default_model FROM provider_settings") if str(row["default_model"]).strip()}


def _text_value(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("message", "prompt", "text", "value"):
            if key in value:
                return str(value[key])
    return json.dumps(value, ensure_ascii=False)


def _validated_compatible_base_url(value: Any) -> str:
    base_url = str(value or "").rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError("OpenAI-compatible provider requires a valid base_url")
    # Open by default so users can point at any OpenAI-compatible endpoint (DeepSeek,
    # local models, gateways) without a runner restart. Setting the env allowlist turns
    # it into a hard lockdown (opt-in): when configured, only those hosts are permitted.
    # With no allowlist, any valid http(s) base_url is accepted, which means a graph's
    # LLM node can send the stored openai-compatible key to whatever host it names. This
    # is a deliberate tradeoff for a loopback-only, single-user dev tool; operators who
    # run graphs from untrusted sources should set AGENTLAB_OPENAI_COMPATIBLE_ALLOWLIST.
    configured = {host.strip().lower() for host in os.getenv("AGENTLAB_OPENAI_COMPATIBLE_ALLOWLIST", "").split(",") if host.strip()}
    if configured and parsed.hostname.lower() not in configured:
        raise RuntimeError("OpenAI-compatible host is not allow-listed by the local runner")
    return base_url


def _resolve_llm_target(block: BlockInstance, run_provider: Optional[str], provider_models: Optional[Dict[str, str]]) -> Optional[tuple[str, str, str]]:
    """Resolve (provider, model, api_key) for a block, or None when no provider is configured.

    Returning None lets control blocks fall back to their deterministic behavior so the
    simulator experience is unchanged. A configured provider with a missing secret or model
    is an explicit error.
    """
    selected = str(block.config.get("provider") or run_provider or "").strip()
    if not selected:
        return None
    api_key = _secret_for(selected)
    if not api_key:
        raise RuntimeError(f"provider secret is not configured: {selected}")
    model = str(block.config.get("model") or (provider_models or {}).get(selected) or "").strip()
    if not model:
        raise RuntimeError(f"block {block.id} requires a model when using {selected}")
    return selected, model, api_key


def _provider_chat(selected: str, model: str, api_key: str, prompt: str, *, base_url_cfg: Any = None, temperature: float = 0.0, max_output_tokens: int = 1024, cost_guard: Optional[CostBudgetGuard] = None) -> tuple[str, Dict[str, Any]]:
    """Call a provider once and return (text, metrics). Shared by the LLM block and LLM-backed control blocks."""
    if max_output_tokens < 1 or max_output_tokens > 100_000:
        raise RuntimeError("max_tokens must be between 1 and 100000")
    price = get_model_price(str(selected), model)
    reservation = None
    # Priced models get a hard worst-case USD reservation before the call. Unpriced models
    # (e.g. openai-compatible endpoints) run without a reservation; the evaluation's
    # token/case/wall-time budgets bound spend and cost is reported as unavailable.
    if cost_guard is not None and price is not None:
        reservation = cost_guard.reserve(price, conservative_input_token_limit(prompt), max_output_tokens)
    try:
        if selected == "anthropic":
            response = httpx.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                json={"model": model, "max_tokens": max_output_tokens, "messages": [{"role": "user", "content": prompt}]},
                timeout=30,
            )
            response.raise_for_status()
            payload = response.json()
            text = "".join(item.get("text", "") for item in payload.get("content", []) if item.get("type") == "text")
            usage = payload.get("usage", {})
            input_tokens = int(usage.get("input_tokens", 0))
            output_tokens = int(usage.get("output_tokens", 0))
            cached_input_tokens = 0
            cached_usage_available = True
        else:
            base_url = _validated_compatible_base_url(base_url_cfg) if selected == "openai-compatible" else "https://api.openai.com/v1"
            response = httpx.post(
                str(base_url).rstrip("/") + "/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={"model": model, "messages": [{"role": "user", "content": prompt}], "temperature": float(temperature), "max_tokens": max_output_tokens},
                timeout=30,
            )
            response.raise_for_status()
            payload = response.json()
            text = payload["choices"][0]["message"].get("content", "")
            usage = payload.get("usage", {})
            input_tokens = int(usage.get("prompt_tokens", 0))
            output_tokens = int(usage.get("completion_tokens", 0))
            prompt_details = usage.get("prompt_tokens_details")
            cached_usage_available = isinstance(prompt_details, dict) and "cached_tokens" in prompt_details
            cached_input_tokens = int(prompt_details.get("cached_tokens", 0)) if isinstance(prompt_details, dict) else 0
    except Exception:
        if reservation is not None:
            cost_guard.settle(reservation, None)
        raise
    usage_available = input_tokens > 0 or output_tokens > 0
    actual_cost = price.cost(input_tokens, output_tokens, cached_input_tokens) if price is not None and usage_available else None
    cost_estimate = "actual_usage" if cached_usage_available else "usage_upper_bound"
    if reservation is not None:
        actual_cost = cost_guard.settle(reservation, actual_cost)
        if not usage_available:
            cost_estimate = "reserved_upper_bound"
    metrics: Dict[str, Any] = {
        "provider": selected,
        "model": model,
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_input_tokens,
        "output_tokens": output_tokens,
        "tokens": input_tokens + output_tokens,
        "cost_usd": actual_cost,
    }
    if price is not None:
        metrics["pricing_version"] = price.registry_version
        metrics["cost_estimate"] = cost_estimate
    return text, metrics


def _call_llm(block: BlockInstance, value: Any, provider: Optional[str], cost_guard: Optional[CostBudgetGuard] = None, provider_models: Optional[Dict[str, str]] = None) -> tuple[Any, Dict[str, Any]]:
    target = _resolve_llm_target(block, provider, provider_models)
    if target is None:
        return {"text": f"simulated response to {_text_value(value)}", "simulated": True}, {"provider": "simulator", "input_tokens": 0, "output_tokens": 0, "tokens": 0, "cost_usd": 0}
    selected, model, api_key = target
    max_output_tokens = int(block.config.get("max_tokens", 1024))
    if max_output_tokens < 1 or max_output_tokens > 100_000:
        raise RuntimeError(f"LLM block {block.id} max_tokens must be between 1 and 100000")
    text, metrics = _provider_chat(selected, model, api_key, _text_value(value), base_url_cfg=block.config.get("base_url"), temperature=float(block.config.get("temperature", 0)), max_output_tokens=max_output_tokens, cost_guard=cost_guard)
    return {"text": text, "provider": selected, "model": model}, metrics


def _control_block_prompt_config(block: BlockInstance) -> tuple[Any, float]:
    return block.config.get("base_url"), float(block.config.get("temperature", 0))


def _run_planner(block: BlockInstance, value: Any, provider: Optional[str], cost_guard: Optional[CostBudgetGuard], provider_models: Optional[Dict[str, str]]) -> tuple[Dict[str, Any], Dict[str, Any]]:
    goal = _text_value(value)
    target = _resolve_llm_target(block, provider, provider_models)
    if target is None:
        return {"steps": ["inspect input", "execute action"], "goal": value}, {}
    selected, model, api_key = target
    base_url_cfg, temperature = _control_block_prompt_config(block)
    prompt = f"You are a planning module. Break the goal below into a short ordered plan. Output one concise step per line, no preamble, no numbering.\n\nGoal: {goal}"
    text, metrics = _provider_chat(selected, model, api_key, prompt, base_url_cfg=base_url_cfg, temperature=temperature, max_output_tokens=int(block.config.get("max_tokens", 512)), cost_guard=cost_guard)
    steps = [line.strip().lstrip("-*0123456789. ").strip() for line in text.splitlines() if line.strip()]
    return {"steps": steps or [text.strip()], "goal": goal, "provider": selected, "model": model}, metrics


def _run_router(block: BlockInstance, value: Any, provider: Optional[str], cost_guard: Optional[CostBudgetGuard], provider_models: Optional[Dict[str, str]]) -> tuple[Dict[str, Any], Dict[str, Any]]:
    request = _text_value(value)
    routes = block.config.get("routes")
    if not isinstance(routes, list) or not routes:
        routes = [str(block.config.get("default_route", "default"))]
    routes = [str(route) for route in routes]
    target = _resolve_llm_target(block, provider, provider_models)
    if target is None:
        return {"route": str(block.config.get("default_route", routes[0])), "input": value}, {}
    selected, model, api_key = target
    base_url_cfg, temperature = _control_block_prompt_config(block)
    prompt = f"Classify the request into exactly one of these routes: {routes}. Reply with only the route label, nothing else.\n\nRequest: {request}"
    text, metrics = _provider_chat(selected, model, api_key, prompt, base_url_cfg=base_url_cfg, temperature=temperature, max_output_tokens=int(block.config.get("max_tokens", 32)), cost_guard=cost_guard)
    answer = text.strip().lower()
    chosen = next((route for route in routes if route.lower() == answer), None) or next((route for route in routes if route.lower() in answer), None) or str(block.config.get("default_route", routes[0]))
    return {"route": chosen, "input": request, "provider": selected, "model": model}, metrics


def _run_supervisor(block: BlockInstance, value: Any, provider: Optional[str], cost_guard: Optional[CostBudgetGuard], provider_models: Optional[Dict[str, str]]) -> tuple[Dict[str, Any], Dict[str, Any]]:
    request = _text_value(value)
    workers = int(block.config.get("workers", 2))
    target = _resolve_llm_target(block, provider, provider_models)
    if target is None:
        return {"request": value, "workers": workers, "coordination": "supervised"}, {}
    selected, model, api_key = target
    base_url_cfg, temperature = _control_block_prompt_config(block)
    prompt = f"You are a supervisor coordinating {workers} specialist workers. Produce a single coordinated answer to the request.\n\nRequest: {request}"
    text, metrics = _provider_chat(selected, model, api_key, prompt, base_url_cfg=base_url_cfg, temperature=temperature, max_output_tokens=int(block.config.get("max_tokens", 1024)), cost_guard=cost_guard)
    return {"answer": text, "request": request, "workers": workers, "coordination": "supervised", "provider": selected, "model": model}, metrics


def _run_react(block: BlockInstance, value: Any, provider: Optional[str], cost_guard: Optional[CostBudgetGuard], provider_models: Optional[Dict[str, str]]) -> tuple[Dict[str, Any], Dict[str, Any]]:
    request = _text_value(value)
    try:
        max_steps = int(block.config.get("max_steps", 8))
    except (TypeError, ValueError):
        max_steps = 8
    max_steps = max(1, min(max_steps, 50))
    target = _resolve_llm_target(block, provider, provider_models)
    if target is None:
        return {"answer": request, "iterations": min(max_steps, 1), "bounded": True}, {}
    selected, model, api_key = target
    base_url_cfg, temperature = _control_block_prompt_config(block)
    step_tokens = int(block.config.get("max_tokens", 512))
    totals: Dict[str, Any] = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0, "tokens": 0, "cost_usd": 0.0}
    pricing_version: Any = None
    scratch = ""
    answer = ""
    iterations = 0
    # No real tools yet, so the loop is bounded reasoning: the model may take one step at a
    # time and signals completion with a FINAL: line. iterations reflects the real call count.
    for _ in range(max_steps):
        iterations += 1
        prompt = f"You are solving a task by reasoning step by step. Take at most one more reasoning step, then, once you have the answer, output a line starting with 'FINAL:' followed by the answer.\n\nTask: {request}\nReasoning so far: {scratch or '(none)'}"
        text, metrics = _provider_chat(selected, model, api_key, prompt, base_url_cfg=base_url_cfg, temperature=temperature, max_output_tokens=step_tokens, cost_guard=cost_guard)
        for key in ("input_tokens", "cached_input_tokens", "output_tokens", "tokens"):
            totals[key] += int(metrics.get(key) or 0)
        if metrics.get("cost_usd") is None:
            totals["cost_usd"] = None
        elif totals["cost_usd"] is not None:
            totals["cost_usd"] += float(metrics.get("cost_usd") or 0)
        if metrics.get("pricing_version"):
            pricing_version = metrics["pricing_version"]
        scratch = text
        if "FINAL:" in text:
            answer = text.split("FINAL:", 1)[1].strip()
            break
    if not answer:
        answer = scratch.strip()
    node_metrics: Dict[str, Any] = {"provider": selected, "model": model, **totals}
    if pricing_version:
        node_metrics["pricing_version"] = pricing_version
    return {"answer": answer, "iterations": iterations, "bounded": True, "max_steps": max_steps, "provider": selected, "model": model}, node_metrics


def _run_process_capped(command: List[str], payload: str, timeout: int, max_output: int = 1_000_000) -> tuple[int, str, str]:
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdin and process.stdout and process.stderr
    deadline = time.monotonic() + timeout
    def write_stdin() -> None:
        try:
            process.stdin.write(payload.encode())
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass
    writer = threading.Thread(target=write_stdin, daemon=True)
    writer.start()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    chunks: Dict[str, bytearray] = {"stdout": bytearray(), "stderr": bytearray()}
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                raise TimeoutError(f"custom block exceeded {timeout}s timeout")
            for key, _ in selector.select(timeout=0.1):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                target = chunks[key.data]
                target.extend(data)
                if len(chunks["stdout"]) + len(chunks["stderr"]) > max_output:
                    raise RuntimeError("custom block output exceeded 1 MiB limit")
        return process.wait(timeout=max(0.1, deadline - time.monotonic())), chunks["stdout"].decode(errors="replace"), chunks["stderr"].decode(errors="replace")
    except Exception:
        process.kill()
        process.wait(timeout=5)
        raise
    finally:
        selector.close()


def _run_custom_block(block: BlockInstance, value: Any) -> Any:
    runtime = shutil.which("docker") or shutil.which("podman")
    if not runtime:
        raise RuntimeError("Imported code requires Docker or Podman")
    if not block.code_override:
        raise RuntimeError("Custom block has no code snapshot")
    entrypoint = block.config.get("entrypoint") or ("execute" if block.code_override else None)
    if not entrypoint:
        raise RuntimeError("Custom block requires config.entrypoint")
    invoke = '''import asyncio, importlib.util, inspect, json, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("user_block", "/workspace/user_block.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
target = getattr(module, sys.argv[1])
envelope = json.load(sys.stdin)
payload, config = envelope.get("inputs"), envelope.get("config", {})
if inspect.isclass(target):
    instance = target()
    target = getattr(instance, "execute", getattr(instance, "run", None))
    if target is None: raise TypeError("class must expose execute() or run()")
signature = inspect.signature(target)

class Trace:
    def emit(self, *args, **kwargs): return None
class State:
    def snapshot(self): return payload
    async def compact(self): return None
class LLM:
    async def chat(self, prompt, **kwargs): return f"simulated response to {prompt}"
    async def classify(self, value, routes): return routes[0] if routes else "default"
class Memory:
    async def search(self, query, limit=5): return []
class DisabledConnector:
    async def request(self, *args, **kwargs): raise RuntimeError("network is disabled in custom block containers")
    async def call(self, *args, **kwargs): raise RuntimeError("MCP is unavailable inside custom block containers")
class Approval:
    async def request(self, proposal): return False
class Policy:
    def check(self, value, policy): return None

context = SimpleNamespace(trace=Trace(), state=State(), llm=LLM(), memory=Memory(), http=DisabledConnector(), mcp=DisabledConnector(), approval=Approval(), policy=Policy(), tokens=0)
async def evaluate(value, config): return 1.0
async def supervise(request, agents): return f"supervised: {request}"
async def execute_plan(plan, tools): return plan
context.evaluate, context.supervise, context.execute_plan = evaluate, supervise, execute_plan

parameters = list(signature.parameters)
inputs = dict(payload) if isinstance(payload, dict) else {"value": payload, "request": payload, "prompt": payload}
fallback = inputs.get("message", inputs.get("text", inputs.get("value", payload)))
inputs.setdefault("value", fallback); inputs.setdefault("request", fallback); inputs.setdefault("prompt", fallback)
if parameters[:3] == ["context", "inputs", "config"]: result = target(context, inputs, config)
elif len(parameters) == 0: result = target()
elif isinstance(payload, dict) and len(parameters) > 1: result = target(**payload)
else: result = target(payload)
if inspect.isawaitable(result): result = asyncio.run(result)
json.dump(result, sys.stdout, default=str)
'''
    with tempfile.TemporaryDirectory(prefix="agentlab-") as tmp:
        root = Path(tmp)
        (root / "user_block.py").write_text(block.code_override, encoding="utf-8")
        (root / "invoke.py").write_text(invoke, encoding="utf-8")
        root.chmod(0o755)
        (root / "user_block.py").chmod(0o444)
        (root / "invoke.py").chmod(0o444)
        container_name = f"agentlab-{uuid.uuid4().hex[:20]}"
        command = [runtime, "run", "--name", container_name, "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "-e", "PYTHONDONTWRITEBYTECODE=1", "-i", "-v", f"{root}:/workspace:ro", "python:3.12-slim", "python", "/workspace/invoke.py", str(entrypoint)]
        payload = json.dumps({"inputs": value, "config": block.config})
        if len(payload.encode()) > 5 * 1024 * 1024:
            raise RuntimeError("custom block input exceeds 5 MiB limit")
        try:
            returncode, stdout, stderr = _run_process_capped(command, payload, int(block.config.get("timeout_seconds", 30)))
        except Exception:
            subprocess.run([runtime, "rm", "-f", container_name], capture_output=True, timeout=10, check=False)
            raise
    if returncode != 0:
        raise RuntimeError((stderr or stdout or "custom block failed")[-4000:])
    return json.loads(stdout or "null")


def _run_worker(run_id: str, graph: Graph, inp: Any, provider: Optional[str], cost_guard: Optional[CostBudgetGuard] = None, provider_models: Optional[Dict[str, str]] = None) -> None:
    run_started = time.perf_counter()
    events = run_events[run_id]
    def emit(kind: str, **kwargs: Any) -> None:
        event = {"run_id": run_id, "type": kind, "timestamp": utcnow()}
        compact_kwargs = _compact_value(kwargs)
        if isinstance(compact_kwargs, dict) and not compact_kwargs.get("truncated"):
            event.update(compact_kwargs)
        else:
            event.update({"payload": compact_kwargs, "truncated": True})
        with store.lock:
            seq = int(store.conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM run_events WHERE run_id=?", (run_id,)).fetchone()[0])
            event["id"] = seq
            events.append(event)
            store.conn.execute("INSERT OR REPLACE INTO run_events(run_id,seq,event_type,payload,created_at) VALUES (?,?,?,?,?)", (run_id, seq, kind, json.dumps(event), event["timestamp"]))
            if kind == "node_started":
                store.conn.execute("INSERT OR REPLACE INTO run_spans(id,run_id,node_id,block_type,status,input,started_at) VALUES (?,?,?,?,?,?,?)", (f"{run_id}:{kwargs.get('node_id')}", run_id, kwargs.get("node_id"), kwargs.get("block_type"), "running", _dump_compact(kwargs.get("input")), event["timestamp"]))
            elif kind == "node_skipped":
                store.conn.execute("INSERT OR REPLACE INTO run_spans(id,run_id,node_id,block_type,status,started_at,completed_at) VALUES (?,?,?,?,?,?,?)", (f"{run_id}:{kwargs.get('node_id')}", run_id, kwargs.get("node_id"), kwargs.get("block_type"), "skipped", event["timestamp"], event["timestamp"]))
            elif kind in ("node_completed", "node_error"):
                store.conn.execute("UPDATE run_spans SET status=?, output=?, error=?, metrics=?, completed_at=? WHERE id=?", ("completed" if kind == "node_completed" else "failed", _dump_compact(kwargs.get("output")), str(kwargs.get("error"))[:4000] if kwargs.get("error") else None, _dump_compact(kwargs.get("metrics") or {}), event["timestamp"], f"{run_id}:{kwargs.get('node_id')}"))
            store.conn.commit()
    emit("run_started", status="running", input=inp)
    node_values: Dict[str, Any] = {}
    # Data edges indexed for conditional-branch gating. A Router activates only the outgoing
    # edges whose source_port matches its chosen route (unlabeled edges stay unconditional),
    # so downstream nodes reachable only through inactive edges are skipped. With no routed
    # edges the whole graph runs exactly as before.
    node_ids = {block.id for block in graph.blocks}
    indexed_edges = [(index, edge) for index, edge in enumerate(graph.edges) if edge.kind == "data" and edge.source in node_ids and edge.target in node_ids]
    out_edges: Dict[str, List[tuple[int, Edge]]] = {block.id: [] for block in graph.blocks}
    in_edges: Dict[str, List[tuple[int, Edge]]] = {block.id: [] for block in graph.blocks}
    for index, edge in indexed_edges:
        out_edges[edge.source].append((index, edge))
        in_edges[edge.target].append((index, edge))
    skipped: set[str] = set()
    active_edge_ids: set[int] = set()
    final_value = inp
    total_tokens = 0
    total_input_tokens = 0
    total_cached_input_tokens = 0
    total_output_tokens = 0
    total_cost: Optional[float] = 0.0
    pricing_versions: set[str] = set()
    for block in _execution_order(graph):
        if run_cancel.get(run_id):
            emit("run_cancelled", status="cancelled"); _finish_run(run_id, "cancelled", None, "cancelled"); return
        incoming = in_edges.get(block.id, [])
        if incoming and not any(edge.source not in skipped and index in active_edge_ids for index, edge in incoming):
            skipped.add(block.id)
            emit("node_skipped", node_id=block.id, block_type=block.block_type)
            continue
        active_parents = [edge.source for index, edge in incoming if edge.source not in skipped and index in active_edge_ids]
        value = inp if not active_parents else node_values.get(active_parents[0]) if len(active_parents) == 1 else {parent: node_values.get(parent) for parent in active_parents}
        started = time.perf_counter()
        emit("node_started", node_id=block.id, block_type=block.block_type, input=value)
        try:
            metrics: Dict[str, Any] = {}
            if block.code_override:
                result = _run_custom_block(block, value)
            elif block.block_type == "llm":
                result, metrics = _call_llm(block, value, provider, cost_guard, provider_models)
            elif block.block_type == "tool": result = {"tool_result": value, "tool": block.config.get("tool", "mock")}
            elif block.block_type == "planner":
                result, metrics = _run_planner(block, value, provider, cost_guard, provider_models)
            elif block.block_type == "executor": result = {"executed": value, "status": "completed"}
            elif block.block_type == "react_loop":
                result, metrics = _run_react(block, value, provider, cost_guard, provider_models)
            elif block.block_type == "memory": result = {"context": block.config.get("seed", []), "query": value}
            elif block.block_type == "router":
                result, metrics = _run_router(block, value, provider, cost_guard, provider_models)
            elif block.block_type == "supervisor":
                result, metrics = _run_supervisor(block, value, provider, cost_guard, provider_models)
            elif block.block_type == "human_approval": result = {"proposal": value, "approved": bool(block.config.get("auto_approve", False))}
            elif block.block_type == "harness": result = {"value": value, "mechanism": block.label or block.config.get("__manifest_id", "harness")}
            else: result = value
            outs = out_edges.get(block.id, [])
            routed = block.block_type == "router" and isinstance(result, dict) and result.get("route") is not None and any(edge.source_port for _, edge in outs)
            chosen_route = str(result.get("route")) if routed else None
            for index, edge in outs:
                if not routed or not edge.source_port or str(edge.source_port) == chosen_route:
                    active_edge_ids.add(index)
            if metrics:
                total_tokens += int(metrics.get("tokens") or 0)
                total_input_tokens += int(metrics.get("input_tokens") or 0)
                total_cached_input_tokens += int(metrics.get("cached_input_tokens") or 0)
                total_output_tokens += int(metrics.get("output_tokens") or 0)
                if metrics.get("pricing_version"):
                    pricing_versions.add(str(metrics["pricing_version"]))
                if metrics.get("cost_usd") is None: total_cost = None
                elif total_cost is not None: total_cost += float(metrics["cost_usd"])
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            node_values[block.id] = result
            final_value = result
            emit("node_completed", node_id=block.id, output=result, metrics={**metrics, "duration_ms": elapsed_ms})
        except Exception as exc:
            emit("node_error", node_id=block.id, error=str(exc))
            _finish_run(run_id, "failed", None, str(exc))
            return
    completion_metrics: Dict[str, Any] = {"tokens": total_tokens, "input_tokens": total_input_tokens, "cached_input_tokens": total_cached_input_tokens, "output_tokens": total_output_tokens}
    if pricing_versions:
        completion_metrics["pricing_version"] = sorted(pricing_versions)[0] if len(pricing_versions) == 1 else sorted(pricing_versions)
    run_metrics: Dict[str, Any] = {**completion_metrics, "duration_ms": round((time.perf_counter() - run_started) * 1000, 2)}
    if total_cost is not None: run_metrics["cost_usd"] = total_cost
    emit("run_completed", status="completed", output=final_value, metrics=run_metrics)
    _finish_run(run_id, "completed", final_value, None, run_metrics)


def _finish_run(run_id: str, status: str, output: Any, error: Optional[str], metrics: Optional[Dict[str, Any]] = None) -> None:
    run_private_results[run_id] = {"output": output, "metrics": metrics or {}}
    with store.lock:
        store.conn.execute("UPDATE runs SET status=?, output=?, error=?, metrics=?, completed_at=? WHERE id=?", (status, _dump_compact(output), str(error)[:4000] if error else None, _dump_compact(metrics or {}), utcnow(), run_id)); store.conn.commit()
    def cleanup() -> None:
        run_events.pop(run_id, None)
        run_cancel.pop(run_id, None)
        run_private_results.pop(run_id, None)
    timer = threading.Timer(300, cleanup)
    timer.daemon = True
    timer.start()


def _create_run(req: RunCreate, cost_guard: Optional[CostBudgetGuard] = None, provider_models: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    prow = store.project(req.project_id)
    if not prow: raise HTTPException(404, "project not found")
    rev = store.conn.execute("SELECT * FROM revisions WHERE id=? AND project_id=?", (req.revision_id, req.project_id)).fetchone() if req.revision_id else store.conn.execute("SELECT * FROM revisions WHERE project_id=? ORDER BY created_at DESC LIMIT 1", (req.project_id,)).fetchone()
    if not rev: raise HTTPException(400, "project has no revision")
    graph = Graph.model_validate(json.loads(rev["graph"]))
    val = validate_graph(graph)
    if not val["valid"]: raise HTTPException(400, detail=val)
    rid, now = str(uuid.uuid4()), utcnow()
    with store.lock:
        store.conn.execute("INSERT INTO runs(id,project_id,revision_id,status,input,output,error,created_at,completed_at,metrics) VALUES (?,?,?,?,?,?,?,?,?,?)", (rid, req.project_id, rev["id"], "running", _dump_compact(req.input), None, None, now, None, "{}")); store.conn.commit()
    run_events[rid] = []; run_cancel[rid] = False
    resolved_provider_models = dict(provider_models) if provider_models is not None else _provider_default_models()
    threading.Thread(target=_run_worker, args=(rid, graph, req.input, req.provider, cost_guard, resolved_provider_models), daemon=True).start()
    return {"id": rid, "project_id": req.project_id, "revision_id": rev["id"], "status": "running", "created_at": now}


@app.post("/api/runs")
def create_run(req: RunCreate) -> Dict[str, Any]:
    return _create_run(req)


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> Dict[str, Any]:
    r = store.conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    if not r: raise HTTPException(404, "run not found")
    spans = [dict(s) for s in store.conn.execute("SELECT * FROM run_spans WHERE run_id=? ORDER BY started_at", (run_id,))]
    for span in spans:
        for key in ("input", "output", "metrics"): span[key] = json.loads(span[key]) if span.get(key) else ({} if key == "metrics" else None)
    return {"id": r["id"], "project_id": r["project_id"], "revision_id": r["revision_id"], "status": r["status"], "input": json.loads(r["input"] or "null"), "output": json.loads(r["output"] or "null"), "error": r["error"], "metrics": json.loads(r["metrics"] or "{}"), "spans": spans, "created_at": r["created_at"], "completed_at": r["completed_at"]}


@app.get("/api/projects/{pid}/runs")
def project_runs(pid: str, revision_id: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
    if not store.project(pid):
        raise HTTPException(404, "project not found")
    limit = max(1, min(limit, 500))
    if revision_id:
        rows = store.conn.execute("SELECT runs.*, revisions.sequence AS revision_sequence FROM runs JOIN revisions ON revisions.id=runs.revision_id WHERE runs.project_id=? AND runs.revision_id=? ORDER BY runs.created_at DESC LIMIT ?", (pid, revision_id, limit)).fetchall()
    else:
        rows = store.conn.execute("SELECT runs.*, revisions.sequence AS revision_sequence FROM runs JOIN revisions ON revisions.id=runs.revision_id WHERE runs.project_id=? ORDER BY runs.created_at DESC LIMIT ?", (pid, limit)).fetchall()
    def compact(raw: Optional[str]) -> Any:
        value = json.loads(raw or "null")
        encoded = json.dumps(value, ensure_ascii=False)
        return value if len(encoded.encode()) <= MAX_JSON_BYTES else {"truncated": True, "preview": encoded[:4096]}
    return [{"id": row["id"], "project_id": row["project_id"], "revision_id": row["revision_id"], "revision_sequence": row["revision_sequence"], "status": row["status"], "input": compact(row["input"]), "output": compact(row["output"]), "metrics": json.loads(row["metrics"] or "{}"), "error": row["error"], "created_at": row["created_at"], "completed_at": row["completed_at"]} for row in rows]


def _suite_json(row: sqlite3.Row) -> Dict[str, Any]:
    return {"id": row["id"], "project_id": row["project_id"], "name": row["name"], "description": row["description"], "cases": _redact_sensitive(json.loads(row["cases"])), "created_at": row["created_at"], "updated_at": row["updated_at"]}


@app.post("/api/projects/{pid}/eval-suites")
def create_eval_suite(pid: str, req: EvalSuiteCreate) -> Dict[str, Any]:
    if not store.project(pid):
        raise HTTPException(404, "project not found")
    sid, now = str(uuid.uuid4()), utcnow()
    cases = [case.model_dump() | {"id": case.id or str(uuid.uuid4())} for case in req.cases]
    if len(json.dumps(cases).encode()) > MAX_JSON_BYTES: raise HTTPException(413, "evaluation suite exceeds 5 MiB")
    if any(len(json.dumps(case.get("input")).encode()) > MAX_CASE_INPUT_BYTES for case in cases): raise HTTPException(413, "evaluation case input exceeds 1 MiB")
    sensitive_paths = _sensitive_fixture_paths(cases)
    if sensitive_paths: raise HTTPException(422, f"evaluation suites cannot store credentials; use secret_ref instead: {', '.join(sensitive_paths[:5])}")
    invalid_assertions = assertion_problems(cases)
    if invalid_assertions: raise HTTPException(422, f"invalid assertions: {'; '.join(invalid_assertions[:5])}")
    with store.lock:
        store.conn.execute("INSERT INTO eval_suites VALUES (?,?,?,?,?,?,?)", (sid, pid, req.name, req.description, json.dumps(cases), now, now)); store.conn.commit()
    return _suite_json(store.conn.execute("SELECT * FROM eval_suites WHERE id=?", (sid,)).fetchone())


@app.get("/api/projects/{pid}/eval-suites")
def list_eval_suites(pid: str) -> List[Dict[str, Any]]:
    if not store.project(pid): raise HTTPException(404, "project not found")
    return [_suite_json(row) for row in store.conn.execute("SELECT * FROM eval_suites WHERE project_id=? ORDER BY updated_at DESC", (pid,))]


@app.get("/api/projects/{pid}/eval-suites/{sid}")
def get_eval_suite(pid: str, sid: str) -> Dict[str, Any]:
    row = store.conn.execute("SELECT * FROM eval_suites WHERE id=? AND project_id=?", (sid, pid)).fetchone()
    if not row: raise HTTPException(404, "evaluation suite not found")
    return _suite_json(row)


@app.put("/api/projects/{pid}/eval-suites/{sid}")
def update_eval_suite(pid: str, sid: str, req: EvalSuiteCreate) -> Dict[str, Any]:
    row = store.conn.execute("SELECT * FROM eval_suites WHERE id=? AND project_id=?", (sid, pid)).fetchone()
    if not row: raise HTTPException(404, "evaluation suite not found")
    now = utcnow(); cases = [case.model_dump() | {"id": case.id or str(uuid.uuid4())} for case in req.cases]
    if len(json.dumps(cases).encode()) > MAX_JSON_BYTES: raise HTTPException(413, "evaluation suite exceeds 5 MiB")
    if any(len(json.dumps(case.get("input")).encode()) > MAX_CASE_INPUT_BYTES for case in cases): raise HTTPException(413, "evaluation case input exceeds 1 MiB")
    sensitive_paths = _sensitive_fixture_paths(cases)
    if sensitive_paths: raise HTTPException(422, f"evaluation suites cannot store credentials; use secret_ref instead: {', '.join(sensitive_paths[:5])}")
    invalid_assertions = assertion_problems(cases)
    if invalid_assertions: raise HTTPException(422, f"invalid assertions: {'; '.join(invalid_assertions[:5])}")
    with store.lock:
        store.conn.execute("UPDATE eval_suites SET name=?,description=?,cases=?,updated_at=? WHERE id=?", (req.name, req.description, json.dumps(cases), now, sid)); store.conn.commit()
    return _suite_json(store.conn.execute("SELECT * FROM eval_suites WHERE id=?", (sid,)).fetchone())


@app.delete("/api/projects/{pid}/eval-suites/{sid}")
def delete_eval_suite(pid: str, sid: str) -> Dict[str, Any]:
    if not store.conn.execute("SELECT 1 FROM eval_suites WHERE id=? AND project_id=?", (sid, pid)).fetchone(): raise HTTPException(404, "evaluation suite not found")
    if store.conn.execute("SELECT 1 FROM evaluations WHERE suite_id=? LIMIT 1", (sid,)).fetchone():
        raise HTTPException(409, "evaluation suite has historical evaluations")
    with store.lock: store.conn.execute("DELETE FROM eval_suites WHERE id=?", (sid,)); store.conn.commit()
    return {"deleted": True, "id": sid}


def _eval_emit(evaluation_id: str, event_type: str, **payload: Any) -> None:
    event = {"evaluation_id": evaluation_id, "type": event_type, "timestamp": utcnow()}
    compact_payload = _compact_value(payload)
    if isinstance(compact_payload, dict) and not compact_payload.get("truncated"):
        event.update(compact_payload)
    else:
        event.update({"payload": compact_payload, "truncated": True})
    with store.lock:
        seq = int(store.conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM evaluation_events WHERE evaluation_id=?", (evaluation_id,)).fetchone()[0])
        event["id"] = seq
        store.conn.execute("INSERT INTO evaluation_events VALUES (?,?,?,?,?)", (evaluation_id, seq, event_type, json.dumps(event), event["timestamp"])); store.conn.commit()


def _wait_run(run_id: str, timeout: float = 120) -> Dict[str, Any]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        row = store.conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if row and row["status"] != "running":
            result = get_run(run_id)
            private = run_private_results.get(run_id)
            if private is not None:
                result["output"] = private.get("output")
                result["metrics"] = private.get("metrics", result.get("metrics", {}))
            return result
        time.sleep(.02)
    result = get_run(run_id)
    private = run_private_results.get(run_id)
    if private is not None:
        result["output"] = private.get("output")
        result["metrics"] = private.get("metrics", result.get("metrics", {}))
    return result


def _revision_unpriced_models(revision_id: str, override: Optional[str], provider_models: Optional[Dict[str, str]] = None) -> set[str]:
    row = store.conn.execute("SELECT graph FROM revisions WHERE id=?", (revision_id,)).fetchone()
    if not row:
        return set()
    graph = Graph.model_validate(json.loads(row["graph"]))
    unpriced = set()
    llm_capable = {"llm", "planner", "router", "supervisor", "react_loop"}
    for block in graph.blocks:
        if block.block_type not in llm_capable:
            continue
        selected = str(block.config.get("provider") or override or "").strip()
        if not selected or selected == "simulator":
            continue
        model = str(block.config.get("model") or (provider_models or {}).get(selected) or "").strip()
        if get_model_price(selected, model) is None:
            unpriced.add(f"{selected}/{model or '<missing-model>'}")
    return unpriced


def _evaluation_worker(evaluation_id: str, project_id: str, suite_id: str, baseline_revision_id: str, candidate_revision_id: str, provider: Optional[str], budgets: Dict[str, Any], provider_snapshot: Dict[str, str]) -> None:
    with evaluation_slots:
        try:
            _evaluation_worker_inner(evaluation_id, project_id, suite_id, baseline_revision_id, candidate_revision_id, provider, budgets, provider_snapshot)
        except Exception as exc:
            row = store.conn.execute("SELECT COUNT(*) FROM evaluation_cases WHERE evaluation_id=?", (evaluation_id,)).fetchone()
            status = "partial" if row and row[0] else "failed"
            with store.lock:
                store.conn.execute("UPDATE evaluations SET status=?,error=?,completed_at=? WHERE id=?", (status, str(exc)[:4000], utcnow(), evaluation_id)); store.conn.commit()
            if store.conn.execute("SELECT 1 FROM evaluations WHERE id=?", (evaluation_id,)).fetchone():
                _eval_emit(evaluation_id, "evaluation_error", status=status, error=str(exc)[:4000])
        finally:
            evaluation_current_runs.pop(evaluation_id, None)


def _evaluation_worker_inner(evaluation_id: str, project_id: str, suite_id: str, baseline_revision_id: str, candidate_revision_id: str, provider: Optional[str], budgets: Dict[str, Any], provider_snapshot: Dict[str, str]) -> None:
    with store.lock: store.conn.execute("UPDATE evaluations SET status='running', started_at=? WHERE id=?", (utcnow(), evaluation_id)); store.conn.commit()
    eval_row = store.conn.execute("SELECT suite_snapshot FROM evaluations WHERE id=?", (evaluation_id,)).fetchone()
    cases = json.loads(eval_row[0] or "[]")[:int(budgets["max_cases"])] if eval_row else []
    baseline_passed = candidate_passed = baseline_evaluated = candidate_evaluated = failed = executed = skipped_pairs = 0
    total_cost = 0.0; total_tokens = 0; regressions = improvements = unchanged = 0
    pricing_versions: set[str] = set()
    deadline = time.monotonic() + float(budgets["max_wall_seconds"]); stop_reason = None
    cost_guard = CostBudgetGuard(float(budgets["max_cost_usd"]))
    for index, case in enumerate(cases):
        row = store.conn.execute("SELECT cancel_requested FROM evaluations WHERE id=?", (evaluation_id,)).fetchone()
        if not row or row[0]:
            with store.lock: store.conn.execute("UPDATE evaluations SET status='cancelled', completed_at=? WHERE id=?", (utcnow(), evaluation_id)); store.conn.commit()
            _eval_emit(evaluation_id, "evaluation_cancelled", completed=executed); return
        _eval_emit(evaluation_id, "case_started", case_index=index, name=case.get("name", "case"))
        baseline_id = _create_run(RunCreate(project_id=project_id, revision_id=baseline_revision_id, input=case.get("input"), provider=provider), cost_guard, provider_snapshot)["id"]
        evaluation_current_runs[evaluation_id] = [baseline_id]
        baseline = _wait_run(baseline_id, timeout=max(0, deadline - time.monotonic()))
        if baseline.get("status") == "running": run_cancel[baseline_id] = True; stop_reason = "max_wall_seconds"; break
        if "evaluation cost budget" in str(baseline.get("error") or ""):
            stop_reason = "max_cost_usd"; break
        if store.conn.execute("SELECT cancel_requested FROM evaluations WHERE id=?", (evaluation_id,)).fetchone()[0]:
            run_cancel[baseline_id] = True
            with store.lock: store.conn.execute("UPDATE evaluations SET status='cancelled', completed_at=? WHERE id=?", (utcnow(), evaluation_id)); store.conn.commit()
            _eval_emit(evaluation_id, "evaluation_cancelled", completed=executed); return
        baseline_tokens = int(baseline.get("metrics", {}).get("tokens") or 0)
        baseline_cost = baseline.get("metrics", {}).get("cost_usd")
        if baseline.get("metrics", {}).get("pricing_version"):
            pricing_versions.add(str(baseline["metrics"]["pricing_version"]))
        total_tokens += baseline_tokens
        if baseline_cost is not None:
            total_cost += float(baseline_cost)
        if total_tokens >= int(budgets["max_tokens"]) or time.monotonic() >= deadline:
            stop_reason = "max_tokens" if total_tokens >= int(budgets["max_tokens"]) else "max_wall_seconds"; break
        if total_cost >= float(budgets["max_cost_usd"]):
            stop_reason = "max_cost_usd"; break
        candidate_id = _create_run(RunCreate(project_id=project_id, revision_id=candidate_revision_id, input=case.get("input"), provider=provider), cost_guard, provider_snapshot)["id"]
        evaluation_current_runs[evaluation_id] = [candidate_id]
        candidate = _wait_run(candidate_id, timeout=max(0, deadline - time.monotonic()))
        if candidate.get("status") == "running": run_cancel[candidate_id] = True; stop_reason = "max_wall_seconds"; break
        if "evaluation cost budget" in str(candidate.get("error") or ""):
            stop_reason = "max_cost_usd"; break
        cancel_row = store.conn.execute("SELECT cancel_requested FROM evaluations WHERE id=?", (evaluation_id,)).fetchone()
        if not cancel_row or cancel_row[0]:
            run_cancel[candidate_id] = True
            with store.lock: store.conn.execute("UPDATE evaluations SET status='cancelled', completed_at=? WHERE id=?", (utcnow(), evaluation_id)); store.conn.commit()
            _eval_emit(evaluation_id, "evaluation_cancelled", completed=executed); return
        candidate_tokens = int(candidate.get("metrics", {}).get("tokens") or 0)
        candidate_cost = candidate.get("metrics", {}).get("cost_usd")
        if candidate.get("metrics", {}).get("pricing_version"):
            pricing_versions.add(str(candidate["metrics"]["pricing_version"]))
        total_tokens += candidate_tokens
        if candidate_cost is not None:
            total_cost += float(candidate_cost)
        b_spans = store.conn.execute("SELECT * FROM run_spans WHERE run_id=?", (baseline["id"],)).fetchall(); c_spans = store.conn.execute("SELECT * FROM run_spans WHERE run_id=?", (candidate["id"],)).fetchall()
        b_result, c_result = _evaluate_case(case, baseline, b_spans), _evaluate_case(case, candidate, c_spans)
        if not b_result["skipped"]: baseline_evaluated += 1
        if not c_result["skipped"]: candidate_evaluated += 1
        if b_result["passed"]: baseline_passed += 1
        if c_result["passed"]: candidate_passed += 1
        if b_result["skipped"] or c_result["skipped"]:
            comparison = "not_evaluable"
        else:
            comparison = "regression" if b_result["passed"] and not c_result["passed"] else "improvement" if not b_result["passed"] and c_result["passed"] else "both_pass" if b_result["passed"] and c_result["passed"] else "both_fail"
        regressions += comparison == "regression"; improvements += comparison == "improvement"; unchanged += comparison in ("both_pass", "both_fail")
        skipped_pairs += comparison == "not_evaluable"
        status = comparison
        if comparison not in ("both_pass", "not_evaluable"): failed += 1
        executed += 1
        with store.lock:
            store.conn.execute("INSERT INTO evaluation_cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), evaluation_id, index, case.get("name", "case"), _dump_compact(case.get("input"), MAX_CASE_INPUT_BYTES), _dump_compact(case.get("expected"), MAX_CASE_INPUT_BYTES), baseline["id"], candidate["id"], _dump_compact(b_result), _dump_compact(c_result), status, None if status == "both_pass" else _dump_compact({"baseline": b_result.get("failures"), "candidate": c_result.get("failures"), "not_evaluable": b_result.get("not_evaluable", []) + c_result.get("not_evaluable", [])})))
            store.conn.commit()
        _eval_emit(evaluation_id, "case_completed", case_index=index, status=status, baseline=b_result, candidate=c_result)
        if total_tokens >= int(budgets["max_tokens"]): stop_reason = "max_tokens"; break
        if total_cost >= float(budgets["max_cost_usd"]): stop_reason = "max_cost_usd"; break
        if time.monotonic() >= deadline: stop_reason = "max_wall_seconds"; break
    evaluation_current_runs.pop(evaluation_id, None)
    total_cost = max(total_cost, cost_guard.spent_usd)
    status = "completed" if executed == len(cases) and stop_reason is None else "partial" if executed or stop_reason else "failed"
    metrics = {"cases": executed, "failed_pairs": failed, "skipped_pairs": skipped_pairs, "baseline_passed": baseline_passed, "candidate_passed": candidate_passed, "baseline_pass_rate": baseline_passed / baseline_evaluated if baseline_evaluated else None, "candidate_pass_rate": candidate_passed / candidate_evaluated if candidate_evaluated else None, "regressions": regressions, "improvements": improvements, "unchanged": unchanged, "total_tokens": total_tokens, "total_cost_usd": total_cost if total_cost else None, "pricing_version": sorted(pricing_versions)[0] if len(pricing_versions) == 1 else sorted(pricing_versions) if pricing_versions else None, "stop_reason": stop_reason}
    with store.lock: store.conn.execute("UPDATE evaluations SET status=?, metrics=?, completed_at=? WHERE id=?", (status, json.dumps(metrics), utcnow(), evaluation_id)); store.conn.commit()
    _eval_emit(evaluation_id, "evaluation_completed", status=status, metrics=metrics)


@app.post("/api/projects/{pid}/evaluations")
def create_evaluation(pid: str, req: EvaluationCreate) -> Dict[str, Any]:
    if not store.project(pid): raise HTTPException(404, "project not found")
    suite = store.conn.execute("SELECT * FROM eval_suites WHERE id=? AND project_id=?", (req.eval_suite_id, pid)).fetchone()
    if not suite: raise HTTPException(404, "evaluation suite not found")
    for revision_id in (req.baseline_revision_id, req.candidate_revision_id):
        if not store.conn.execute("SELECT 1 FROM revisions WHERE id=? AND project_id=?", (revision_id, pid)).fetchone(): raise HTTPException(400, "revision does not belong to project")
    budget_values = req.budgets.model_dump()
    provider_snapshot = _provider_default_models()
    # Unpriced models (openai-compatible endpoints, unknown snapshots) are allowed: their
    # USD budget is not pre-reserved, and spend stays bounded by the token/case/wall-time
    # budgets. Priced models still get hard USD enforcement via the per-call reservation.
    unpriced_models = _revision_unpriced_models(req.baseline_revision_id, req.provider, provider_snapshot) | _revision_unpriced_models(req.candidate_revision_id, req.provider, provider_snapshot)
    suite_snapshot = suite["cases"]
    suite_hash = hashlib.sha256(suite_snapshot.encode()).hexdigest()
    eid, now = str(uuid.uuid4()), utcnow()
    with store.lock:
        active = int(store.conn.execute("SELECT COUNT(*) FROM evaluations WHERE status IN ('queued','running')").fetchone()[0])
        if active >= 8: raise HTTPException(429, "evaluation queue is full")
        store.conn.execute("INSERT INTO evaluations(id,project_id,suite_id,baseline_revision_id,candidate_revision_id,status,provider,max_cost_usd,created_at,suite_snapshot,suite_hash,budgets,provider_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (eid, pid, req.eval_suite_id, req.baseline_revision_id, req.candidate_revision_id, "queued", req.provider, budget_values["max_cost_usd"], now, suite_snapshot, suite_hash, json.dumps(budget_values), json.dumps(provider_snapshot))); store.conn.commit()
    threading.Thread(target=_evaluation_worker, args=(eid, pid, req.eval_suite_id, req.baseline_revision_id, req.candidate_revision_id, req.provider, budget_values, provider_snapshot), daemon=True).start()
    result = get_evaluation(eid, pid)
    if unpriced_models:
        result["cost_unenforced_models"] = sorted(unpriced_models)
    return result


def _evaluation_json(row: sqlite3.Row) -> Dict[str, Any]:
    cases = [dict(case) for case in store.conn.execute("SELECT * FROM evaluation_cases WHERE evaluation_id=? ORDER BY case_index", (row["id"],))]
    for case in cases:
        for key in ("input", "expected", "baseline_result", "candidate_result"): case[key] = json.loads(case[key]) if case[key] else None
    budgets = json.loads(row["budgets"] or "{}")
    suite_cases = json.loads(row["suite_snapshot"] or "[]")
    total_cases = min(len(suite_cases), int(budgets.get("max_cases", len(suite_cases))))
    return {"id": row["id"], "project_id": row["project_id"], "eval_suite_id": row["suite_id"], "eval_suite_hash": row["suite_hash"], "baseline_revision_id": row["baseline_revision_id"], "candidate_revision_id": row["candidate_revision_id"], "status": row["status"], "provider": row["provider"], "provider_snapshot": json.loads(row["provider_snapshot"] or "{}"), "budgets": budgets, "total_cases": total_cases, "completed_cases": len(cases), "metrics": json.loads(row["metrics"] or "{}"), "error": row["error"], "cases": cases, "created_at": row["created_at"], "started_at": row["started_at"], "completed_at": row["completed_at"]}


@app.get("/api/projects/{pid}/evaluations")
def list_evaluations(pid: str, limit: int = 100) -> List[Dict[str, Any]]:
    if not store.project(pid): raise HTTPException(404, "project not found")
    rows = store.conn.execute("SELECT * FROM evaluations WHERE project_id=? ORDER BY created_at DESC LIMIT ?", (pid, max(1, min(limit, 500)))).fetchall()
    return [_evaluation_json(row) for row in rows]


@app.get("/api/evaluations/{evaluation_id}")
def get_evaluation(evaluation_id: str, project_id: str) -> Dict[str, Any]:
    row = store.conn.execute("SELECT * FROM evaluations WHERE id=? AND project_id=?", (evaluation_id, project_id)).fetchone()
    if not row: raise HTTPException(404, "evaluation not found")
    return _evaluation_json(row)


@app.delete("/api/evaluations/{evaluation_id}")
def delete_evaluation(evaluation_id: str, project_id: str) -> Dict[str, Any]:
    row = store.conn.execute("SELECT status FROM evaluations WHERE id=? AND project_id=?", (evaluation_id, project_id)).fetchone()
    if not row: raise HTTPException(404, "evaluation not found")
    if row[0] in ("queued", "running"): raise HTTPException(409, "cancel evaluation before deleting it")
    with store.lock: store.conn.execute("DELETE FROM evaluations WHERE id=?", (evaluation_id,)); store.conn.commit()
    return {"deleted": True, "id": evaluation_id}


@app.post("/api/evaluations/{evaluation_id}/cancel")
def cancel_evaluation(evaluation_id: str, project_id: str) -> Dict[str, Any]:
    if not store.conn.execute("SELECT 1 FROM evaluations WHERE id=? AND project_id=?", (evaluation_id, project_id)).fetchone(): raise HTTPException(404, "evaluation not found")
    with store.lock: store.conn.execute("UPDATE evaluations SET cancel_requested=1 WHERE id=?", (evaluation_id,)); store.conn.commit()
    for run_id in evaluation_current_runs.get(evaluation_id, []): run_cancel[run_id] = True
    return {"id": evaluation_id, "status": "cancelling"}


@app.get("/api/evaluations/{evaluation_id}/events")
def evaluation_events(evaluation_id: str, project_id: str, last_event_id: Optional[int] = Header(default=None, alias="Last-Event-ID")):
    if not store.conn.execute("SELECT 1 FROM evaluations WHERE id=? AND project_id=?", (evaluation_id, project_id)).fetchone(): raise HTTPException(404, "evaluation not found")
    def gen():
        sent = 0
        while True:
            start = last_event_id or 0
            rows = store.conn.execute("SELECT payload FROM evaluation_events WHERE evaluation_id=? AND seq>? ORDER BY seq", (evaluation_id, start)).fetchall()
            while sent < len(rows):
                payload = rows[sent][0]; event_id = json.loads(payload).get("id", start + sent + 1)
                yield f"id: {event_id}\ndata: {payload}\n\n"; sent += 1
            status = store.conn.execute("SELECT status FROM evaluations WHERE id=?", (evaluation_id,)).fetchone()[0]
            if status in ("completed", "failed", "partial", "cancelled") and sent >= len(rows): break
            time.sleep(.05)
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/runs/{run_id}/cancel")
def cancel_run(run_id: str) -> Dict[str, Any]:
    if not store.conn.execute("SELECT 1 FROM runs WHERE id=?", (run_id,)).fetchone(): raise HTTPException(404, "run not found")
    run_cancel[run_id] = True
    return {"id": run_id, "status": "cancelling"}


@app.get("/api/runs/{run_id}/events")
def run_event_stream(run_id: str, last_event_id: Optional[int] = Header(default=None, alias="Last-Event-ID")):
    if not store.conn.execute("SELECT 1 FROM runs WHERE id=?", (run_id,)).fetchone(): raise HTTPException(404, "run not found")
    def gen():
        start = int(last_event_id or 0)
        sent = 0
        while True:
            events = run_events.get(run_id, [])
            if start:
                events = [event for event in events if int(event.get("id") or 0) > start]
            if not events:
                events = []
                for row in store.conn.execute("SELECT seq, payload FROM run_events WHERE run_id=? AND seq>? ORDER BY seq", (run_id, start)):
                    event = json.loads(row[1])
                    event.setdefault("id", row[0])
                    events.append(event)
            while sent < len(events):
                event = events[sent]
                prefix = f"id: {event['id']}\n" if event.get("id") is not None else ""
                yield f"{prefix}data: {json.dumps(event)}\n\n"; sent += 1
            row = store.conn.execute("SELECT status, output, error, completed_at FROM runs WHERE id=?", (run_id,)).fetchone()
            status = row["status"]
            if status in ("completed", "failed", "cancelled") and sent >= len(events):
                if not events:
                    event_type = "run_completed" if status == "completed" else "run_cancelled" if status == "cancelled" else "node_error"
                    terminal = {"run_id": run_id, "type": event_type, "timestamp": row["completed_at"] or utcnow(), "status": status, "output": json.loads(row["output"] or "null"), "error": row["error"]}
                    yield f"data: {json.dumps(terminal)}\n\n"
                break
            time.sleep(0.05)
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/import/python")
async def import_python(file: UploadFile = File(...)) -> Dict[str, Any]:
    data = await file.read()
    if len(data) > MAX_PYTHON_UPLOAD:
        raise HTTPException(413, "python file exceeds 5 MiB limit")
    try: tree = ast.parse(data.decode("utf-8"))
    except Exception as exc: raise HTTPException(400, f"invalid python: {exc}")
    def annotation(node: ast.expr | None) -> str:
        return ast.unparse(node) if node is not None else "any"
    funcs = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            funcs.append({
                "name": node.name,
                "async": isinstance(node, ast.AsyncFunctionDef),
                "parameters": [{"name": arg.arg, "type": annotation(arg.annotation)} for arg in node.args.args],
                "returns": annotation(node.returns),
            })
    classes = [n.name for n in tree.body if isinstance(n, ast.ClassDef)]
    imports = [n.names[0].name for n in ast.walk(tree) if isinstance(n, ast.Import) and n.names]
    from_imports = [n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module]
    all_imports = sorted(set(imports + from_imports))
    risky = sorted({name.split(".")[0] for name in all_imports} & {"os", "subprocess", "socket", "ctypes", "shutil"})
    credential_findings = scan_text(data.decode("utf-8"), file.filename or "module")
    return {
        "filename": file.filename,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "functions": funcs,
        "classes": classes,
        "imports": all_imports,
        "warnings": [f"sensitive import: {name}" for name in risky] + [f"credential-like content ({finding['kind']}) in imported code; keep credentials out of block source" for finding in credential_findings],
        "source": "custom:" + (file.filename or "module"),
        "safe_to_execute": bool(shutil.which("docker") or shutil.which("podman")),
        "code": data.decode("utf-8"),
    }


def _zip_response(files: Dict[str, bytes], filename: str) -> StreamingResponse:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n, d in files.items(): z.writestr(n, d)
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/projects/{pid}/export")
def export_project(pid: str, allow_secrets: bool = False):
    p = get_project(pid)
    if not allow_secrets and p.get("revision"):
        findings = scan_graph(p["revision"]["graph"])
        if findings:
            raise HTTPException(422, {"message": "export blocked: credential-like data found in the project graph; retry with allow_secrets=true to export anyway", "findings": findings})
    files = {"project.json": json.dumps(p, indent=2).encode(), "README.md": b"AgentLab project bundle\n"}
    return _zip_response(files, f"{pid}.agentlab.zip")


@app.post("/api/projects/import")
async def import_project(file: UploadFile = File(...)) -> Dict[str, Any]:
    data = await file.read()
    if len(data) > MAX_PROJECT_UPLOAD:
        raise HTTPException(413, "project archive exceeds 20 MiB limit")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            info = z.getinfo("project.json")
            if info.file_size > MAX_PROJECT_UPLOAD:
                raise ValueError("project.json exceeds size limit")
            payload = json.loads(z.read(info))
    except Exception as exc: raise HTTPException(400, f"invalid project archive: {exc}")
    req = ProjectCreate(name=payload.get("project", {}).get("name", "Imported Agent"), description=payload.get("project", {}).get("description", ""), graph=Graph.model_validate(payload.get("revision", {}).get("graph", {})))
    return create_project(req)


@app.get("/api/projects/{pid}/export-code")
@app.get("/api/projects/{pid}/code-export")
def export_code(pid: str, allow_secrets: bool = False):
    p = get_project(pid)
    graph = p["revision"]["graph"] if p.get("revision") else {}
    if not allow_secrets:
        findings = scan_graph(graph)
        if findings:
            raise HTTPException(422, {"message": "code export blocked: credential-like data found in the project graph; retry with allow_secrets=true to export anyway", "findings": findings})
    exported_graph = json.loads(json.dumps(graph))
    files: Dict[str, bytes] = {}
    for block in exported_graph.get("blocks", []):
        if block.get("code_override"):
            safe_name = hashlib.sha256(str(block.get("id", "block")).encode()).hexdigest()[:20]
            filename = f"blocks/{safe_name}.py"
            files[filename] = block["code_override"].encode()
            block["exported_source"] = filename
            block["code_override"] = None
    runtime = '''from __future__ import annotations
import asyncio
import importlib.util
import inspect
import json
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).parent
GRAPH = json.loads((ROOT / "graph.json").read_text())

def _order():
    blocks = {b["id"]: b for b in GRAPH["blocks"]}
    incoming = {key: 0 for key in blocks}
    outgoing = {key: [] for key in blocks}
    for edge in GRAPH["edges"]:
        if edge.get("kind", "data") == "data":
            incoming[edge["target"]] += 1
            outgoing[edge["source"]].append(edge["target"])
    ready, result = [key for key, count in incoming.items() if count == 0], []
    while ready:
        key = ready.pop(0); result.append(blocks[key])
        for target in outgoing[key]:
            incoming[target] -= 1
            if incoming[target] == 0: ready.append(target)
    return result

def _custom(block, value):
    spec = importlib.util.spec_from_file_location("custom_block", ROOT / block["exported_source"])
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    config = block.get("config", {})
    target = getattr(module, config.get("entrypoint") or "execute")
    if inspect.isclass(target):
        instance = target()
        target = getattr(instance, "execute", getattr(instance, "run", None))
    signature = inspect.signature(target)
    class Trace:
        def emit(self, *args, **kwargs): return None
    class State:
        def snapshot(self): return value
        async def compact(self): return None
    class LLM:
        async def chat(self, prompt, **kwargs): return f"simulated response to {prompt}"
        async def classify(self, item, routes): return routes[0] if routes else "default"
    context = SimpleNamespace(trace=Trace(), state=State(), llm=LLM(), tokens=0)
    inputs = dict(value) if isinstance(value, dict) else {"value": value, "request": value, "prompt": value}
    fallback = inputs.get("message", inputs.get("text", inputs.get("value", value)))
    inputs.setdefault("value", fallback); inputs.setdefault("request", fallback); inputs.setdefault("prompt", fallback)
    parameters = list(signature.parameters)
    if parameters[:3] == ["context", "inputs", "config"]: result = target(context, inputs, config)
    elif not parameters: result = target()
    elif isinstance(value, dict) and len(parameters) > 1: result = target(**value)
    else: result = target(value)
    return asyncio.run(result) if inspect.isawaitable(result) else result

def run(input_value):
    value = input_value
    for block in _order():
        if block.get("exported_source"): value = _custom(block, value)
        elif block["block_type"] == "planner": value = {"steps": ["inspect input", "execute action"], "goal": value}
        elif block["block_type"] == "tool": value = {"tool_result": value, "tool": block.get("config", {}).get("tool", "mock")}
        elif block["block_type"] == "llm": value = {"text": f"Configure a provider adapter for: {value}"}
    return value

if __name__ == "__main__":
    import sys
    print(json.dumps(run(json.loads(sys.stdin.read() or "null")), ensure_ascii=False, indent=2))
'''
    files.update({
        "agent.py": runtime.encode(),
        "graph.json": json.dumps(exported_graph, indent=2).encode(),
        "pyproject.toml": b"[project]\nname = \"exported-agentlab-agent\"\nversion = \"0.1.0\"\nrequires-python = \">=3.12\"\n",
        ".env.example": b"# Provider keys are intentionally not exported.\n",
        "README.md": b"# Exported AgentLab project\n\nRun with: `echo '\"hello\"' | python agent.py`\n",
    })
    return _zip_response(files, f"{pid}-code.zip")


@app.get("/api/providers")
def providers() -> List[Dict[str, Any]]:
    rows = store.conn.execute("SELECT * FROM secrets").fetchall(); configured = {r["provider"]: r for r in rows}
    default_models = _provider_default_models()
    capabilities = {
        "openai": ["streaming", "tool_calling", "structured_output", "vision"],
        "anthropic": ["streaming", "tool_calling", "vision"],
        "openai-compatible": ["streaming", "tool_calling"],
    }
    return [{**SecretMetadata(provider=p, configured=p in configured, storage=(configured[p]["storage"] if p in configured else "session"), updated_at=(configured[p]["updated_at"] if p in configured else None), default_model=default_models.get(p, "")).model_dump(), "capabilities": capabilities[p]} for p in capabilities]


@app.put("/api/providers/{provider}/settings")
def set_provider_settings(provider: str, req: ProviderSettingsUpdate) -> Dict[str, Any]:
    if provider not in {"openai", "anthropic", "openai-compatible"}:
        raise HTTPException(404, "unknown provider")
    default_model = req.default_model.strip()
    now = utcnow()
    with store.lock:
        store.conn.execute("INSERT OR REPLACE INTO provider_settings(provider,default_model,updated_at) VALUES (?,?,?)", (provider, default_model, now)); store.conn.commit()
    return next(item for item in providers() if item["provider"] == provider)


@app.put("/api/providers/{provider}/secret")
def set_secret(provider: str, req: SecretSet) -> Dict[str, Any]:
    if provider not in {"openai", "anthropic", "openai-compatible"}:
        raise HTTPException(404, "unknown provider")
    if not req.api_key: raise HTTPException(400, "api_key required")
    storage = "session"
    if req.persist and keyring is not None:
        try:
            keyring.set_password(KEYRING_SERVICE, provider, req.api_key)
            session_secrets.pop(provider, None)
            storage = "keyring"
        except Exception:
            session_secrets[provider] = req.api_key
    else:
        session_secrets[provider] = req.api_key
    now = utcnow()
    with store.lock:
        store.conn.execute("INSERT OR REPLACE INTO secrets VALUES (?,?,?,?)", (provider, 1, storage, now)); store.conn.commit()
    return {"provider": provider, "configured": True, "storage": storage, "updated_at": now}


@app.delete("/api/providers/{provider}/secret")
def delete_secret(provider: str) -> Dict[str, Any]:
    session_secrets.pop(provider, None)
    if keyring is not None:
        try:
            keyring.delete_password(KEYRING_SERVICE, provider)
        except Exception:
            pass
    with store.lock: store.conn.execute("DELETE FROM secrets WHERE provider=?", (provider,)); store.conn.commit()
    return {"provider": provider, "configured": False}


WEB_DIST = Path(__file__).resolve().parents[1] / "web" / "dist"
if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="web-assets")

    @app.get("/{path:path}", include_in_schema=False)
    def web_app(path: str):
        candidate = (WEB_DIST / path).resolve()
        if path and candidate.is_file() and WEB_DIST in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(WEB_DIST / "index.html")
