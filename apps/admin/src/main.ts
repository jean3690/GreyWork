import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import "element-plus/dist/index.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import App from "./App.vue";
import { router } from "./router";
import "./styles/theme.css";

/**
 * 运维台入口：全量注册 Element Plus（后台页面不多，按需引入省下的体积抵不过
 * 「组件忘了注册 → 运行期空白」这类低级故障）。语言固定中文。
 */
createApp(App).use(createPinia()).use(router).use(ElementPlus, { locale: zhCn }).mount("#app");
