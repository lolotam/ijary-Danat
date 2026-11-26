import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

import { PLATFORM_ALLOWLIST } from "./eslint.platform-allowlist.js";

const SERVER_ONLY_RESTRICTION = {
  name: "server-only",
  message:
    "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
};

export default tseslint.config(
  // Agent worktrees are full repo checkouts nested in this folder; linting them
  // gives typescript-eslint several tsconfig roots and fails every file.
  {
    ignores: [
      "dist",
      ".output",
      ".vinxi",
      "tmp_ssh",
      "supabase/functions",
      ".claude/**",
      ".kilo/**",
      ".worktrees/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // v7's recommended set adds 14 React Compiler rules. Enabling them is a
      // separate decision from the ESLint 10 upgrade, so keep the two rules
      // v5's recommended set enforced.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-restricted-imports": [
        "error",
        {
          paths: [SERVER_ONLY_RESTRICTION],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    ignores: PLATFORM_ALLOWLIST,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [SERVER_ONLY_RESTRICTION],
          patterns: [
            {
              regex:
                "(?:^|/)integrations/supabase/client\\.server(?:\\.ts)?$|^\\./client\\.server(?:\\.ts)?$",
              message:
                "Do not import src/integrations/supabase/client.server.ts outside the platform allow-list. Use companyClient(companyId) from @/company/companyClient.server instead.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportExpression[source.value=/(?:^|\\/)integrations\\/supabase\\/client\\.server(?:\\.ts)?$|^\\.\\/client\\.server(?:\\.ts)?$/]",
          message:
            "Do not dynamically import src/integrations/supabase/client.server.ts outside the platform allow-list. Use companyClient(companyId) from @/company/companyClient.server instead.",
        },
      ],
    },
  },
  eslintPluginPrettier,
);
