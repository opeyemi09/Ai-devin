# AI Devin — End-to-End AI-assisted Developer Platform

Status: Prototype / developer scaffold

This repository is an AI-assisted development scaffold that can generate, test, review, and prepare code changes (commits and PRs) using an orchestrated set of agents and a web UI. It supports automated, chunked project generation (module-by-module), per-module CI in Docker, secret & quality gates (gitleaks, lint/tests), token/cost estimation, and a Streamlit-based dashboard for progress and approvals.

This README summarizes what’s included, how to run it, and how to use the new automated generation features.

Contents
- server.js — Express API and WebSocket server
- src/
  - agents/ — planner, coder, docAgent, executor, reviewer, githubAgent
  - orchestrator/
    - loop.js — original orchestrator
    - autoGenerator.js — automated chunked-generation orchestrator
    - moduleRunner.js — generate/write/commit + module CI runner
  - queue/ — BullMQ queue + worker
  - db/mongo.js — Mongo helpers for tasks, templates, module plans/statuses
  - routes/ — files.js, actions.js (updated), templates.js
  - realtime/wsServer.js — WebSocket broadcaster
  - tools/ — git, dockerExec, gitleaks integration, github helpers
  - utils/ — logger, llm adapter, notifier, security scanner
- streamlit-ui/app.py — Streamlit control UI (templates, file manager, diff, approve, undo, auto-generate dashboard)
- docker/docker-compose.yml — local Redis + Mongo
- .env.example — environment variables with new entries
- package.json, requirements.txt

Highlights / Capabilities
- Task persistence in MongoDB and processing via BullMQ worker.
- Per-task workspaces: WORKSPACE_ROOT/tasks/<taskId> (clone repo or init).
- Modular agent pipeline: planner → coder → docgen → executor → reviewer → (optional) githubAgent.
- Automated chunked-generation:
  - Planner creates a module plan (list of modules/files with target LOC).
  - autoGenerator iterates modules and invokes moduleRunner.
  - moduleRunner calls coder, writes files, commits, runs module-level CI in Docker, runs linters, runs gitleaks (optional), and records status.
- Module-level CI runs inside Docker (configurable image), storing logs in workspace/artifacts/.
- Secret scanning via gitleaks (Docker image). Findings block pushes unless explicitly overridden.
- Streamlit UI:
  - Create/load/save task templates.
  - File manager & editor with auto-commit on save to ai/task-<id> branch.
  - Unified and side-by-side diffs.
  - Scan diff for secrets and approve/push + create PR.
  - Undo/revert branch (creates backup).
  - Auto-generate panel (dry-run, start/stop, controls).
  - Progress dashboard: module statuses, progress bar, per-module logs.
- Token & cost estimator (simple heuristic) for planned generation.
- WebSocket realtime events broadcast to UI (/ws).
- Notifications: Slack and email (with redaction) for failures.

