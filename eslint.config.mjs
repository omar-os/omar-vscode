import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ["out/**", "node_modules/**"] },
  {
    files: ["test/**/*.mjs"],
    languageOptions: { globals: { process: "readonly" } },
    rules: { "@typescript-eslint/no-unused-expressions": "off" },
  },
];
