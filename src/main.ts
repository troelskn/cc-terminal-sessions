import { type AgentsState, claudeAgents } from "./model/claude-agents";

function renderAgents(list: HTMLElement, state: AgentsState): void {
  list.replaceChildren();

  if (state.error !== null) {
    const error = document.createElement("li");
    error.className = "error";
    error.textContent = state.error;
    list.append(error);
  }

  if (state.agents.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "no active sessions";
    list.append(empty);
    return;
  }

  for (const agent of state.agents) {
    const item = document.createElement("li");
    item.className = "agent";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = agent.name;
    name.title = agent.cwd;

    const status = document.createElement("span");
    status.className = `status status-${agent.status}`;
    status.textContent = agent.status;

    item.append(name, status);
    list.append(item);
  }
}

function render(root: HTMLElement): void {
  const heading = document.createElement("h1");
  heading.textContent = "Dask";

  const list = document.createElement("ul");
  list.className = "agents";

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "⌘⇧D toggles this window";

  root.append(heading, list, hint);

  claudeAgents.subscribe((state) => renderAgents(list, state));
  claudeAgents.start(3000);
}

const app = document.getElementById("app");
if (app) {
  render(app);
}
