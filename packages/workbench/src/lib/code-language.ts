/**
 * 路径 → CodeMirror 语言（按扩展名动态 import，各 lang 包独立 chunk，不进主包）。
 *
 * 单一来源：TextViewer 用它建编辑器扩展，diff 高亮用它拿 `Language.parser` 离线着色。
 * 之前这段 switch 只长在 TextViewer 里，diff 若另抄一份迟早会在「支持哪些语言」上走岔。
 */
import type { Language } from "@codemirror/language";
import { codeLanguageOfPath, type CodeLanguage } from "./viewer";

export interface LoadedCodeLanguage {
  /** CodeMirror 扩展（LanguageSupport / StreamLanguage），可直接塞进 EditorState。 */
  support: unknown;
  /** 底层 Language；`parser.parse(text)` 用于拿语法树做离线高亮。 */
  language: Language;
}

/** path 没有对应的已装 lang 包时返回 null（调用方降级为纯文本，不去猜没装的包）。 */
export async function loadCodeLanguage(path: string): Promise<LoadedCodeLanguage | null> {
  const kind = codeLanguageOfPath(path);
  return kind ? loadByKind(kind) : null;
}

/** 按已判定的语言加载（工具输出 / 命令这类没有路径、但知道语言形态的片段用）。 */
export async function loadCodeLanguageByKind(kind: CodeLanguage): Promise<LoadedCodeLanguage> {
  return loadByKind(kind);
}

async function loadByKind(kind: CodeLanguage): Promise<LoadedCodeLanguage> {
  switch (kind) {
    case "javascript": {
      // tsx/jsx 同走一个分支：jsx: true 让 JSX 语法也被识别，否则 .tsx 只按 TS 高亮
      const support = (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
      return { support, language: support.language };
    }
    case "vue": {
      const support = (await import("@codemirror/lang-vue")).vue();
      return { support, language: support.language };
    }
    case "json": {
      const support = (await import("@codemirror/lang-json")).json();
      return { support, language: support.language };
    }
    case "markdown": {
      const support = (await import("@codemirror/lang-markdown")).markdown();
      return { support, language: support.language };
    }
    case "html": {
      const support = (await import("@codemirror/lang-html")).html();
      return { support, language: support.language };
    }
    case "python": {
      const support = (await import("@codemirror/lang-python")).python();
      return { support, language: support.language };
    }
    case "rust": {
      const support = (await import("@codemirror/lang-rust")).rust();
      return { support, language: support.language };
    }
    case "go": {
      const support = (await import("@codemirror/lang-go")).go();
      return { support, language: support.language };
    }
    case "java": {
      const support = (await import("@codemirror/lang-java")).java();
      return { support, language: support.language };
    }
    case "cpp": {
      const support = (await import("@codemirror/lang-cpp")).cpp();
      return { support, language: support.language };
    }
    case "css": {
      const support = (await import("@codemirror/lang-css")).css();
      return { support, language: support.language };
    }
    case "sass": {
      const support = (await import("@codemirror/lang-sass")).sass();
      return { support, language: support.language };
    }
    case "less": {
      const support = (await import("@codemirror/lang-less")).less();
      return { support, language: support.language };
    }
    case "yaml": {
      const support = (await import("@codemirror/lang-yaml")).yaml();
      return { support, language: support.language };
    }
    case "sql": {
      const support = (await import("@codemirror/lang-sql")).sql();
      return { support, language: support.language };
    }
    case "xml": {
      const support = (await import("@codemirror/lang-xml")).xml();
      return { support, language: support.language };
    }
    // toml / shell 没有官方 lang 包，用 legacy-modes 的 StreamLanguage 适配器桥接
    case "toml": {
      const { StreamLanguage } = await import("@codemirror/language");
      const language = StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
      return { support: language, language };
    }
    case "shell": {
      const { StreamLanguage } = await import("@codemirror/language");
      const language = StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
      return { support: language, language };
    }
  }
}
