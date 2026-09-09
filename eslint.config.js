import js from "@eslint/js";
import globals from "globals";
import pluginVue from "eslint-plugin-vue";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import prettierConfig from "eslint-config-prettier";

export default defineConfigWithVueTs(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/target/**",
      "pnpm-lock.yaml",
      "**/src-tauri/tests/*.mjs",
      "apps/desktop/e2e/**",
      "**/vitest.config.ts",
      "eslint.config.js",
      // 插件市场源仓库（发布产物 JSON + worker JS），运行时经 registry URL 拉取，
      // 不参与本仓 tsconfig project service
      "plugin-market/**",
      // vendored 的 agent skills（markdown 文档 + 自带配置），不是本仓代码，
      // 也不在 tsconfig 的 project service 里 —— 交给 eslint 解析只会报 parsing error
      ".agents/**",
    ],
  },
  js.configs.recommended,
  pluginVue.configs["flat/recommended"],
  vueTsConfigs.recommended,
  prettierConfig,
  {
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["**/*.mjs", "**/*.cjs", "eslint.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["**/*.mjs", "**/*.cjs", "eslint.config.js"],
    extends: [vueTsConfigs.disableTypeChecked],
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["packages/*/vitest.config.ts"] },
      },
    },
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: "@typescript-eslint/parser" },
    },
    rules: {
      "vue/multi-word-component-names": "off",
      "vue/require-default-prop": "off",
      "vue/no-v-html": "off",
      "vue/max-attributes-per-line": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/html-self-closing": "off",
      "vue/html-indent": "off",
      "vue/html-closing-bracket-newline": "off",
      "vue/first-attribute-linebreak": "off",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-console": "off",
    },
  },
  {
    files: ["packages/agents/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@greywork/*", "!@greywork/core"],
              message: "领域包只允许依赖 @greywork/core，保持领域逻辑与 UI 解耦，见 docs/architecture.md「依赖方向」。",
            },
            {
              group: ["**/apps/**"],
              message: "packages 禁止反向依赖 apps/*，见 docs/architecture.md「依赖方向」。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/*/src/**"],
    ignores: ["packages/{agents,gis}/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/apps/**"],
              message: "packages 禁止反向依赖 apps/*，见 docs/architecture.md「依赖方向」。",
            },
          ],
        },
      ],
    },
  },
);
