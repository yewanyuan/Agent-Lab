# Agent Lab Web

Agent Lab is an IDE-style React workbench for composing and validating Agent graphs. It is intentionally local-first: the editor and catalog are usable without a runner, while the API adapter connects to the planned FastAPI endpoints when they are available.

## Run

```bash
npm install
npm run dev
```

The Vite server runs on `http://localhost:5173` and proxies `/api` to `http://127.0.0.1:8000`.

## Included in this slice

- Six starter patterns: Tool Use, ReAct, Plan & Execute, Router, Supervisor Team, and Memory Agent, plus Harness Lab.
- Drag blocks from the palette onto the canvas, select and delete connections, and use copy/cut/paste/duplicate/delete/undo/redo.
- Instance-level Python editing in Monaco. Editing a node creates an override and never mutates the catalog manifest.
- Config, code, ports, and docs inspector tabs.
- Run, stop, validation, trace, input/output, metrics, and problems panels.
- Device-level 90/100/110/120% interface text preferences and a persistent English/Chinese language switch, kept out of project exports.
- Last-saved-project restoration reloads the latest revision and active server-backed view after a browser refresh without persisting unsaved graph/code drafts.
- Persistent Runs, server revision history, two-revision structural diff, and CSV export protected from spreadsheet formula injection.
- Persistent evaluation suites with table/JSON editing, A/B launch, SSE progress, paired results, pass-rate and regression comparison. Simulator runs are always available; real-provider A/B requires an exact model snapshot in the runner's versioned price registry.
- Project import/export and code-export actions with local JSON fallback when the API is unavailable.
- Desktop-first layout with a read-only notice on narrow viewports.

## API contract

The adapter additionally consumes project revision/run listings, persistent evaluation-suite CRUD, evaluation list/detail/cancel/delete, and evaluation SSE endpoints. A failed API call does not block graph editing; local validation and a deterministic trace simulator remain available.

Provider metadata includes a non-secret default model. LLM node model values override this Runner-level default.
