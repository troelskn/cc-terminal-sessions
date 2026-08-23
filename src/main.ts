function render(root: HTMLElement): void {
  const heading = document.createElement("h1");
  heading.textContent = "Hello from Dask";

  const paragraph = document.createElement("p");
  paragraph.textContent =
    "This is a Tauri window rendering a Vite + TypeScript frontend. " +
    "Press ⌘⇧D anywhere to toggle this window.";

  root.append(heading, paragraph);
}

const app = document.getElementById("app");
if (app) {
  render(app);
}
