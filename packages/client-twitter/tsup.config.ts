import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ["@elizaos/core"],
    esbuildOptions(options) {
        options.resolveExtensions = ['.ts', '.js'];
    }
});
