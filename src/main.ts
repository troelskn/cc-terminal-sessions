import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { type AgentsState, claudeAgents } from "./model/claude-agents";
import { type SessionDetails, sessionDetails } from "./model/session-details";

const MAX_WINDOW_HEIGHT = 600;
let lastFittedHeight = 0;
/** Height the OS adds around the webview (title bar); measured once. */
let chromeExtra: number | null = null;

async function resizeTo(contentHeight: number): Promise<void> {
  const win = getCurrentWindow();
  if (chromeExtra === null) {
    // Calibrate: set the size, wait for the resize to land, then compare
    // against the height the webview actually received. The difference is
    // the title bar. (Tauri's innerSize() cannot be used here — it reports
    // the requested size back, title bar included.)
    await win.setSize(new LogicalSize(window.innerWidth, contentHeight));
    await new Promise((resolve) => setTimeout(resolve, 150));
    chromeExtra = Math.max(0, contentHeight - window.innerHeight);
    if (chromeExtra === 0) {
      return;
    }
  }
  await win.setSize(
    new LogicalSize(window.innerWidth, contentHeight + chromeExtra),
  );
}

/** Resizes the window height to fit the rendered content. */
function fitWindowToContent(root: HTMLElement): void {
  requestAnimationFrame(() => {
    const height = Math.min(
      MAX_WINDOW_HEIGHT,
      Math.ceil(root.getBoundingClientRect().height),
    );
    if (height === lastFittedHeight) {
      return;
    }
    lastFittedHeight = height;
    resizeTo(height).catch((error: unknown) =>
      console.error("resize failed:", error),
    );
  });
}

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

  let focusIndex = 0;
  for (const agent of state.agents) {
    const item = document.createElement("li");
    item.className = "agent";

    const index = document.createElement("span");
    index.className = "index";
    if (agent.terminalPid === null) {
      index.textContent = "–";
    } else {
      focusIndex += 1;
      index.textContent = String(focusIndex);
      index.dataset.index = String(focusIndex);
    }
    item.append(index);

    const info = document.createElement("div");
    info.className = "info";

    const name = document.createElement("div");
    name.className = "name";
    name.title = agent.cwd;

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = agent.name;

    const auth = document.createElement("span");
    auth.className = agent.auth === "api" ? "auth auth-api" : "auth";
    auth.textContent = "•";
    auth.title = agent.auth === "api" ? "API key" : "subscription";

    name.append(label, auth);
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
  const list = document.createElement("ul");
  list.className = "agents";

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "1..N select session · ⌘⇧D toggle window";

  root.append(list, hint);

  // The whole surface drags the window; nothing in it is click-interactive.
  window.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    getCurrentWindow()
      .startDragging()
      .catch((error: unknown) => console.error("drag failed:", error));
  });

  window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (!/^[1-9]$/.test(event.key)) {
      return;
    }
    const badge = root.querySelector<HTMLElement>(
      `.agents .index[data-index="${event.key}"]`,
    );
    const focusable = claudeAgents.state.agents.filter(
      (agent) => agent.terminalPid !== null,
    );
    const agent = focusable[Number(event.key) - 1];
    if (badge === null || agent === undefined) {
      return;
    }
    badge.classList.remove("pulse");
    void badge.offsetWidth; // reflow so a rapid re-press restarts the animation
    badge.classList.add("pulse");
    claudeAgents
      .focusTerminal(agent)
      .catch((error: unknown) => console.error("focus failed:", error));
  });

  const rerender = (): void => {
    renderAgents(list, claudeAgents.state, sessionDetails.details);
    fitWindowToContent(root);
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
