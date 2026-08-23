import { claudeAgents } from "./model/claude-agents";

// Temporary smoke test of the model layer; replace with real UI.
async function renderProbe(root: HTMLElement): Promise<void> {
  const line = document.createElement("p");
  line.textContent = "probing sessions…";
  root.append(line);
  try {
    const agents = await claudeAgents.probe();
    const summary = agents
      .map((a) => `${a.name} (${a.status})`)
      .join(", ");
    line.textContent = `${agents.length} session(s): ${summary}`;
  } catch (error) {
    line.textContent = `probe failed: ${String(error)}`;
  }
}

function render(root: HTMLElement): void {
  const heading = document.createElement("h1");
  heading.textContent = "Hello from Dask";

  const paragraph = document.createElement("p");
  paragraph.textContent =
    "This is a Tauri window rendering a Vite + TypeScript frontend. " +
    "Press ⌘⇧D anywhere to toggle this window.";

  root.append(heading, paragraph);
  void renderProbe(root);
}

const app = document.getElementById("app");
if (app) {
  render(app);
}
