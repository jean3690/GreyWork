/**
 * pptx 预览（SlideViewer）：DOM 绝对定位渲染，几何按真实 px 还原。
 * 底层 lib/pptx-parse.ts 已有独立测试，这里只验证渲染契约：页计数、缩放比、
 * 文本 run 样式、形状几何、图片 data URL、表格合并续格跳过、备注。
 * 用 jszip 现拼最小 pptx，不依赖落盘 fixture。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import JSZip from "jszip";

import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({ readBinary: vi.fn<(path: string) => Promise<Uint8Array>>() }));
vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readBinary: h.readBinary }) }));

import SlideViewer from "@/features/preview/SlideViewer.vue";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const PX = 9525;

const THEME = `<?xml version="1.0"?>
<a:theme xmlns:a="${A}">
  <a:themeElements><a:clrScheme name="Office">
    <a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1>
    <a:lt1><a:sysClr val="window" lastClr="FEFEFE"/></a:lt1>
    <a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
    <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
  </a:clrScheme></a:themeElements>
</a:theme>`;

const LAYOUT = `<?xml version="1.0"?>
<p:sldLayout xmlns:a="${A}" xmlns:p="${P}">
  <p:cSld><p:spTree/></p:cSld>
</p:sldLayout>`;

const MASTER = `<?xml version="1.0"?>
<p:sldMaster xmlns:a="${A}" xmlns:p="${P}">
  <p:cSld><p:spTree/></p:cSld>
</p:sldMaster>`;

function rels(entries: { id: string; type: string; target: string }[]): string {
  const body = entries
    .map(
      (entry) =>
        `<Relationship Id="${entry.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${entry.type}" Target="${entry.target}"/>`,
    )
    .join("");
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
}

function slideXml(body: string): string {
  return `<?xml version="1.0"?>
<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">
  <p:cSld><p:spTree>${body}</p:spTree></p:cSld>
</p:sld>`;
}

interface SlideFixture {
  file: string;
  xml: string;
  notes?: string;
  image?: boolean;
}

async function buildPptx(slides: SlideFixture[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("ppt/theme/theme1.xml", THEME);
  zip.file("ppt/slideMasters/slideMaster1.xml", MASTER);
  zip.file("ppt/slideLayouts/slideLayout1.xml", LAYOUT);
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]),
  );
  zip.file("ppt/media/image1.png", new Uint8Array([1, 2, 3, 4]));

  const presentationRels = [{ id: "rIdTheme", type: "theme", target: "theme/theme1.xml" }];
  for (const [index, slide] of slides.entries()) {
    zip.file(`ppt/slides/${slide.file}`, slide.xml);
    const slideRels = [{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }];
    if (slide.notes) {
      const notesFile = slide.file.replace("slide", "notesSlide");
      zip.file(`ppt/notesSlides/${notesFile}`, slide.notes);
      slideRels.push({ id: "rId2", type: "notesSlide", target: `../notesSlides/${notesFile}` });
    }
    if (slide.image) slideRels.push({ id: "rIdImg", type: "image", target: "../media/image1.png" });
    zip.file(`ppt/slides/_rels/${slide.file}.rels`, rels(slideRels));
    presentationRels.push({ id: `rIdS${index}`, type: "slide", target: `slides/${slide.file}` });
  }

  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?>
<p:presentation xmlns:r="${R}" xmlns:p="${P}">
  <p:sldIdLst>${slides.map((_, index) => `<p:sldId r:id="rIdS${index}"/>`).join("")}</p:sldIdLst>
  <p:sldSz cx="${960 * PX}" cy="${540 * PX}"/>
</p:presentation>`,
  );
  zip.file("ppt/_rels/presentation.xml.rels", rels(presentationRels));
  return zip.generateAsync({ type: "uint8array" });
}

const NOTES = `<?xml version="1.0"?>
<p:notes xmlns:a="${A}" xmlns:p="${P}">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>这是演讲者备注</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:notes>`;

const TEXT_BOX = `
<p:sp>
  <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${48 * PX}" y="${33 * PX}"/><a:ext cx="${864 * PX}" cy="${67 * PX}"/></a:xfrm></p:spPr>
  <p:txBody>
    <a:bodyPr anchor="ctr"/>
    <a:p>
      <a:pPr algn="ctr"><a:buNone/></a:pPr>
      <a:r>
        <a:rPr sz="2600" b="1"><a:solidFill><a:srgbClr val="1C1917"/></a:solidFill><a:latin typeface="Inter"/></a:rPr>
        <a:t>数据结果</a:t>
      </a:r>
    </a:p>
    <a:p>
      <a:pPr marL="342900"><a:buChar char="•"/></a:pPr>
      <a:r><a:rPr sz="1500"/><a:t>要点一</a:t></a:r>
    </a:p>
  </p:txBody>
</p:sp>`;

const SHAPES = `
<p:sp>
  <p:nvSpPr><p:cNvPr id="3" name="Rounded"/><p:nvPr/></p:nvSpPr>
  <p:spPr>
    <a:xfrm><a:off x="${100 * PX}" y="${200 * PX}"/><a:ext cx="${200 * PX}" cy="${100 * PX}"/></a:xfrm>
    <a:prstGeom prst="roundRect"/>
    <a:solidFill><a:srgbClr val="F4B942"/></a:solidFill>
  </p:spPr>
</p:sp>
<p:sp>
  <p:nvSpPr><p:cNvPr id="4" name="Ellipse"/><p:nvPr/></p:nvSpPr>
  <p:spPr>
    <a:xfrm><a:off x="${400 * PX}" y="${120 * PX}"/><a:ext cx="${120 * PX}" cy="${120 * PX}"/></a:xfrm>
    <a:prstGeom prst="ellipse"/>
    <a:solidFill><a:srgbClr val="3B82F6"/></a:solidFill>
  </p:spPr>
</p:sp>`;

const PIC = `
<p:pic>
  <p:nvPicPr><p:cNvPr id="7" name="星图"/></p:nvPicPr>
  <p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill>
  <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${100 * PX}" cy="${50 * PX}"/></a:xfrm></p:spPr>
</p:pic>`;

const TABLE = `
<p:graphicFrame>
  <p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/></p:nvGraphicFramePr>
  <p:xfrm><a:off x="${60 * PX}" y="${300 * PX}"/><a:ext cx="${800 * PX}" cy="${100 * PX}"/></p:xfrm>
  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
    <a:tbl>
      <a:tblGrid><a:gridCol w="${400 * PX}"/><a:gridCol w="${400 * PX}"/></a:tblGrid>
      <a:tr h="0">
        <a:tc>
          <a:txBody><a:p><a:r><a:rPr sz="1200" b="1"/><a:t>行星</a:t></a:r></a:p></a:txBody>
          <a:tcPr><a:solidFill><a:srgbClr val="1C1917"/></a:solidFill></a:tcPr>
        </a:tc>
        <a:tc gridSpan="2">
          <a:txBody><a:p><a:r><a:rPr sz="1200"/><a:t>直径</a:t></a:r></a:p></a:txBody>
          <a:tcPr/>
        </a:tc>
        <a:tc hMerge="1"><a:txBody><a:p/></a:txBody><a:tcPr/></a:tc>
      </a:tr>
    </a:tbl>
  </a:graphicData></a:graphic>
</p:graphicFrame>`;

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "out/演示.pptx", name: "演示.pptx", kind: "pptx", source: "vfs", revision: 0, ...partial };
}

function mountViewer(overrides?: Partial<PreviewTab>) {
  return mount(SlideViewer, { props: { tab: tab(overrides) } });
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  h.readBinary.mockReset();
});

/**
 * 等解析落地：各用例轮询到自己的终态断言成立为止，不用固定时长的 sleep。
 *
 * 现拼 pptx 的解压是 JSZip 的 setTimeout 分片，`flushPromises`（纯微任务）喂不到，必须让出
 * 真实宏任务；但「让出多久」不能赌 —— 耗时随 runner 负载浮动，赌多少毫秒都可能不够。
 * 更麻烦的是中间态很具欺骗性：`loading` 已转 false 而 `deck` 尚未赋值，页头显示「演示文稿」
 * 看着像渲染完了，其实只是还没解析完（CI 上就偶发断言到这一态）。故改用 vi.waitFor 轮询。
 */

