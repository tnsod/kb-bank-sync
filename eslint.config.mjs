import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "logs/**", "output/**", "eslint.config.mjs"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["scripts/*.mjs"],
    languageOptions: { globals: { process: "readonly" } },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        projectService: false,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
);
