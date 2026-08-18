import vue from "@vitejs/plugin-vue";
import frappeui from "frappe-ui/vite";
import { defineConfig } from "vite";

// Dev: run editor/server.py first, then EDITOR_API=http://127.0.0.1:<port> yarn dev.
export default defineConfig({
  plugins: [
    frappeui({
      lucideIcons: true,
      frappeProxy: false,
      jinjaBootData: false,
      buildConfig: false,
    }),
    vue(),
  ],
  server: {
    proxy: {
      "/api": { target: process.env.EDITOR_API || "http://127.0.0.1:8000" },
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
});
