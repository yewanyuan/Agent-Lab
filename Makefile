PYTHON ?= python
NPM ?= npm

.PHONY: install build test check e2e run runner-dev web-dev

install:
	$(PYTHON) -m pip install -r apps/runner/requirements.txt
	cd apps/web && $(NPM) install --no-audit --no-fund

build:
	cd apps/web && $(NPM) run build

test:
	PYTHONPATH=. RUNNER_DB_PATH=:memory: $(PYTHON) -m pytest -q apps/runner/tests
	cd apps/web && $(NPM) run test

check: test build

e2e:
	cd apps/web && BASE_URL=$${BASE_URL:-http://127.0.0.1:8000} $(NPM) run test:e2e

run: build
	RUNNER_DB_PATH=$${RUNNER_DB_PATH:-$${HOME}/.agentlab/runner.db} $(PYTHON) -m uvicorn apps.runner.main:app --host 127.0.0.1 --port 8000

runner-dev:
	RUNNER_DB_PATH=$${RUNNER_DB_PATH:-$${HOME}/.agentlab/runner.db} $(PYTHON) -m uvicorn apps.runner.main:app --reload --host 127.0.0.1 --port 8000

web-dev:
	cd apps/web && $(NPM) run dev
