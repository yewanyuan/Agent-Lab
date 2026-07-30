"""Credential scanning for project graphs, code overrides and Python imports.

Findings deliberately contain only a path and a kind. The matched text itself
must never be returned, logged, or persisted: findings flow into API responses
and the UI Problems panel, which are not credential-safe surfaces.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

SENSITIVE_KEY_PARTS = ("api_key", "apikey", "secret", "password", "authorization", "access_token", "refresh_token")

# High-confidence value shapes only; loose heuristics create noisy warnings that
# users learn to ignore, which is worse than a narrow scanner.
VALUE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("api-key-literal", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("bearer-token", re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]{16,}")),
    ("credential-assignment", re.compile(r"(?i)\b(api_key|apikey|password|access_token|refresh_token|authorization)\b\s*[=:]\s*[\"'][^\"']{8,}[\"']")),
)

MAX_SCAN_BYTES = 5 * 1024 * 1024


def _is_sensitive_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return normalized != "secret_ref" and any(part in normalized for part in SENSITIVE_KEY_PARTS)


def _finding(path: str, kind: str) -> Dict[str, str]:
    return {"path": path, "kind": kind}


def scan_text(text: str, path: str) -> List[Dict[str, str]]:
    """Scan free text (code, imported source, string config values) for credential shapes."""
    findings: List[Dict[str, str]] = []
    if not isinstance(text, str) or not text:
        return findings
    clipped = text.encode("utf-8")[:MAX_SCAN_BYTES].decode("utf-8", errors="ignore")
    for kind, pattern in VALUE_PATTERNS:
        if pattern.search(clipped):
            findings.append(_finding(path, kind))
    return findings


def _scan_config(value: Any, path: str, findings: List[Dict[str, str]]) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            child = f"{path}.{key}"
            if _is_sensitive_key(str(key)):
                findings.append(_finding(child, "sensitive-key"))
            else:
                _scan_config(item, child, findings)
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _scan_config(item, f"{path}[{index}]", findings)
    elif isinstance(value, str):
        findings.extend(scan_text(value, path))


def scan_graph(graph: Dict[str, Any]) -> List[Dict[str, str]]:
    """Scan a graph dict (blocks' config + code_override, graph metadata) for credential-like data."""
    findings: List[Dict[str, str]] = []
    for index, block in enumerate(graph.get("blocks") or []):
        if not isinstance(block, dict):
            continue
        base = f"blocks[{index}]"
        _scan_config(block.get("config") or {}, f"{base}.config", findings)
        code = block.get("code_override")
        if isinstance(code, str):
            findings.extend(scan_text(code, f"{base}.code_override"))
    _scan_config(graph.get("metadata") or {}, "metadata", findings)
    seen: set[tuple[str, str]] = set()
    unique: List[Dict[str, str]] = []
    for finding in findings:
        key = (finding["path"], finding["kind"])
        if key not in seen:
            seen.add(key)
            unique.append(finding)
    return unique


def credential_warnings(graph: Dict[str, Any]) -> List[str]:
    """Human-readable warning strings for API responses; value-free by construction."""
    return [f"credential-like content ({finding['kind']}) at {finding['path']}; move it to the runner secret store or a secret_ref" for finding in scan_graph(graph)]
