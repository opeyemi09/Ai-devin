import streamlit as st
import requests
from streamlit_ace import st_ace

API_BASE = st.secrets.get("api_base", "http://localhost:3000/api")

st.set_page_config(page_title="AI Devin - Control Panel", layout="wide")
st.title("AI Devin — Control Panel (File Manager + Code Editor)")

# --- Task creation section (unchanged) ---
with st.expander("Create Task", expanded=False):
    prompt = st.text_area("Task prompt", "Fix failing tests in module X")
    owner = st.text_input("Repo owner (for PR)", "")
    repo = st.text_input("Repo name (for PR)", "")
    autoPR = st.checkbox("Auto-create PR", value=False)
    submit = st.button("Start task")
    if submit:
        payload = {"prompt": prompt, "workspace": "./workspace", "autoCreatePR": autoPR, "meta": {"owner": owner, "repo": repo}}
        try:
            resp = requests.post(f"{API_BASE.replace('/api','')}/run", json=payload, timeout=60)
            if resp.ok:
                data = resp.json()
                st.success(f"Task created: {data.get('taskId')}")
            else:
                st.error(f"Failed to create task: {resp.text}")
        except Exception as e:
            st.error(f"Error: {e}")

st.markdown("---")

# --- File Manager / Editor ---
st.header("File Manager & Code Editor")
col1, col2 = st.columns([1, 3])

# Helper functions
def list_files(path=""):
    try:
        r = requests.get(f"{API_BASE}/files", params={"path": path}, timeout=20)
        if r.ok:
            return r.json().get("list", [])
    except Exception as e:
        st.error(f"Error listing files: {e}")
    return []

def read_file(path):
    try:
        r = requests.get(f"{API_BASE}/file", params={"path": path}, timeout=20)
        if r.ok:
            return r.json().get("content", "")
    except Exception as e:
        st.error(f"Error reading file: {e}")
    return ""

def save_file(path, content):
    try:
        r = requests.post(f"{API_BASE}/file", json={"path": path, "content": content}, timeout=20)
        return r.ok, r.text
    except Exception as e:
        return False, str(e)

def create_folder(path):
    try:
        r = requests.post(f"{API_BASE}/folder", json={"path": path}, timeout=20)
        return r.ok, r.text
    except Exception as e:
        return False, str(e)

def delete_path(path):
    try:
        r = requests.delete(f"{API_BASE}/file", params={"path": path}, timeout=20)
        return r.ok, r.text
    except Exception as e:
        return False, str(e)

# Sidebar: current directory
with col1:
    st.subheader("Workspace Browser")
    current_dir = st.text_input("Directory (relative to workspace)", value="", key="current_dir")
    if st.button("Refresh", key="refresh"):
        pass  # will refresh lists below

    items = list_files(current_dir)
    dirs = [it for it in items if it["type"] == "dir"]
    files = [it for it in items if it["type"] == "file"]

    st.markdown("### Folders")
    for d in dirs:
        if st.button(f"Open: {d['name']}", key=f"open_{d['name']}"):
            # update current dir to navigate
            if current_dir:
                current_dir = f"{current_dir.rstrip('/')}/{d['name']}"
            else:
                current_dir = d['name']
            st.session_state["current_dir"] = current_dir
            st.experimental_rerun()

    st.markdown("### Files")
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
            ok, msg = save_file(f"{current_dir.rstrip('/')}/{new_file_name}".lstrip('/'), "")
            if ok:
                st.success("File created")
            else:
                st.error(f"Failed: {msg}")

    new_folder_name = st.text_input("New folder name (relative)", value="", key="new_folder")
    if st.button("Create folder"):
        target = f"{current_dir.rstrip('/')}/{new_folder_name}".lstrip('/')
        ok, msg = create_folder(target)
        if ok:
            st.success("Folder created")
        else:
            st.error(f"Failed: {msg}")

    if file_choice:
        if st.button("Delete selected file"):
            target = (current_dir.rstrip('/') + "/" + file_choice).lstrip('/')
            ok, msg = delete_path(target)
            if ok:
                st.success("Deleted")
                st.experimental_rerun()
            else:
                st.error(f"Delete failed: {msg}")

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
        content = read_file(selected_file)
        mode = "python" if selected_file.endswith(".py") else "javascript"
        editor_content = st_ace(value=content, language=mode, theme="monokai", key="ace_editor", height=600)
        if st.button("Save file"):
            ok, msg = save_file(selected_file, editor_content)
            if ok:
                st.success("Saved")
            else:
                st.error(f"Save failed: {msg}")
    else:
        st.info("Select a file from the left to open it in the editor.")
