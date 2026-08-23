import { type AgentsState, claudeAgents } from "./model/claude-agents";
import { type SessionDetails, sessionDetails } from "./model/session-details";

function detailLine(details: SessionDetails | undefined): string {
  if (details === undefined) {
    return "…";
  }
  const parts: string[] = [];
  if (details.shells.running > 0) {
    parts.push(
      `${details.shells.running} shell${details.shells.running === 1 ? "" : "s"}`,
    );
  }
  if (details.subagentCount > 0) {
    parts.push(
      `${details.subagentCount} agent${details.subagentCount === 1 ? "" : "s"}`,
    );
  }
  if (details.tasks.total > 0) {
    parts.push(`tasks ${details.tasks.completed}/${details.tasks.total}`);
  }
  return parts.join(" · ");
}

function renderAgents(
  list: HTMLElement,
  state: AgentsState,
  details: Map<string, SessionDetails>,
): void {
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

    const info = document.createElement("div");
    info.className = "info";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = agent.name;
    name.title = agent.cwd;
    info.append(name);

    const line = detailLine(details.get(agent.sessionId));
    if (line !== "") {
      const detail = document.createElement("div");
      detail.className = "detail";
      detail.textContent = line;
      info.append(detail);
    }

    const status = document.createElement("span");
    status.className = `status status-${agent.status}`;
    status.textContent = agent.status;

    item.append(info, status);
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

  const rerender = (): void => {
    renderAgents(list, claudeAgents.state, sessionDetails.details);
  };
  claudeAgents.subscribe(rerender);
  sessionDetails.subscribe(rerender);
  claudeAgents.start(3000);
  sessionDetails.start(3000);
}

const app = document.getElementById("app");
if (app) {
  render(app);
}
