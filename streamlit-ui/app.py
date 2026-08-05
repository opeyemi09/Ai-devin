import streamlit as st
import requests
from streamlit_ace import st_ace
import difflib
import streamlit.components.v1 as components
import time
import json
from math import ceil

# Configurable API base (use Streamlit secrets or default)
API_BASE = st.secrets.get("api_base", "http://localhost:3000")
API_FILES = f"{API_BASE}/api"
API_TASKS = f"{API_BASE}"
API_ACTIONS = f"{API_BASE}/api/actions"
API_TEMPLATES = f"{API_BASE}/api/templates"

st.set_page_config(page_title="AI Devin - Control Panel", layout="wide")
st.title("AI Devin — Control Panel (Auto-Generator + Templates + File Manager + Diff & Approve)")

# Sidebar: API key and WS host
api_key = st.sidebar.text_input("API key (x-api-key)", value=st.secrets.get("api_key", ""), type="password")
headers = {}
if api_key:
    headers["X-API-KEY"] = api_key

ws_host = st.sidebar.text_input("WS host (optional)", value="")
if not ws_host:
    ws_host = API_BASE.replace("http://", "ws://").replace("https://", "wss://")
ws_url = f"{ws_host}/ws"

# Small WebSocket log panel (client-side)
components.html(f"""
  <div>
    <div style="font-family: monospace; margin-bottom:6px; color:#444;">WebSocket: <small>{ws_url}</small></div>
    <div id="log" style="height:240px; overflow:auto; background:#111; color:#ddd; padding:8px; font-family: monospace;"></div>
    <script>
      const log = (s)=>{{ const el=document.getElementById('log'); el.innerText = (new Date()).toLocaleTimeString() + ' - ' + s + '\\n' + el.innerText; }};
      try {{
        const socket = new WebSocket("{ws_url}");
        socket.onopen = ()=>log("WS OPEN");
        socket.onmessage = (evt)=>{{ try {{ const d = JSON.parse(evt.data); log(JSON.stringify(d)); }} catch(e){{ log(evt.data); }} }};
        socket.onclose = ()=>log("WS CLOSED");
        socket.onerror = (e)=>log("WS ERROR " + JSON.stringify(e));
      }} catch(e) {{
        document.getElementById('log').innerText = 'WS INIT ERROR: ' + e;
      }}
    </script>
  </div>
""", height=280)

st.markdown("---")

# Helpers: API requests with headers
def get(url, params=None, timeout=20):
    return requests.get(url, params=params, timeout=timeout, headers=headers)

def post(url, json_body=None, timeout=30):
    return requests.post(url, json=json_body, timeout=timeout, headers=headers)

def delete(url, params=None, timeout=20):
    return requests.delete(url, params=params, timeout=timeout, headers=headers)

# Templates fetch & mapping
def fetch_templates():
    try:
        r = get(API_TEMPLATES)
        if r.ok:
            return r.json().get("templates", [])
    except Exception:
        return []
    return []

templates = fetch_templates()
template_options = ["(none)"]
template_map = {"(none)": None}
for t in templates:
    tid = t.get("_id")
    if isinstance(tid, dict) and "$oid" in tid:
        tid_str = tid["$oid"]
    else:
        tid_str = str(tid)
    label = f"{t.get('name')} — {t.get('description','')[:80]} ({tid_str[:8]})"
    template_options.append(label)
    template_map[label] = tid_str

# Tasks fetch & mapping
def fetch_tasks():
    try:
        r = get(f"{API_TASKS}/tasks", timeout=20)
        if r.ok:
            return r.json().get("tasks", [])
    except Exception:
        return []
    return []

tasks = fetch_tasks()
task_options = ["Workspace root (global)"]
task_map = {"Workspace root (global)": None}
for t in tasks:
    tid = t.get("_id")
    if isinstance(tid, dict) and "$oid" in tid:
        tid_str = tid["$oid"]
    else:
        tid_str = str(tid)
    label = f"{tid_str[:8]} | {t.get('status')} | {t.get('prompt')[:50]}"
    task_options.append(label)
    task_map[label] = tid_str

