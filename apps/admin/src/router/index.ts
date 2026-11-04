import { createRouter, createWebHashHistory } from "vue-router";
import { readToken } from "../api/session";
import AdminLayout from "../layouts/AdminLayout.vue";
import LoginView from "../views/LoginView.vue";

/**
 * hash 路由：控制面的 /admin 是「静态文件 + 一个入口映射」，没有 history fallback，
 * hash 是唯一不需要改后端路由表就能刷新深链的方案。
 */
export const router = createRouter({
  history: createWebHashHistory("/admin/"),
  routes: [
    {
      path: "/login",
      name: "login",
      component: LoginView,
      meta: { public: true, title: "登录" },
    },
    {
      path: "/",
      component: AdminLayout,
      children: [
        {
          path: "",
          name: "overview",
          component: () => import("../views/OverviewView.vue"),
          meta: { title: "概览", subtitle: "控制面今天的运行状况" },
        },
        {
          path: "users",
          name: "users",
          component: () => import("../views/UsersView.vue"),
          meta: { title: "用户与设备", subtitle: "搜索、启停、调整角色、管理会话" },
        },
        {
          path: "enroll-codes",
          name: "enroll-codes",
          component: () => import("../views/EnrollCodesView.vue"),
          meta: { title: "入场码", subtitle: "签发一次性准入凭据" },
        },
        {
          path: "hosts",
          name: "hosts",
          component: () => import("../views/HostsView.vue"),
          meta: { title: "宿主", subtitle: "桌面端 / 服务端实例与在线状态" },
        },
        {
          path: "channels",
          name: "channels",
          component: () => import("../views/ChannelsView.vue"),
          meta: { title: "通道绑定", subtitle: "跨用户的 IM 通道与宿主归属" },
        },
        {
          path: "storage",
          name: "storage",
          component: () => import("../views/StorageView.vue"),
          meta: { title: "对象存储", subtitle: "跨用户容量与待确认上传" },
        },
        {
          path: "automation",
          name: "automation",
          component: () => import("../views/AutomationView.vue"),
          meta: { title: "自动化任务", subtitle: "调度积压、失败率与跨用户任务" },
        },
        {
          path: "llm",
          name: "llm",
          component: () => import("../views/LlmView.vue"),
          meta: { title: "模型与用量", subtitle: "供应商密钥与 token 消耗" },
        },
        {
          path: "audit",
          name: "audit",
          component: () => import("../views/AuditView.vue"),
          meta: { title: "审计日志", subtitle: "运维动作的完整留痕" },
        },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach((to) => {
  if (to.meta.public) {
    return true;
  }
  if (!readToken()) {
    return { path: "/login", query: { redirect: to.fullPath } };
  }
  return true;
});
