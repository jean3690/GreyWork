/**
 * 选区语义解析：一套通用回溯要同时吃下四种渲染器的 DOM。
 *
 * 每个渲染器的语义来源都不一样（markdown 是真标签、docx 靠模型补的 data 属性、
 * 网页正文是一个 <pre>），所以逐条钉死，防止哪天给某个渲染器改 DOM 时悄悄退化。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { collectUnitText, findPrecedingHeading, isTextSelectableKind, resolveSemanticUnit } from "@/lib/selection";

function firstTextNode(element: Element): Text {
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) return child as Text;
    if (child.nodeType === Node.ELEMENT_NODE) {
      const found = firstTextNode(child as Element);
      if (found) return found;
    }
  }
  throw new Error("元素内没有文本节点");
}

function scope(): Element {
  const element = document.querySelector("[data-selection-scope]");
  if (!element) throw new Error("没有作用域元素");
  return element;
}

function unitAt(selector: string) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`未找到 ${selector}`);
  return resolveSemanticUnit(firstTextNode(element), scope());
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("resolveSemanticUnit", () => {
  it("markdown：真语义标签直接用", () => {
    document.body.innerHTML = `<div data-selection-scope>
      <h3 id="h">小标题</h3>
      <p id="p">段落</p>
      <ul><li id="li">列表项</li></ul>
      <table><tr><td id="td">单元格</td></tr></table>
    </div>`;

    expect(unitAt("#h")).toMatchObject({ role: "heading", level: 3 });
    expect(unitAt("#p")).toMatchObject({ role: "paragraph" });
    expect(unitAt("#li")).toMatchObject({ role: "list-item" });
    expect(unitAt("#td")).toMatchObject({ role: "table-cell" });
  });

  it("docx：标题与列表的层级来自模型补的 data 属性（DOM 标签上分不出来）", () => {
    document.body.innerHTML = `<article data-selection-scope>
      <p id="heading" data-heading="2">文档标题</p>
      <p id="body">正文</p>
      <p id="list" data-list-level="1">列表项</p>
      <table data-testid="docx-table"><tbody><tr><td id="cell">格</td></tr></tbody></table>
    </article>`;

    expect(unitAt("#heading")).toMatchObject({ role: "heading", level: 2 });
    expect(unitAt("#body")).toMatchObject({ role: "paragraph", level: null });
    expect(unitAt("#list")).toMatchObject({ role: "list-item", listLevel: 1 });
    expect(unitAt("#cell")).toMatchObject({ role: "table-cell" });
  });

  it("嵌套表格取最内层：单元格里的段落归段落，不归外层单元格", () => {
    document.body.innerHTML = `<div data-selection-scope>
      <table><tr><td id="outer"><table><tr><td id="inner">内层文字</td></tr></table></td></tr></table>
    </div>`;

    expect(unitAt("#inner")).toMatchObject({ role: "table-cell" });
  });

  it("网页正文的 <pre> 靠 data-selection-role 兜住，不被当代码", () => {
    document.body.innerHTML = `<pre id="web" data-selection-scope data-selection-role="paragraph">正文</pre>`;

    expect(unitAt("#web")).toMatchObject({ role: "paragraph" });
  });

  it("真正的代码（pre / code / CodeMirror 内容区）判为 code", () => {
    document.body.innerHTML = `<div data-selection-scope>
      <pre id="pre"><code>const a = 1;</code></pre>
      <div class="cm-content" id="cm">选择器</div>
    </div>`;

    expect(unitAt("#pre")).toMatchObject({ role: "code" });
    expect(unitAt("#cm")).toMatchObject({ role: "code" });
  });

  it("作用域内没有任何可识别标签时回落 block", () => {
    document.body.innerHTML = `<div data-selection-scope><span id="bare">裸文本</span></div>`;

    expect(unitAt("#bare")).toMatchObject({ role: "block", element: null });
  });

  it("拾取最近祖先的 data-selection-location（PDF 的页码靠它）", () => {
    document.body.innerHTML = `<div data-selection-scope>
      <div id="page" data-selection-location="第 3 页" data-selection-role="block"><span>正文</span></div>
    </div>`;

    expect(unitAt("#page span")).toMatchObject({ role: "block", location: "第 3 页" });
  });

  it("角色与位置各自取最近值，可以落在不同层", () => {
    document.body.innerHTML = `<div data-selection-scope>
      <div data-selection-location="第 7 页"><p id="p">正文</p></div>
    </div>`;

    expect(unitAt("#p")).toMatchObject({ role: "paragraph", location: "第 7 页" });
  });

  it("没有声明的渲染器 location 为 null，仍由标题或角色名兜底", () => {
    document.body.innerHTML = `<div data-selection-scope><p id="p">正文</p></div>`;

    expect(unitAt("#p").location).toBeNull();
  });
});

describe("isTextSelectableKind", () => {
  it("pdf 可选（已铺文本层），其余能拿到 DOM 文本的都放行", () => {
    for (const kind of ["pdf", "md", "html", "docx", "pptx", "csv", "code", "raw", "diff", "web"]) {
      expect(isTextSelectableKind(kind)).toBe(true);
    }
  });

  it("canvas 类与无文本类仍排除", () => {
    // xlsx 走 Univer 自己的选区服务（表头按钮），不经过 DOM 这条路
    expect(isTextSelectableKind("xlsx")).toBe(false);
    expect(isTextSelectableKind("image")).toBe(false);
    expect(isTextSelectableKind("legacy-office")).toBe(false);
  });
});

describe("collectUnitText", () => {
  it("剔除 data-selection-exclude（行号槽、diff 行号）", () => {
    document.body.innerHTML = `<div data-selection-scope id="root">
      <div data-selection-exclude>1</div>
      <span>正文内容</span>
    </div>`;

    expect(collectUnitText(scope(), "block")).toBe("正文内容");
  });

  it("非代码折叠空白：HTML 源码里的缩进换行不是内容", () => {
    document.body.innerHTML = `<p id="p">  第一段
      第二段  </p>`;

    expect(collectUnitText(document.querySelector("#p")!, "paragraph")).toBe("第一段 第二段");
  });

  it("代码保留缩进与换行", () => {
    document.body.innerHTML = `<pre id="pre"><code>  indented
second</code></pre>`;

    const text = collectUnitText(document.querySelector("#pre")!, "code");
    expect(text).toContain("  indented");
    expect(text).toContain("\n");
  });
});

describe("findPrecedingHeading", () => {
  it("取同级里最近的前置标题（markdown 形态）", () => {
    document.body.innerHTML = `<div data-selection-scope>
      <h2>第一章</h2>
      <p id="t">正文</p>
    </div>`;

    expect(findPrecedingHeading(document.querySelector("#t"), scope())).toBe("第一章");
  });

  it("取同级里最近的前置标题（docx 形态，靠 data-heading）", () => {
    document.body.innerHTML = `<article data-selection-scope>
      <p data-heading="1">一级标题</p>
      <p id="t">正文</p>
    </article>`;

    expect(findPrecedingHeading(document.querySelector("#t"), scope())).toBe("一级标题");
  });

  it("同级找不到就往上走一层继续找", () => {
    document.body.innerHTML = `<div data-selection-scope>
      <h2>外层标题</h2>
      <div><p id="deep">深层正文</p></div>
    </div>`;

    expect(findPrecedingHeading(document.querySelector("#deep"), scope())).toBe("外层标题");
  });

  it("没有标题时返回空串（调用方用角色名兜底）", () => {
    document.body.innerHTML = `<div data-selection-scope><span id="t">裸文本</span></div>`;

    expect(findPrecedingHeading(document.querySelector("#t"), scope())).toBe("");
  });

  it("element 为 null 时安全返回空串（注入逻辑在无 DOM 环境下会传 null）", () => {
    expect(findPrecedingHeading(null, null)).toBe("");
  });
});
