# AI Devin — Direct Summary

## What this is
A local, end-to-end AI-assisted developer platform (ai-devin-system) that helps generate, test, review, and create PRs for code changes using pluggable agents and a web UI.

## Core capabilities
- Task persistence in MongoDB (tasks + templates).
- Per-task ephemeral workspaces (cloned from repoUrl or git-init).
- Agents: planner, coder, docAgent (comments/docs), executor (Docker sandbox), reviewer, githubAgent.
- Orchestrator pipeline: planner → coder → docgen → executor → reviewer → (optional) github.
- File manager + in-browser editor (Streamlit + streamlit-ace).
- Git integration: per-task branch ai/task-<id>, auto add/commit on save.
- Diff preview (unified + side-by-side per-file), Approve → push & create PR via GH PAT.
- Undo/revert (creates backup branch).
- Secret scanning blocks pushes unless overridden.
- Real-time task step events via WebSocket.
- Notifications: Slack + email with redaction.
- LLM diagnostic step on test failures (optional).

## Key files / entry points
- server.js — API server, per-task workspace setup, mounts routers, starts WebSocket server.
- src/db/mongo.js — task & template persistence helpers.
- src/orchestrator/loop.js — pipeline orchestration, notifications, realtime broadcast.
- src/agents/ — planner, coder, docAgent, executor (structured output), reviewer, githubAgent.
- src/routes/files.js — file manager endpoints (list/read/write/delete + git logic).
- src/routes/actions.js — diff, file-diff, scan, approve (push+PR), undo.
- src/routes/templates.js — templates CRUD API.
- src/realtime/wsServer.js — WebSocket broadcast server.
- src/utils/notifier.js — Slack/email notifications with redaction.
- streamlit-ui/app.py — full UI: templates, file manager, editor, diff, approve, undo, live events.

## Main API endpoints
- POST /run — create + enqueue task
- GET /tasks, GET /tasks/:id — list / get task
- /api/files — file operations (supports taskId)
- /api/actions/diff, /file-diff, /scan, /approve, /undo
- /api/templates — templates CRUD

## How to run (quick)
1. Copy `.env.example` → `.env` and set required vars: MONGO_URL, REDIS_HOST, OPENAI_API_KEY (opt), GH_PAT (opt), API_KEY (opt).
2. Start infra: `docker-compose -f docker/docker-compose.yml up -d`
3. Install & start backend:
   - `npm install`
   - `npm start`
   - `npm run worker`
4. Install Python deps and run UI:
   - `pip install -r requirements.txt`
   - `pip install streamlit-ace`
   - `streamlit run streamlit-ui/app.py`
5. Open the Streamlit UI in your browser.

## Security & operational notes
- Protect API with `API_KEY` before exposing the server.
- Keep GH_PAT and OPENAI_API_KEY in secure secret store; prefer GitHub Apps for production.
- Executor runs Docker with mounted workspaces — run on isolated, secure hosts.
- Secret scanner is heuristic; integrate stronger tools (gitleaks) for production.

## Next recommended improvements
- Integrate gitleaks (or similar) for robust secret scanning.
- Add approval audit trail (who/when) in Mongo.
- Replace GH_PAT push flow with GitHub App or deploy-key workflow.
- Add RBAC / authentication for Streamlit and API.
- Add CI/tests for agents and integration tests for orchestrator.
