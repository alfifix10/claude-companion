import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default: plain node (no DOM). UI component tests can override
    // per-file with /** @vitest-environment jsdom */ once we get there.
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
    // Fail CI on anything that prints to console.error — helps catch
    // accidental uses of the old global logger pattern during migration.
    onConsoleLog(log, type) {
      if (type === "stderr") return false;
      return undefined;
    },
  },
});
