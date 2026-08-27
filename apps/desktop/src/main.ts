import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { createWorkbenchRouter } from "@greywork/workbench";
import "./tailwind.css";

createApp(App).use(createPinia()).use(createWorkbenchRouter()).mount("#app");
