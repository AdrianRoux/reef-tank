import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Replace 'reef-tank' below with whatever you name your GitHub repository.
// It must match exactly, including capitalisation.
export default defineConfig({
  plugins: [react()],
  base: "/reef-tank/",
});
