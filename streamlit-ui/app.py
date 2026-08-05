import streamlit as st
import requests
from streamlit_ace import st_ace

API_BASE = st.secrets.get("api_base", "http://localhost:3000")
API_FILES = f"{API_BASE}/api"
API_TASKS = f"{API_BASE}"

st.set_page_config(page_title="AI Devin - Control Panel", layout="wide")
st.title("AI Devin — Control Panel (File Manager + Code Editor)")

# --- Task creation section (unchanged) ---
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
            resp = requests.post(f"{API_TASKS}/run", json=payload, timeout=60)
            if resp.ok:
                data = resp.json()
                st.success(f"Task created: {data.get('taskId')}")
            else:
                st.error(f"Failed to create task: {resp.text}")
        except Exception as e:
            st.error(f"Error: {e}")

st.markdown("---")

# --- File Manager / Editor with workspace selection ---
st.header("File Manager & Code Editor")
col1, col2 = st.columns([1, 3])

# fetch tasks for workspace selection
def fetch_tasks():
    try:
        r = requests.get(f"{API_TASKS}/tasks", timeout=20)
        if r.ok:
            return r.json().get("tasks", [])
    except Exception:
        return []
    return []

tasks = fetch_tasks()
task_options = ["Workspace root (global)"]
task_map = { "Workspace root (global)": None }
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

    # list files in selected workspace
    def list_files(path="", taskId=None):
        try:
            params = {"path": path}
            if taskId:
                params["taskId"] = taskId
            r = requests.get(f"{API_FILES}/files", params=params, timeout=20)
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
            r = requests.post(f"{API_FILES}/file", json=payload)
            if r.ok:
                st.success("File created")
                st.experimental_rerun()
            else:
                st.error(f"Failed: {r.text}")

    new_folder_name = st.text_input("New folder name (relative)", value="", key="new_folder")
    if st.button("Create folder"):
        target = f"{(current_dir.rstrip('/') + '/' + new_folder_name).lstrip('/')}"
        r = requests.post(f"{API_FILES}/folder", json={"path": target, "taskId": selected_task_id})
        if r.ok:
            st.success("Folder created")
            st.experimental_rerun()
        else:
            st.error(f"Failed: {r.text}")

    if file_choice:
        if st.button("Delete selected file"):
            target = (current_dir.rstrip('/') + "/" + file_choice).lstrip('/')
            r = requests.delete(f"{API_FILES}/file", params={"path": target, "taskId": selected_task_id})
            if r.ok:
                st.success("Deleted")
                st.experimental_rerun()
            else:
                st.error(f"Delete failed: {r.text}")

with col2:
    st.subheader("Editor")
    selected_file = None
    if "current_dir" in st.session_state:
        current_dir = st.session_state["current_dir"]
    else:
        current_dir = current_dir

    if 'file_choice' in locals() and file_choice:
        selected_file = (current_dir.rstrip('/') + "/" + file_choice).lstrip('/')
    if selected_file:
        # read file via API with optional taskId
        try:
            params = {"path": selected_file}
            if selected_task_id:
                params["taskId"] = selected_task_id
            r = requests.get(f"{API_FILES}/file", params=params, timeout=20)
            if r.ok:
                content = r.json().get("content", "")
            else:
                content = ""
                st.error("Failed to read file")
        except Exception as e:
            content = ""
            st.error(f"Error reading file: {e}")

        mode = "python" if selected_file.endswith(".py") else "javascript"
        editor_content = st_ace(value=content, language=mode, theme="monokai", key="ace_editor", height=600)
        if st.button("Save file"):
            payload = {"path": selected_file, "content": editor_content, "taskId": selected_task_id, "commitMessage": f"Edit {selected_file}"}
            r = requests.post(f"{API_FILES}/file", json=payload, timeout=20)
            if r.ok:
                st.success("Saved")
            else:
                st.error(f"Save failed: {r.text}")
    else:
        st.info("Select a file from the left to open it in the editor.")
