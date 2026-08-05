# streamlit-ui/app.py
import streamlit as st
import requests
from streamlit_ace import st_ace
import difflib
import streamlit.components.v1 as components
import time
import json

API_BASE = st.secrets.get("api_base", "http://localhost:3000")
API_FILES = f"{API_BASE}/api"
API_TASKS = f"{API_BASE}"
API_ACTIONS = f"{API_BASE}/api/actions"

st.set_page_config(page_title="AI Devin - Control Panel", layout="wide")
st.title("AI Devin — Control Panel (Live + Diff & Approve + Undo)")

# API key input (for protected server)
api_key = st.sidebar.text_input("API key (x-api-key)", value=st.secrets.get("api_key", ""), type="password")
headers = {}
if api_key:
    headers["X-API-KEY"] = api_key

# Live event panel (WebSocket)
st.sidebar.markdown("### Live events")
ws_host = st.sidebar.text_input("WS host (auto)", value="")
if not ws_host:
    ws_host = API_BASE.replace("http://", "ws://").replace("https://", "wss://")
ws_url = f"{ws_host}/ws"

# Embed a small websocket client that displays events
components.html(f"""
  <div>
    <div id="log" style="height:300px; overflow:auto; background:#111; color:#ddd; padding:8px; font-family: monospace;"></div>
    <script>
      const log = (s)=>{{ const el=document.getElementById('log'); el.innerText = (new Date()).toLocaleTimeString() + ' - ' + s + '\\n' + el.innerText; }};
      let socket = null;
      try {{
        socket = new WebSocket("{ws_url}");
        socket.onopen = ()=>log("WS OPEN {ws_url}");
        socket.onmessage = (evt)=>{{ 
          try {{ const d = JSON.parse(evt.data); log(JSON.stringify(d)); }} catch(e){{ log(evt.data); }} 
        }};
        socket.onclose = ()=>log("WS CLOSED");
        socket.onerror = (e)=>log("WS ERROR " + JSON.stringify(e));
      }} catch(e) {{ document.getElementById('log').innerText = 'WS INIT ERROR: ' + e; }}
    </script>
  </div>
""", height=330)

st.markdown("---")

# --- Task creation ---
with st.expander("Create Task", expanded=False):
    prompt = st.text_area("Task prompt", "Fix failing tests in module X")
    owner = st.text_input("Repo owner (for PR)", "")
    repo = st.text_input("Repo name (for PR)", "")
    repoUrl = st.text_input("Repo clone URL (optional)", "")
    autoPR = st.checkbox("Auto-create PR", value=False)
    submit = st.button("Start task")
    if submit:
        payload = {"prompt": prompt, "workspace": "./workspace", "autoCreatePR": autoPR, "meta": {"owner": owner, "repo": repo, "repoUrl": repoUrl}}
        try:
            resp = requests.post(f"{API_TASKS}/run", json=payload, timeout=60, headers=headers)
            if resp.ok:
                data = resp.json()
                st.success(f"Task created: {data.get('taskId')}")
            else:
                st.error(f"Failed to create task: {resp.text}")
        except Exception as e:
            st.error(f"Error: {e}")

st.markdown("---")

# --- Workspace + File Manager ---
st.header("Workspace / File Manager / Editor")
col1, col2 = st.columns([1, 3])

# fetch tasks
def fetch_tasks():
    try:
        r = requests.get(f"{API_TASKS}/tasks", timeout=20, headers=headers)
        if r.ok:
            return r.json().get("tasks", [])
    except Exception:
        return []
    return []

tasks = fetch_tasks()
task_options = ["Workspace root (global)"]
task_map = {"Workspace root (global)": None}
for t in tasks:
    tid = t["_id"]["$oid"] if "_id" in t and "$oid" in t["_id"] else str(t.get("_id"))
    label = f"{tid[:8]} | {t.get('status')} | {t.get('prompt')[:50]}"
    task_options.append(label)
    task_map[label] = tid

with col1:
    st.subheader("Workspace Selector")
    selection = st.selectbox("Choose workspace", options=task_options, index=0)
    selected_task_id = task_map.get(selection)

    st.markdown("### Browse")
    current_dir = st.text_input("Directory (relative to workspace)", value="", key="current_dir")

    def list_files(path="", taskId=None):
        try:
            params = {"path": path}
            if taskId:
                params["taskId"] = taskId
            r = requests.get(f"{API_FILES}/files", params=params, timeout=20, headers=headers)
            if r.ok:
                data = r.json()
                return data.get("list", []), data.get("workspace"), data.get("taskId")
        except Exception as e:
            st.error(f"Error listing files: {e}")
        return [], None, None

    items, workspace_path, ws_task = list_files(current_dir, selected_task_id)
    dirs = [it for it in items if it["type"] == "dir"]
    files = [it for it in items if it["type"] == "file"]

    st.markdown("#### Folders")
    for d in dirs:
        if st.button(f"Open: {d['name']}", key=f"open_{d['name']}"):
            if current_dir:
                current_dir = f"{current_dir.rstrip('/')}/{d['name']}"
            else:
                current_dir = d['name']
            st.session_state["current_dir"] = current_dir
            st.experimental_rerun()

    st.markdown("#### Files")
    file_choice = None
    if files:
        file_names = [f["name"] for f in files]
        file_choice = st.selectbox("Open file", options=file_names, index=0)
    else:
        st.info("No files in this folder.")

    st.markdown("---")
    new_file_name = st.text_input("New file path (relative)", value="", key="new_file")
    if st.button("Create empty file"):
        if new_file_name:
            target = f"{(current_dir.rstrip('/') + '/' + new_file_name).lstrip('/')}"
            payload = {"path": target, "content": "", "taskId": selected_task_id}
            r = requests.post(f"{API_FILES}/file", json=payload, headers=headers)
            if r.ok:
                st.success("File created")
                st.experimental_rerun()
            else:
                st.error(f"Failed: {r.text}")

    new_folder_name = st.text_input("New folder name (relative)", value="", key="new_folder")
    if st.button("Create folder"):
        target = f"{(current_dir.rstrip('/') + '/' + new_folder_name).lstrip('/')}"
        r = requests.post(f"{API_FILES}/folder", json={"path": target, "taskId": selected_task_id}, headers=headers)
        if r.ok:
            st.success("Folder created")
            st.experimental_rerun()
        else:
            st.error(f"Failed: {r.text}")

    if file_choice:
        if st.button("Delete selected file"):
            target = (current_dir.rstrip('/') + "/" + file_choice).lstrip('/')
            r = requests.delete(f"{API_FILES}/file", params={"path": target, "taskId": selected_task_id}, headers=headers)
            if r.ok:
                st.success("Deleted")
                st.experimental_rerun()
            else:
                st.error(f"Delete failed: {r.text}")

