import { defineConfig } from "vite";

export default defineConfig({
  // Tauri expects a fixed dev-server address and handles its own clearing
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
});
