import { defineConfig } from "tsup";

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    outDir: "dist",
    sourcemap: true,
    external: [
        "dotenv", // Externalize dotenv to prevent bundling
        "fs", // Externalize fs to use Node.js built-in module
        "path", // Externalize other built-ins if necessary
        "@reflink/reflink",
        "@node-llama-cpp",
        "https",
        '@elizaos/core',
        '@coral-xyz/anchor',
        'uuid',
        "http",
        "agentkeepalive",
        "safe-buffer",
        "base-x",
        "bs58",
        "borsh",
        "@solana/buffer-layout",
        "stream",
        "buffer",
        "querystring",
        "amqplib",
        // Add other modules you want to externalize
    ],
});
