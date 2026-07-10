import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from the root of the Cloudflare Workers domain.
// (The old GitHub Pages deployment needed base: "/reef-tank/"; the
// deploy:github script passes that on the command line if ever needed.)
export default defineConfig({
  plugins: [react()],
  base: "/",
});
