import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "dashboard",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
});
