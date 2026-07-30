"""Evaluation assertion checking shared by the runner's A/B worker and suite validation.

Assertion failure messages must stay value-free: they may reference paths and
types but never embed run output or fixture values, because they are persisted
and streamed after only generic redaction.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Sequence

try:
    import jsonschema
except ImportError:  # pragma: no cover - optional until installed
    jsonschema = None

SUPPORTED_ASSERTION_TYPES = ("exact", "contains", "regex", "json_schema", "max_steps", "tool_called", "max_cost_usd")
MAX_REGEX_PATTERN_LENGTH = 512
MAX_REGEX_SUBJECT_BYTES = 1 * 1024 * 1024


def _regex_subject(actual: Any) -> str:
    subject = actual if isinstance(actual, str) else json.dumps(actual, ensure_ascii=False, default=str)
    return subject.encode("utf-8")[:MAX_REGEX_SUBJECT_BYTES].decode("utf-8", errors="ignore")


def _compile_regex(pattern: Any) -> re.Pattern[str] | None:
    if not isinstance(pattern, str) or not pattern or len(pattern) > MAX_REGEX_PATTERN_LENGTH:
        return None
    try:
        return re.compile(pattern)
    except re.error:
        return None


def _json_schema_problem(schema: Any) -> str | None:
    if jsonschema is None:
        return "jsonschema library is not installed on the runner"
    if not isinstance(schema, (dict, bool)):
        return "json_schema value must be a schema object"
    try:
        jsonschema.validators.validator_for(schema).check_schema(schema)
    except jsonschema.SchemaError as exc:
        return f"invalid schema ({str(exc.message)[:200]})"
    return None


def _assert_result(assertion: Dict[str, Any], actual: Any, spans: Sequence[Any], run_metrics: Dict[str, Any]) -> tuple[bool, str]:
    kind, expected = assertion.get("type"), assertion.get("value")
    if kind == "exact": return actual == expected, "exact mismatch"
    if kind == "contains": return str(expected).lower() in str(actual).lower(), "expected substring not found"
    if kind == "regex":
        compiled = _compile_regex(expected)
        if compiled is None:
            return False, "invalid regex assertion"
        return bool(compiled.search(_regex_subject(actual))), "regex did not match"
    if kind == "json_schema":
        if jsonschema is None:
            return False, "not_evaluable: jsonschema library unavailable"
        if _json_schema_problem(expected):
            return False, "invalid json_schema assertion"
        try:
            jsonschema.validate(actual, expected)
            return True, "schema matched"
        except jsonschema.ValidationError as exc:
            location = exc.json_path if hasattr(exc, "json_path") else "$"
            return False, f"schema mismatch at {location}"
    if kind == "max_steps":
        try:
            limit = int(expected)
            loop_steps = 0
            for span in spans:
                if span["block_type"] != "react_loop":
                    continue
                payload = json.loads(span["output"] or "null")
                if isinstance(payload, dict):
                    loop_steps += int(payload.get("iterations") or 0)
            steps = loop_steps if loop_steps else len(spans)
            return steps <= limit, "max_steps exceeded"
        except (TypeError, ValueError): return False, "invalid max_steps assertion"
    if kind == "tool_called":
        called = False
        for span in spans:
            if span["block_type"] != "tool" or span["status"] != "completed":
                continue
            try:
                payload = json.loads(span["output"] or "null")
            except (TypeError, json.JSONDecodeError):
                payload = None
            if isinstance(payload, dict) and str(payload.get("tool")) == str(expected):
                called = True
                break
        return called, "tool identity was not called"
    if kind == "max_cost_usd":
        if "cost_usd" not in run_metrics: return False, "not_evaluable: cost unavailable"
        return float(run_metrics["cost_usd"]) <= float(expected), "max cost exceeded"
    return False, f"unsupported assertion: {kind}"


def _evaluate_case(case: Dict[str, Any], run: Dict[str, Any], spans: Sequence[Any]) -> Dict[str, Any]:
    assertions = case.get("assertions") or ([{"type": "exact", "value": case.get("expected")}] if case.get("expected") is not None else [])
    failures = [message for assertion in assertions for ok, message in [_assert_result(assertion, run.get("output"), spans, run.get("metrics", {}))] if not ok]
    not_evaluable = [message for message in failures if message.startswith("not_evaluable:")]
    failures = [message for message in failures if not message.startswith("not_evaluable:")]
    evaluated = len(assertions) - len(not_evaluable)
    skipped = bool(assertions) and evaluated == 0 and run.get("status") == "completed"
    passed = not skipped and not failures and run.get("status") == "completed"
    return {"passed": passed, "skipped": skipped, "failures": failures, "not_evaluable": not_evaluable, "output": run.get("output"), "metrics": run.get("metrics", {})}


def assertion_problems(cases: Sequence[Dict[str, Any]]) -> List[str]:
    """Validate assertion declarations before a suite is persisted; returns human-readable problems."""
    problems: List[str] = []
    for case_index, case in enumerate(cases):
        for assertion_index, assertion in enumerate(case.get("assertions") or []):
            kind = assertion.get("type")
            value = assertion.get("value")
            label = f"case[{case_index}].assertions[{assertion_index}]"
            if kind not in SUPPORTED_ASSERTION_TYPES:
                problems.append(f"{label}: unsupported assertion type {str(kind)[:50]!r}")
                continue
            if kind == "regex":
                if not isinstance(value, str) or not value or len(value) > MAX_REGEX_PATTERN_LENGTH:
                    problems.append(f"{label}: regex pattern must be a non-empty string of at most {MAX_REGEX_PATTERN_LENGTH} characters")
                elif _compile_regex(value) is None:
                    problems.append(f"{label}: regex pattern does not compile")
            elif kind == "json_schema":
                schema_problem = _json_schema_problem(value)
                if schema_problem:
                    problems.append(f"{label}: {schema_problem}")
            elif kind == "max_steps":
                try:
                    int(value)
                except (TypeError, ValueError):
                    problems.append(f"{label}: max_steps requires an integer value")
            elif kind == "max_cost_usd":
                try:
                    float(value)
                except (TypeError, ValueError):
                    problems.append(f"{label}: max_cost_usd requires a numeric value")
    return problems
