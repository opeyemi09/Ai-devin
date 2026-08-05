import streamlit as st
import requests
import time

API_BASE = st.secrets.get("api_base", "http://localhost:3000")

st.set_page_config(page_title="AI Devin - Control Panel", layout="wide")
st.title("AI Devin — Control Panel (JS backend)")

with st.expander("Create Task"):
    prompt = st.text_area("Task prompt", "Fix failing tests in module X")
    owner = st.text_input("Repo owner (for PR)", "")
    repo = st.text_input("Repo name (for PR)", "")
    autoPR = st.checkbox("Auto-create PR", value=False)
    submit = st.button("Start task")
    if submit:
        payload = {"prompt": prompt, "workspace": "./workspace", "autoCreatePR": autoPR, "meta": {"owner": owner, "repo": repo}}
        try:
            resp = requests.post(f"{API_BASE}/run", json=payload, timeout=60)
            if resp.ok:
                data = resp.json()
                st.success(f"Task created: {data.get('taskId')}")
            else:
                st.error(f"Failed to create task: {resp.text}")
        except Exception as e:
            st.error(f"Error: {e}")

st.markdown("---")
st.header("Task history")

col1, col2 = st.columns([1, 2])

with col1:
    # fetch tasks
    try:
        resp = requests.get(f"{API_BASE}/tasks", timeout=30)
        tasks = resp.json().get("tasks", []) if resp.ok else []
    except Exception as e:
        st.error(f"Failed to fetch tasks: {e}")
        tasks = []

    selected = None
    if tasks:
        # show simplified list
        labels = [f"{t._id['$oid'][:8]} | {t.status} | {t.prompt[:60]}" for t in tasks]
        choice = st.selectbox("Select task", options=list(range(len(tasks))), format_func=lambda i: labels[i])
        selected = tasks[choice]

    if not tasks:
        st.info("No tasks yet. Create one above.")

with col2:
    if selected:
        taskId = selected["_id"]["$oid"]
        st.subheader(f"Task {taskId}")
        # fetch detail
        try:
            det = requests.get(f"{API_BASE}/tasks/{taskId}", timeout=30)
            if det.ok:
                task = det.json().get("task", {})
                st.markdown(f"**Status:** {task.get('status')}")
                st.markdown(f"**Prompt:** {task.get('prompt')}")
                st.markdown(f"**CreatedAt:** {task.get('createdAt')}")
                st.markdown("### Steps")
                steps = task.get("steps", [])
                if steps:
                    for s in steps:
                        st.markdown(f"**{s.get('name')}** — {s.get('timestamp')}")
                        st.code(s.get("output") or "(no output)", language="text")
                else:
                    st.info("No step logs yet.")
                st.markdown("### Result / Metadata")
                st.json(task.get("result", {}))
            else:
                st.error("Failed to fetch task details")
        except Exception as e:
            st.error(f"Error: {e}")
    else:
        st.info("Select a task to see details")
