import { defineConfig } from "vite";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  clearScreen: false,
  appType: 'mpa',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        ql:   resolve(__dirname, "ql.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  // Force plain JS loader for all .js files — prevents import-analysis from
  // misidentifying HTML template literals inside backticks as JSX syntax.
  plugins: [
    {
      name: "no-jsx-in-js",
      enforce: "pre",
      transform(code, id) {
        // Return code as-is for .js files — skip Vite's JSX transform entirely
        if (id.endsWith(".js") && !id.endsWith(".jsx")) {
          return { code, map: null };
        }
      },
    },
  ],
  optimizeDeps: {
    esbuildOptions: {
      loader: { ".js": "js" },
    },
  },
}));
