import js from "@eslint/js";
import globals from "globals";
import pluginVue from "eslint-plugin-vue";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import prettierConfig from "eslint-config-prettier";

/**
 * Tauri 传输层只能经 @greywork/host-ipc 门面访问。
 *
 * 与 Rust 侧「crates/greywork-host 不得依赖 tauri」的 CI 守卫同构：桌面 Tauri IPC 与服务端
 * HTTP/WS 的差异被收敛在那一个包里，上层代码不感知运行时。绕过门面直接 import 的代码在
 * 服务端模式下编得过、跑不通（缺 __TAURI_INTERNALS__），是最难排查的一类问题。
 *
 * 注意：no-restricted-imports 管不到动态 import()，写新代码时别用动态 import 绕它。
 */
const TAURI_TRANSPORT_PATHS = [
  {
    name: "@tauri-apps/api/core",
    message: "Tauri IPC 只允许经 @greywork/host-ipc 的 invoke 门面（全仓唯一的 Tauri 传输层出口）。",
  },
  {
    name: "@tauri-apps/api/event",
    message: "Tauri 事件只允许经 @greywork/host-ipc 的 listen 门面（全仓唯一的 Tauri 传输层出口）。",
  },
];

/** packages 不得反向依赖 apps/*。 */
const NO_APPS_DEPENDENCY = {
  group: ["**/apps/**"],
  message: "packages 禁止反向依赖 apps/*，见 docs/architecture.md「依赖方向」。",
};

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
        // 这两个 glob 下的文件不属于任何包的 tsconfig，但仍是本仓代码，要走 lint 而不是 ignore。
        projectService: { allowDefaultProject: ["packages/*/vitest.config.ts", "scripts/*.mjs"] },
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
      // 剪贴板只走插件：本仓三平台的 WebView（WKWebView / WebKitGTK）上 Web Clipboard API
      // 会静默 resolve 但不写入系统剪贴板，唯一可靠的是 tauri-plugin-clipboard-manager。
      // 真要在测试里 stub 它，用 eslint-disable-next-line 并写明原因。
      "no-restricted-properties": [
        "error",
        {
          object: "navigator",
          property: "clipboard",
          message:
            "剪贴板一律走 @tauri-apps/plugin-clipboard-manager：WKWebView / WebKitGTK 上 Web Clipboard API 会静默 resolve 但不写入系统剪贴板。",
        },
      ],
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
            NO_APPS_DEPENDENCY,
          ],
        },
      ],
    },
  },
  {
    files: ["packages/*/src/**"],
    // __tests__ 例外：组件测试要 mock Tauri 传输层（`vi.mock("@tauri-apps/api/core")`），
    // 断言必须落在真实边界上；生产代码没有这个豁免。
    ignores: ["packages/{agents,gis}/src/**", "packages/host-ipc/src/**", "**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: TAURI_TRANSPORT_PATHS,
          patterns: [NO_APPS_DEPENDENCY],
        },
      ],
    },
  },
  {
    // host-ipc 正是那个允许 import Tauri 的包；但它仍不得反向依赖 apps/*。
    files: ["packages/host-ipc/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [NO_APPS_DEPENDENCY],
        },
      ],
    },
  },
  {
    files: ["apps/*/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: TAURI_TRANSPORT_PATHS,
        },
      ],
    },
  },
);