# Layout: left column = templates & task create & auto-generator, right = file manager / editor / progress
col_left, col_right = st.columns([1, 2])

with col_left:
    st.header("Create Task (Templates)")
    tpl_choice = st.selectbox("Choose a template", options=template_options, index=0)
    selected_tpl_id = template_map.get(tpl_choice)

    # Initialize session fields if missing
    if "prompt_field" not in st.session_state:
        st.session_state["prompt_field"] = "Fix failing tests in module X"
    if "owner_field" not in st.session_state:
        st.session_state["owner_field"] = ""
    if "repo_field" not in st.session_state:
        st.session_state["repo_field"] = ""
    if "repourl_field" not in st.session_state:
        st.session_state["repourl_field"] = ""
    if "autopr_field" not in st.session_state:
        st.session_state["autopr_field"] = False
    if "invoker_field" not in st.session_state:
        st.session_state["invoker_field"] = ""

    prompt = st.text_area("Task prompt", value=st.session_state["prompt_field"], key="prompt_field", height=120)
    owner = st.text_input("Repo owner (for PR)", value=st.session_state["owner_field"], key="owner_field")
    repo = st.text_input("Repo name (for PR)", value=st.session_state["repo_field"], key="repo_field")
    repoUrl = st.text_input("Repo clone URL (optional)", value=st.session_state["repourl_field"], key="repourl_field")
    autoPR = st.checkbox("Auto-create PR", value=st.session_state["autopr_field"], key="autopr_field")

    if st.button("Load template"):
        if selected_tpl_id:
            r = get(f"{API_TEMPLATES}/{selected_tpl_id}")
            if r.ok:
                t = r.json().get("template", {})
                st.session_state["prompt_field"] = t.get("prompt", "")
                meta = t.get("meta", {}) or {}
                st.session_state["owner_field"] = meta.get("owner", "")
                st.session_state["repo_field"] = meta.get("repo", "")
                st.session_state["repourl_field"] = meta.get("repoUrl", "")
                defaults = t.get("defaultFields", {}) or {}
                st.session_state["autopr_field"] = bool(defaults.get("autoCreatePR", False))
                st.experimental_rerun()
            else:
                st.error("Failed to load template")
        else:
            st.warning("Select a template first")

    st.markdown("---")
    if st.button("Start task"):
        payload = {
            "prompt": st.session_state.get("prompt_field", ""),
            "workspace": "./workspace",
            "autoCreatePR": bool(st.session_state.get("autopr_field", False)),
            "meta": {
                "owner": st.session_state.get("owner_field", ""),
                "repo": st.session_state.get("repo_field", ""),
                "repoUrl": st.session_state.get("repourl_field", "")
            }
        }
        try:
            resp = post(f"{API_TASKS}/run", json_body=payload, timeout=60)
            if resp.ok:
                data = resp.json()
                st.success(f"Task created: {data.get('taskId')}")
                st.experimental_rerun()
            else:
                st.error(f"Failed to create task: {resp.text}")
        except Exception as e:
            st.error(f"Error: {e}")

    st.markdown("---")
    st.subheader("Save current form as a template")
    new_name = st.text_input("Template name", value="", key="tpl_name")
    new_description = st.text_input("Template description", value="", key="tpl_desc")
    if st.button("Save as template"):
        if not new_name or not st.session_state.get("prompt_field"):
            st.error("Template name and prompt required")
        else:
            tpl_payload = {
                "name": new_name,
                "description": new_description,
                "prompt": st.session_state.get("prompt_field"),
                "meta": {
                    "owner": st.session_state.get("owner_field", ""),
                    "repo": st.session_state.get("repo_field", ""),
                    "repoUrl": st.session_state.get("repourl_field", "")
                },
                "defaultFields": {
                    "autoCreatePR": bool(st.session_state.get("autopr_field", False))
                },
                "createdBy": "ui"
            }
            rr = post(API_TEMPLATES, json_body=tpl_payload)
            if rr.ok:
                st.success("Template saved")
                st.experimental_rerun()
            else:
                st.error(f"Failed to save template: {rr.text}")

    st.markdown("---")
    st.header("Auto-generate (Module-by-module)")
    st.markdown("Planner will create a module plan; then modules are generated, committed, and tested one-by-one.")

    # select task for auto-generation
    auto_task_choice = st.selectbox("Task to auto-generate into", options=task_options, index=0, key="auto_task_choice")
    auto_task_id = task_map.get(auto_task_choice)

    max_modules = st.number_input("Max modules per run (batch size)", min_value=1, max_value=20, value=3, key="max_modules")
    chunk_lines = st.number_input("Target lines per module (estimator)", min_value=100, max_value=2000, value=500, key="chunk_lines")
    token_cost = st.number_input("Token cost USD per 1k (est)", min_value=0.0, value=0.03, step=0.01, key="token_cost")

    st.markdown("### Dry-run / Estimate")
    if st.button("Plan & estimate (dry-run)", key="plan_estimate"):
        if not auto_task_id:
            st.warning("Select a task workspace first.")
        else:
            r = post(f"{API_ACTIONS}/start-auto", json_body={"taskId": auto_task_id, "dryRun": True, "maxModulesPerRun": max_modules})
            if r.ok:
                data = r.json()
                plan = data.get("plan", [])
                estimate = data.get("estimate", {})
                st.success(f"Planner produced {len(plan)} modules")
                st.json({ "planSample": plan[:6], "estimate": estimate })
                total_lines = sum([m.get("targetLines", chunk_lines) for m in plan])
                approx_chars = total_lines * 40
                tokens = ceil(approx_chars / 4)
                cost = (tokens / 1000.0) * token_cost
                st.write(f"Estimated modules: {len(plan)}, estimated tokens: {tokens}, estimated cost: ${cost:.4f}")
            else:
                st.error(f"Failed: {r.text}")

    st.markdown("---")
    st.markdown("### Run controls")
    col_run, col_stop = st.columns(2)
    with col_run:
        if st.button("Start auto-generate (run)", key="start_auto"):
            if not auto_task_id:
                st.warning("Select a task workspace first.")
            else:
                payload = {
                    "taskId": auto_task_id,
                    "dryRun": False,
                    "maxModulesPerRun": max_modules,
                    "gitleaksEnabled": True,
                    "failOnSecrets": True,
                    "runLint": True,
                    "failOnLint": False,
                    "invokedBy": st.session_state.get("invoker_field", "") or "ui"
                }
                r = post(f"{API_ACTIONS}/start-auto", json_body=payload, timeout=30)
                if r.ok:
                    st.success("Auto-generation started (runs in background); poll status below.")
                else:
                    st.error(f"Failed to start: {r.text}")
    with col_stop:
        if st.button("Stop auto-generate", key="stop_auto"):
            if not auto_task_id:
                st.warning("Select a task workspace first.")
            else:
                r = post(f"{API_ACTIONS}/stop-auto", json_body={"taskId": auto_task_id, "invokedBy": st.session_state.get("invoker_field", "") or "ui"})
                if r.ok:
                    st.success("Stop requested")
                else:
                    st.error(f"Failed to stop: {r.text}")

    st.markdown("---")
    st.markdown("### Resume failed or specific modules")
    st.write("Provide comma-separated module indices (0-based) to retry specific modules, or leave empty to resume from first failed/pending module.")
    resume_indices_input = st.text_input("Module indices (e.g. 2,5,7)", value="", key="resume_indices")
    invoker = st.text_input("Invoker name (optional, recorded in audit)", value=st.session_state.get("invoker_field", ""), key="invoker_field")
    if st.button("Resume modules", key="resume_btn"):
        if not auto_task_id:
            st.warning("Select a task workspace first.")
        else:
            payload = {"taskId": auto_task_id, "maxModulesPerRun": max_modules, "gitleaksEnabled": True, "runLint": True, "failOnSecrets": True, "invokedBy": invoker or "ui"}
            if resume_indices_input.strip():
                try:
                    idxs = [int(x.strip()) for x in resume_indices_input.split(",") if x.strip() != ""]
                    payload["moduleIndices"] = idxs
                except Exception:
                    st.error("Invalid indices format. Use comma-separated integers.")
                    idxs = None
            r = post(f"{API_ACTIONS}/resume-auto", json_body=payload, timeout=30)
            if r.ok:
                st.success("Resume request submitted; background processing will run.")
                st.json(r.json())
            else:
                st.error(f"Failed to resume: {r.text}")

