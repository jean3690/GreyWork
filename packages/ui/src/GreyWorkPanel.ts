import { defineComponent, h, type PropType } from "vue";
import type { PanelTone } from "./tokens";

/**
 * GreyWork 共享面板组件。
 * 由桌面端与 Web 端共同消费，保证视觉一致。
 */
export const GreyWorkPanel = defineComponent({
  name: "GreyWorkPanel",
  props: {
    eyebrow: { type: String, default: "GreyWork" },
    title: { type: String, default: "" },
    meta: { type: String, default: "" },
    tone: { type: String as PropType<PanelTone>, default: "amber" },
    footer: { type: String, default: "" },
  },
  setup(props, { slots }) {
    return () =>
      h("section", { class: ["gw-panel", `gw-panel--${props.tone}`] }, [
        h("header", { class: "gw-panel__head" }, [
          h("span", { class: "gw-panel__eyebrow" }, [h("span", { class: "gw-panel__dot" }), ` ${props.eyebrow}`]),
          props.meta ? h("span", { class: "gw-panel__meta" }, props.meta) : null,
        ]),
        props.title ? h("h2", { class: "gw-panel__title" }, props.title) : null,
        h("div", { class: "gw-panel__body" }, slots.default?.()),
        props.footer ? h("footer", { class: "gw-panel__footer" }, props.footer) : null,
      ]);
  },
});

export default GreyWorkPanel;
