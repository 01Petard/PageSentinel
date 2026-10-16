import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  root: "client",
  plugins: [vue()],
  build: { outDir: "../dist/client", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
