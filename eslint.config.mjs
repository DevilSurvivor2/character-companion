import obsidianmd from "eslint-plugin-obsidianmd";
import { defineConfig } from "eslint/config";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: {
      // CJS-artifact false positives: the source is hand-authored CommonJS (require/
      // module.exports between the src/ modules), and module-scope function declarations
      // in a CJS file are module-local, not globals.
      "@typescript-eslint/no-require-imports": "off",
      "no-implicit-globals": "off",
      // destructuring `Plugin` from require("obsidian") collides with a same-named browser
      // global in the ruleset's environment — a module-local const, not a redeclaration
      "no-redeclare": ["error", { builtinGlobals: false }],
      // type-aware rules — cannot run on plain JS without tsconfig types
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "obsidianmd/no-plugin-as-component": "off",
      "obsidianmd/no-unsupported-api": "off",
      "obsidianmd/no-view-references-in-plugin": "off",
      "obsidianmd/prefer-file-manager-trash-file": "off",
      "obsidianmd/prefer-instanceof": "off",
    },
  },
]);