Quickstart (local development)
1. Copy .env.example -> .env and set values:
   - MONGO_URL (e.g., mongodb://localhost:27017/ai_devin)
   - REDIS_HOST / REDIS_PORT
   - WORKSPACE_ROOT=./workspace
   - OPTIONAL: OPENAI_API_KEY (LLM), GH_PAT (for push/PR), API_KEY (protect /api)
   - OPTIONAL: SLACK_WEBHOOK_URL, ADMIN_EMAIL, SMTP_* for notifications
   - OPTIONAL: GITLEAKS_IMAGE (default: zricethezav/gitleaks:8.12.0)
   - OPTIONAL: TOKEN_COST_USD_PER_1K (default: 0.03)

2. Start infra:
   docker-compose -f docker/docker-compose.yml up -d

3. Install Node dependencies and start backend & worker:
   npm install
   npm start
   npm run worker

4. Install Python deps and start UI:
   pip install -r requirements.txt
   pip install streamlit-ace
   streamlit run streamlit-ui/app.py

5. Open your browser to the Streamlit UI (defaults to http://localhost:8501).

Key environment variables (.env.example additions)
- GITLEAKS_IMAGE=zricethezav/gitleaks:8.12.0
- TOKEN_COST_USD_PER_1K=0.03
- API_KEY=... (protect /api)
- GH_PAT=... (used server-side to push & create PRs)
- OPENAI_API_KEY=... (LLM)

Main API endpoints (selected)
- POST /run
  - Body: { prompt, meta: { owner, repo, repoUrl }, autoCreatePR, ... }
  - Creates a task and enqueues it.

- File manager (/api)
  - GET /api/files?path=&taskId=
  - GET /api/file?path=&taskId=
  - POST /api/file { path, content, taskId, commitMessage }
  - POST /api/folder { path, taskId }
  - DELETE /api/file?path=&taskId=

- Actions (/api/actions)
  - GET /api/actions/diff?taskId=&base=
  - GET /api/actions/file-diff?taskId=&filePath=&base=
  - GET /api/actions/scan?taskId=&base= (runs gitleaks when available)
  - POST /api/actions/approve { taskId, title, body, base?, overrideSecrets? }
  - POST /api/actions/undo { taskId, base? }

- Automated generation (new)
  - POST /api/actions/start-auto
    - Body (examples): { taskId, dryRun?: true, maxModulesPerRun?: 3, testCommand?, sandboxImage?, gitleaksEnabled?: true, failOnSecrets?: true, runLint?: true }
    - dryRun=true returns planner-produced module plan + token/cost estimate without running generation.
    - dryRun=false starts background processing (up to maxModulesPerRun per invocation).
  - POST /api/actions/stop-auto { taskId }
  - GET /api/actions/auto-status?taskId=...

Data model additions
- Each task document may include:
  - modulePlan: array of module specs (name, path, description, targetLines, tests, etc.)
  - moduleStatuses: array of { name, status: pending|running|succeeded|failed|dry, updatedAt, info }
  - steps: append-only array of agent/CI steps and outputs

How the automated generator works (summary)
1. Planner produces a module plan (list of modules and target lines).
2. The plan is stored in the task (modulePlan) and moduleStatuses are initialized.
3. start-auto (dryRun) returns plan & estimate; start-auto (run) stores the plan and begins processing modules.
4. moduleRunner for each module:
   - Calls Coder to generate files for the module spec (coder.run(taskWithModuleSpec)).
   - Writes files into workspace/tasks/<taskId>/...
   - Git add & commit on the task branch.
   - Runs module-level CI in Docker (testCommand), writes artifacts to workspace/artifacts/.
   - Optionally runs lint (npm run lint) and gitleaks.
   - Updates moduleStatuses to reflect success/failure and pushes steps to the task.

Safety & quality gates
- Gitleaks runs (Docker image) and findings block PR push unless overrideSecrets is used (Approve endpoint supports override).
- Lint/test failures mark a module as failed and pause the auto-generator. You can fix and resume.
- The system is conservative by default: auto-push is disabled; you must approve PR creation or use explicit autoCreatePR with caution.

Streamlit UI highlights
- Create Task: use templates or freeform prompt.
- Auto-generate panel: plan & estimate (dry-run), start/stop auto-generation, configure batch size and gates.
- Progress dashboard: module-by-module status, progress bar, per-module logs and diffs.
- File manager/editor: edit files, commit automatically to ai/task-<id> branch for task workspaces.
- Diff preview and side-by-side per-file diffs.
- Scan+Approve: run gitleaks and approve to push & create PR (GH_PAT required on server).
- Undo endpoint: creates backup branch then resets to base if you need to revert.

Operational notes & requirements
- Docker is required on the host for module-level CI and gitleaks.
- Protect your server: set API_KEY in .env and do not expose without authentication.
- Keep GH_PAT & OPENAI_API_KEY in secure storage and do not commit them.
- For production, prefer GitHub App/deploy-key instead of GH_PAT and stronger sandboxing (gVisor, Kata) for running untrusted code.

Limitations & recommendations
- The token & cost estimator is heuristic. For accurate billing, instrument your llm adapter to return token usage per call.
- Gitleaks regex/heuristics and the notifier redaction reduce risk but are not a substitute for careful auditing.
- Generated code must be reviewed — LLMs can hallucinate or produce insecure code. Use small, testable chunks.
- Consider adding an approval audit trail (who approved, when) and RBAC/SSO for the UI.

Next steps you can ask for
- Integrate precise token accounting in the LLM wrapper.
- Replace PAT push flow with a GitHub App.
- Add audit trail for approvals in Mongo.
- Harden sandboxing and run tests in isolated CI/CD runners.
- Add unit/integration tests for orchestrator and moduleRunner.

Contact / contribution
- This scaffold is intended as a starting point. Please review and harden before exposing externally.
- If you want, I can push these changes to a repo branch for you (provide repo and permissions), or create example tasks to test the automated flow on a small sample project.

License
- MIT (adapt as needed).