describe("SlideViewer", () => {
  it("读取中：加载占位，页头回落默认文案", () => {
    h.readBinary.mockReturnValue(new Promise(() => {}));
    const wrapper = mountViewer();
    expect(wrapper.text()).toContain("读取中");
    expect(wrapper.text()).toContain("演示文稿");
  });

  it("完整渲染：单页含文本/形状/图片/表格/备注，缩放回落到实际尺寸", async () => {
    h.readBinary.mockResolvedValue(
      await buildPptx([{ file: "slide1.xml", xml: slideXml(`${TEXT_BOX}${SHAPES}${PIC}${TABLE}`), notes: NOTES, image: true }]),
    );
    const wrapper = mountViewer();
    await vi.waitFor(() => expect(wrapper.text()).toContain("共 1 页"));
    expect(wrapper.get('[data-testid="slide-viewer"]').text()).toContain("第 1 页");
    expect(wrapper.get('[data-testid="slide-viewer"]').text()).toContain("备注：这是演讲者备注");

    // 外框按缩放后尺寸占位；happy-dom 无布局 → availableWidth 归零 → scale 1，width 仍为 960px
    const page = wrapper.get('[data-testid="slide-page"]');
    expect(page.attributes("style")).toContain("width: 960px");
    expect(page.attributes("style")).toContain("height: 540px");
    // 内容画布原始 px + transform scale(1)
    expect(wrapper.get('[data-testid="slide-page"] > div').attributes("style")).toContain("transform: scale(1)");

    // 文本：段落样式（字号/行高）分家，run 样式（加粗/颜色/字族）落在 <p> 里的 span 上
    const text = wrapper.get('[data-testid="slide-text"]');
    expect(text.text()).toContain("数据结果");
    const titleP = text.findAll("p")[0];
    const titleRun = titleP.find("span");
    expect(titleRun.attributes("style")).toContain("font-weight: 700");
    expect(titleRun.attributes("style")).toContain("color: #1C1917");
    expect(titleP.find("[aria-hidden]").exists()).toBe(false);
    const bulletP = text.findAll("p")[1];
    expect(bulletP.find("[aria-hidden]").text()).toBe("•");
    expect(text.attributes("style")).toContain("justify-content: center");

    // 表格：合并的续格不渲染成 td
    const table = wrapper.get('[data-testid="slide-table"]');
    const tds = table.findAll("td");
    expect(tds).toHaveLength(2);
    expect(tds[0].text()).toBe("行星");
    expect(tds[0].attributes("style")).toContain("background: #1C1917");
    expect(tds[1].text()).toBe("直径");
    // gridSpan=2 的单元格要把合并宽度体现到 colspan 上
    expect(tds[1].attributes("colspan")).toBe("2");

    // 图片：解析成 data URL
    const img = wrapper.get('[data-testid="slide-viewer"] img');
    expect(img.attributes("src")).toMatch(/^data:image\/png;base64,/);
    expect(img.attributes("alt")).toBe("星图");

    // 形状：roundRect → 8px 圆角；ellipse → 50%
    const styles = wrapper
      .get('[data-testid="slide-viewer"]')
      .findAll(':scope div[style*="border-radius"]')
      .map((el) => el.attributes("style"));
    expect(styles.join("")).toContain("border-radius: 8px");
    expect(styles.join("")).toContain("border-radius: 50%");
  });

  it("多页：按 sldIdLst 顺序翻页并显示页码", async () => {
    h.readBinary.mockResolvedValue(
      await buildPptx([
        { file: "slide1.xml", xml: slideXml(TEXT_BOX) },
        { file: "slide2.xml", xml: slideXml(SHAPES) },
      ]),
    );
    const wrapper = mountViewer();
    await vi.waitFor(() => expect(wrapper.text()).toContain("共 2 页"));
    expect(wrapper.findAll('[data-testid="slide-page"]')).toHaveLength(2);
    expect(wrapper.get('[data-testid="slide-viewer"]').text()).toContain("第 1 页");
    expect(wrapper.get('[data-testid="slide-viewer"]').text()).toContain("第 2 页");
  });

  it("空演示文稿：没有任何幻灯片时给提示而不是白屏", async () => {
    h.readBinary.mockResolvedValue(await buildPptx([]));
    const wrapper = mountViewer();
    await vi.waitFor(() => expect(wrapper.text()).toContain("这份演示文稿没有幻灯片"));
    expect(wrapper.findAll('[data-testid="slide-page"]')).toHaveLength(0);
  });

  it("读文件失败：读取失败 alert", async () => {
    h.readBinary.mockRejectedValue(new Error("权限不足"));
    const wrapper = mountViewer();
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain("读取失败：权限不足"));
  });

  it("垃圾字节：标明无法解析并提示走系统应用", async () => {
    h.readBinary.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
    const wrapper = mountViewer();
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain("无法解析该演示文稿"));
    expect(wrapper.get('[role="alert"]').text()).toContain("用系统应用打开");
  });

  it("切代次：revision 自增后重读并重绘，不留旧内容", async () => {
    h.readBinary.mockResolvedValueOnce(await buildPptx([{ file: "slide1.xml", xml: slideXml(TEXT_BOX) }]));
    const wrapper = mountViewer();
    await vi.waitFor(() => expect(wrapper.text()).toContain("数据结果"));

    h.readBinary.mockResolvedValueOnce(await buildPptx([{ file: "slide1.xml", xml: slideXml(SHAPES) }]));
    await wrapper.setProps({ tab: tab({ revision: 1 }) });
    // 新 deck 落地前旧 deck 还在 DOM 里，所以「slide-text 消失」既是终态也是判别式
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="slide-text"]')).toHaveLength(0));
    expect(wrapper.find('[data-testid="slide-table"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="slide-page"]')).toHaveLength(1);
  });

  it("深色背景无显式文字色：文本框兜底浅色，避免黑字压深底看不见", async () => {
    const darkBgSlide = `<?xml version="1.0"?>
<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="1C1917"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="${48 * PX}" y="${33 * PX}"/><a:ext cx="${864 * PX}" cy="${67 * PX}"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:rPr sz="2600"/><a:t>无色标题</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;
    h.readBinary.mockResolvedValue(await buildPptx([{ file: "slide1.xml", xml: darkBgSlide }]));
    const wrapper = mountViewer();
    await vi.waitFor(() => expect(wrapper.text()).toContain("无色标题"));

    const text = wrapper.get('[data-testid="slide-text"]');
    // 文本框据深色背景兜底浅字；run 没声明颜色，故 span 上不覆盖
    expect(text.attributes("style")).toContain("color: #FAFAF9");
    expect(text.find("span").attributes("style")).not.toContain("color:");
  });
});
