import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ["out/**", "node_modules/**", "vendor/**", "media/**"] },
  {
    files: ["webview/**/*.tsx", "webview/**/*.ts"],
    languageOptions: { globals: { window: "readonly", document: "readonly", setInterval: "readonly", clearInterval: "readonly", acquireVsCodeApi: "readonly", MessageEvent: "readonly", HTMLDivElement: "readonly" } },
  },
  {
    files: ["build/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", URL: "readonly" } },
  },
  {
    files: ["test/**/*.mjs", "test/**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        URL: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        require: "readonly",
        module: "writable",
        __dirname: "readonly",
        console: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