with col_right:
    st.header("File Manager & Editor / Progress Dashboard")
    # Workspace selector for file manager
    workspace_choice = st.selectbox("Workspace", options=task_options, index=0, key="workspace_file_mgr")
    selected_task_id = task_map.get(workspace_choice)

    # Directory browsing
    current_dir = st.text_input("Directory (relative to workspace)", value="", key="current_dir_full")

    def list_files(path="", taskId=None):
        try:
            params = {"path": path}
            if taskId:
                params["taskId"] = taskId
            r = get(f"{API_FILES}/files", params=params, timeout=20)
            if r.ok:
                data = r.json()
                return data.get("list", []), data.get("workspace"), data.get("taskId")
        except Exception as e:
            st.error(f"Error listing files: {e}")
        return [], None, None

    items, workspace_path, ws_task = list_files(current_dir, selected_task_id)
    dirs = [it for it in items if it["type"] == "dir"]
    files = [it for it in items if it["type"] == "file"]

    st.markdown("### Folders")
    for d in dirs:
        if st.button(f"Open: {d['name']}", key=f"open_full_{d['name']}"):
            if current_dir:
                current_dir = f"{current_dir.rstrip('/')}/{d['name']}"
            else:
                current_dir = d['name']
            st.session_state["current_dir_full"] = current_dir
            st.experimental_rerun()

    st.markdown("### Files")
    file_choice = None
    if files:
        file_names = [f["name"] for f in files]
        file_choice = st.selectbox("Open file", options=file_names, index=0, key="file_choice_full")
    else:
        st.info("No files in this folder.")

    st.markdown("---")
    new_file_name = st.text_input("New file path (relative)", value="", key="new_file_full")
    if st.button("Create empty file", key="create_file_full"):
        if new_file_name:
            target = f"{(current_dir.rstrip('/') + '/' + new_file_name).lstrip('/')}"
            payload = {"path": target, "content": "", "taskId": selected_task_id}
            r = post(f"{API_FILES}/file", json_body=payload)
            if r.ok:
                st.success("File created")
                st.experimental_rerun()
            else:
                st.error(f"Failed: {r.text}")

    new_folder_name = st.text_input("New folder name (relative)", value="", key="new_folder_full")
    if st.button("Create folder", key="create_folder_full"):
        target = f"{(current_dir.rstrip('/') + '/' + new_folder_name).lstrip('/')}"
        r = post(f"{API_FILES}/folder", json_body={"path": target, "taskId": selected_task_id})
        if r.ok:
            st.success("Folder created")
            st.experimental_rerun()
        else:
            st.error(f"Failed: {r.text}")

    if file_choice:
        if st.button("Delete selected file", key="delete_file_full"):
            target = (current_dir.rstrip('/') + "/" + file_choice).lstrip('/')
            r = delete(f"{API_FILES}/file", params={"path": target, "taskId": selected_task_id})
            if r.ok:
                st.success("Deleted")
                st.experimental_rerun()
            else:
                st.error(f"Delete failed: {r.text}")

    st.markdown("---")
    st.subheader("Editor & Diff / Approve / Undo")
    selected_file = None
    if "current_dir_full" in st.session_state:
        current_dir_val = st.session_state["current_dir_full"]
    else:
        current_dir_val = current_dir

    if file_choice:
        selected_file = (current_dir_val.rstrip('/') + "/" + file_choice).lstrip('/')
    if selected_file:
        # Read file
        try:
            params = {"path": selected_file}
            if selected_task_id:
                params["taskId"] = selected_task_id
            r = get(f"{API_FILES}/file", params=params, timeout=20)
            if r.ok:
                content = r.json().get("content", "")
            else:
                content = ""
                st.error("Failed to read file")
        except Exception as e:
            content = ""
            st.error(f"Error reading file: {e}")

        mode = "python" if selected_file.endswith(".py") else "javascript"
        editor_content = st_ace(value=content, language=mode, theme="monokai", key=f"ace_full_{selected_file}", height=360)
        if st.button("Save file", key=f"save_{selected_file}"):
            payload = {"path": selected_file, "content": editor_content, "taskId": selected_task_id, "commitMessage": f"Edit {selected_file}"}
            r = post(f"{API_FILES}/file", json_body=payload, timeout=30)
            if r.ok:
                st.success("Saved")
            else:
                st.error(f"Save failed: {r.text}")

        st.markdown("---")
        st.markdown("### Side-by-side file diff (base vs current)")
        base_branch = st.text_input("Base branch for diff", value=st.secrets.get("default_branch", "main"), key=f"base_branch_{selected_file}")
        if st.button("Show file diff (side-by-side)", key=f"filediff_{selected_file}"):
            if not selected_task_id:
                st.warning("Select a task workspace to show file diff.")
            else:
                try:
                    r = get(f"{API_ACTIONS}/file-diff", params={"taskId": selected_task_id, "filePath": selected_file, "base": base_branch}, timeout=30)
                    if r.ok:
                        data = r.json()
                        baseContent = data.get("baseContent", "")
                        currentContent = data.get("currentContent", "")
                        hd = difflib.HtmlDiff(tabsize=4, wrapcolumn=80)
                        table = hd.make_table(baseContent.splitlines(), currentContent.splitlines(),
                                              fromdesc=f"{base_branch}:{selected_file}", todesc=f"workspace:{selected_file}", context=True, numlines=3)
                        components.html(table, height=600, scrolling=True)
                    else:
                        st.error(f"Failed to get file diff: {r.text}")
                except Exception as e:
                    st.error(f"Error fetching file diff: {e}")

        st.markdown("### Scan diff for secrets")
        if st.button("Scan workspace diff for secrets", key=f"scan_{selected_file}"):
            if not selected_task_id:
                st.warning("Select a task workspace to scan.")
            else:
                try:
                    r = get(f"{API_ACTIONS}/scan", params={"taskId": selected_task_id, "base": base_branch}, timeout=30)
                    if r.ok:
                        data = r.json()
                        findings = data.get("gitleaksFindings", []) or []
                        if findings:
                            st.error("Secrets detected! Review findings below and do NOT approve until fixed.")
                            for f in findings:
                                st.write(f)
                        else:
                            st.success("No obvious secrets detected in the diff.")
                    else:
                        st.error(f"Scan failed: {r.text}")
                except Exception as e:
                    st.error(f"Error scanning: {e}")

        st.markdown("---")
        st.markdown("### Approve & Create PR (blocked if secrets found unless override)")
        pr_title = st.text_input("PR Title", value=f"AI: changes for task {selected_task_id}", key=f"pr_title_{selected_file}")
        pr_body = st.text_area("PR Body", value=f"Automated PR created by AI Devin for task {selected_task_id}", key=f"pr_body_{selected_file}")
        override_allowed = st.checkbox("Override secret-blocking (I understand the risks)", value=False, key=f"override_{selected_file}")
        if st.button("Approve & Create PR", key=f"approve_{selected_file}"):
            if not selected_task_id:
                st.warning("Select a task workspace to approve.")
            else:
                payload = {"taskId": selected_task_id, "title": pr_title, "body": pr_body, "overrideSecrets": bool(override_allowed)}
                try:
                    r = post(f"{API_ACTIONS}/approve", json_body=payload, timeout=60)
                    if r.ok:
                        j = r.json()
                        pr_url = j.get("prUrl")
                        if pr_url:
                            st.success(f"PR created: {pr_url}")
                            st.write(pr_url)
                        else:
                            st.success("Approve flow completed")
                            st.json(j)
                    else:
                        st.error(f"Approve failed: {r.text}")
                        try:
                            st.json(r.json())
                        except:
                            pass
                except Exception as e:
                    st.error(f"Error during approve: {e}")

        st.markdown("---")
        st.markdown("### Undo / Revert task workspace branch")
        if st.button("Undo / Revert branch to base", key=f"undo_{selected_file}"):
            if not selected_task_id:
                st.warning("Select a task workspace to revert.")
            else:
                try:
                    payload = {"taskId": selected_task_id, "base": base_branch}
                    r = post(f"{API_ACTIONS}/undo", json_body=payload, timeout=60)
                    if r.ok:
                        st.success("Undo completed")
                        st.json(r.json())
                    else:
                        st.error(f"Undo failed: {r.text}")
                except Exception as e:
                    st.error(f"Error during undo: {e}")

    else:
        st.info("Select a file from the left to open it in the editor.")

    st.markdown("---")
    st.header("Progress Dashboard")
    inspect_choice = st.selectbox("Inspect task for progress", options=task_options, index=0, key="inspect_task")
    inspect_task_id = task_map.get(inspect_choice)

    if inspect_task_id:
        try:
            r = get(f"{API_TASKS}/{inspect_task_id}", timeout=20)
            if r.ok:
                task_detail = r.json().get("task", {})
            else:
                st.error("Failed to fetch task details")
                task_detail = {}
        except Exception as e:
            st.error(f"Error: {e}")
            task_detail = {}

        plan = task_detail.get("modulePlan") or []
        statuses = task_detail.get("moduleStatuses") or []
        total = len(plan)
        succeeded = len([s for s in statuses if s.get("status") == "succeeded"])
        failed = len([s for s in statuses if s.get("status") == "failed"])
        pending = len([s for s in statuses if s.get("status") == "pending"])
        running = len([s for s in statuses if s.get("status") == "running"])
        st.markdown(f"**Modules**: {total} — succeeded: {succeeded}, running: {running}, failed: {failed}, pending: {pending}")
        progress = (succeeded / total) * 100 if total else 0
        st.progress(progress / 100.0)

        st.markdown("### Modules")
        for idx, m in enumerate(plan):
            st.markdown(f"**{idx+1}. {m.get('name')}** — {m.get('description','')[:200]}")
            st.write(f"targetLines: {m.get('targetLines', 'n/a')}, path: {m.get('path','-')}")
            st.write(f"status: { (statuses[idx]['status'] if idx < len(statuses) else 'unknown') }")
            col_a, col_b, col_c = st.columns([1,1,1])
            with col_a:
                if st.button(f"Show diff for module {idx+1}", key=f"diff_mod_{idx}"):
                    try:
                        r = get(f"{API_ACTIONS}/diff", params={"taskId": inspect_task_id})
                        if r.ok:
                            diff = r.json().get("diff","(no diff)")
                            st.code(diff, language="diff")
                        else:
                            st.error("Failed to get diff")
                    except Exception as e:
                        st.error(f"Error: {e}")
            with col_b:
                if st.button(f"Show module log", key=f"log_mod_{idx}"):
                    try:
                        r2 = get(f"{API_TASKS}/{inspect_task_id}")
                        if r2.ok:
                            t = r2.json().get("task", {})
                            steps = t.get("steps", [])
                            targetPrefix = f"ci:{m.get('name')}"
                            found = None
                            for s in reversed(steps):
                                if s.get("name","").startswith(targetPrefix):
                                    found = s
                                    break
                            if found:
                                st.code(found.get("output","(no output)"), language="text")
                            else:
                                st.info("No CI step found yet for module")
                        else:
                            st.error("Failed to fetch task steps")
                    except Exception as e:
                        st.error(f"Error: {e}")
            with col_c:
                # Resume this module button: calls resume-auto for the single module index
                if st.button(f"Resume this module", key=f"resume_mod_{idx}"):
                    invoker_val = st.session_state.get("invoker_field", "") or "ui"
                    payload = {
                        "taskId": inspect_task_id,
                        "moduleIndices": [idx],
                        "maxModulesPerRun": 1,
                        "gitleaksEnabled": True,
                        "runLint": True,
                        "failOnSecrets": True,
                        "invokedBy": invoker_val
                    }
                    try:
                        r = post(f"{API_ACTIONS}/resume-auto", json_body=payload, timeout=30)
                        if r.ok:
                            st.success(f"Resume requested for module {idx}")
                            st.json(r.json())
                        else:
                            st.error(f"Failed to request resume: {r.text}")
                    except Exception as e:
                        st.error(f"Error requesting resume: {e}")
    else:
        st.info("Select a task to see module plan & progress.")