with col2:
    st.subheader("Editor & Diff / Approve / Undo")
    selected_file = None
    if "current_dir" in st.session_state:
        current_dir = st.session_state["current_dir"]
    else:
        current_dir = current_dir

    if 'file_choice' in locals() and file_choice:
        selected_file = (current_dir.rstrip('/') + "/" + file_choice).lstrip('/')
    if selected_file:
        params = {"path": selected_file}
        if selected_task_id:
            params["taskId"] = selected_task_id
        try:
            r = requests.get(f"{API_FILES}/file", params=params, timeout=20, headers=headers)
            if r.ok:
                content = r.json().get("content", "")
            else:
                content = ""
                st.error("Failed to read file")
        except Exception as e:
            content = ""
            st.error(f"Error reading file: {e}")

        mode = "python" if selected_file.endswith(".py") else "javascript"
        editor_content = st_ace(value=content, language=mode, theme="monokai", key="ace_editor", height=300)
        if st.button("Save file"):
            payload = {"path": selected_file, "content": editor_content, "taskId": selected_task_id, "commitMessage": f"Edit {selected_file}"}
            r = requests.post(f"{API_FILES}/file", json=payload, timeout=20, headers=headers)
            if r.ok:
                st.success("Saved")
            else:
                st.error(f"Save failed: {r.text}")

        st.markdown("---")
        st.markdown("### Side-by-side file diff (base vs current)")
        base_branch = st.text_input("Base branch for diff", value=st.secrets.get("default_branch", "main"))
        if st.button("Show file diff (side-by-side)"):
            if not selected_task_id:
                st.warning("Select a task workspace to show file diff.")
            else:
                try:
                    r = requests.get(f"{API_ACTIONS}/file-diff", params={"taskId": selected_task_id, "filePath": selected_file, "base": base_branch}, timeout=30, headers=headers)
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
        if st.button("Scan workspace diff for secrets"):
            if not selected_task_id:
                st.warning("Select a task workspace to scan.")
            else:
                try:
                    r = requests.get(f"{API_ACTIONS}/scan", params={"taskId": selected_task_id, "base": base_branch}, timeout=30, headers=headers)
                    if r.ok:
                        data = r.json()
                        findings = data.get("findings", [])
                        if findings:
                            st.error("Secrets detected! Review findings below and do NOT approve until fixed.")
                            for f in findings:
                                st.write(f"Type: {f['type']}")
                                st.write(f"Matches: {f['matches']}")
                        else:
                            st.success("No obvious secrets detected in the diff.")
                    else:
                        st.error(f"Scan failed: {r.text}")
                except Exception as e:
                    st.error(f"Error scanning: {e}")

        st.markdown("---")
        st.markdown("### Approve & Create PR (blocked if secrets found unless override)")
        pr_title = st.text_input("PR Title", value=f"AI: changes for task {selected_task_id}")
        pr_body = st.text_area("PR Body", value=f"Automated PR created by AI Devin for task {selected_task_id}")
        override_allowed = st.checkbox("Override secret-blocking (I understand the risks)", value=False)
        if st.button("Approve & Create PR"):
            if not selected_task_id:
                st.warning("Select a task workspace to approve.")
            else:
                payload = {"taskId": selected_task_id, "title": pr_title, "body": pr_body, "overrideSecrets": bool(override_allowed)}
                try:
                    r = requests.post(f"{API_ACTIONS}/approve", json=payload, timeout=60, headers=headers)
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
        if st.button("Undo / Revert branch to base"):
            if not selected_task_id:
                st.warning("Select a task workspace to revert.")
            else:
                try:
                    payload = {"taskId": selected_task_id, "base": base_branch}
                    r = requests.post(f"{API_ACTIONS}/undo", json=payload, timeout=60, headers=headers)
                    if r.ok:
                        st.success("Undo completed")
                        st.json(r.json())
                    else:
                        st.error(f"Undo failed: {r.text}")
                except Exception as e:
                    st.error(f"Error during undo: {e}")

    else:
        st.info("Select a file from the left to open it in the editor.")
