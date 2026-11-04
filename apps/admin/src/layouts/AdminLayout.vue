<script setup lang="ts">
import { Connection, Cpu, DataAnalysis, Document, Fold, Lock, Monitor, SwitchButton, Tickets, User } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { adminApi } from "../api";
import { ApiError } from "../api/http";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const navOpen = ref(false);
const pwdOpen = ref(false);
const saving = ref(false);
const pwd = reactive({ current: "", next: "", confirm: "" });

const title = computed(() => String(route.meta.title ?? "运维台"));
const subtitle = computed(() => String(route.meta.subtitle ?? ""));
const initial = computed(() => (auth.displayName || "A").slice(0, 1).toUpperCase());

function openPassword(): void {
  pwd.current = "";
  pwd.next = "";
  pwd.confirm = "";
  pwdOpen.value = true;
}

async function savePassword(): Promise<void> {
  if (pwd.next.length < 8) {
    ElMessage.warning("新密码至少 8 位");
    return;
  }
  if (pwd.next !== pwd.confirm) {
    ElMessage.warning("两次输入的新密码不一致");
    return;
  }
  saving.value = true;
  try {
    await adminApi.changePassword(pwd.current, pwd.next);
    ElMessage.success("密码已更新，下次登录请使用新密码");
    pwdOpen.value = false;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "修改密码失败");
  } finally {
    saving.value = false;
  }
}

async function onCommand(command: string): Promise<void> {
  if (command === "password") {
    openPassword();
    return;
  }
  if (command === "logout") {
    try {
      await ElMessageBox.confirm("退出后需要重新输入密码才能进入运维台。", "退出登录", {
        confirmButtonText: "退出",
        cancelButtonText: "取消",
        type: "warning",
      });
    } catch {
      return;
    }
    await auth.logout();
    await router.replace("/login");
  }
}

function navigate(): void {
  navOpen.value = false;
}
</script>

<template>
  <div class="shell" :class="{ 'nav-open': navOpen }">
    <aside class="side">
      <div class="brand">
        <span class="brand-mark">G</span>
        <div class="brand-text">
          <strong>GreyWork</strong>
          <span>Control Plane</span>
        </div>
      </div>

      <el-menu :default-active="route.path" class="nav" router @select="navigate">
        <p class="nav-group">运维</p>
        <el-menu-item index="/">
          <el-icon><DataAnalysis /></el-icon>
          <span>概览</span>
        </el-menu-item>
        <el-menu-item index="/users">
          <el-icon><User /></el-icon>
          <span>用户与设备</span>
        </el-menu-item>
        <el-menu-item index="/enroll-codes">
          <el-icon><Tickets /></el-icon>
          <span>入场码</span>
        </el-menu-item>

        <p class="nav-group">资源</p>
        <el-menu-item index="/hosts">
          <el-icon><Monitor /></el-icon>
          <span>宿主</span>
        </el-menu-item>
        <el-menu-item index="/channels">
          <el-icon><Connection /></el-icon>
          <span>通道绑定</span>
        </el-menu-item>
        <el-menu-item index="/llm">
          <el-icon><Cpu /></el-icon>
          <span>模型与用量</span>
        </el-menu-item>

        <p class="nav-group">安全</p>
        <el-menu-item index="/audit">
          <el-icon><Document /></el-icon>
          <span>审计日志</span>
        </el-menu-item>
      </el-menu>

      <div class="side-foot">
        <div class="who">
          <span class="avatar">{{ initial }}</span>
          <div class="who-text">
            <strong>{{ auth.displayName }}</strong>
            <span>{{ auth.user?.email }}</span>
          </div>
        </div>
        <el-dropdown trigger="click" placement="top-start" @command="onCommand">
          <button class="account-btn" type="button">账户设置</button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="password">
                <el-icon><Lock /></el-icon>修改密码
              </el-dropdown-item>
              <el-dropdown-item command="logout" divided>
                <el-icon><SwitchButton /></el-icon>退出登录
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </aside>

    <div class="nav-mask" @click="navOpen = false" />

    <div class="main">
      <header class="topbar">
        <button class="nav-toggle" type="button" aria-label="切换导航" @click="navOpen = !navOpen">
          <el-icon><Fold /></el-icon>
        </button>
        <div class="titles">
          <h1>{{ title }}</h1>
          <p v-if="subtitle">{{ subtitle }}</p>
        </div>
        <el-tag class="role-tag" effect="plain" size="small">ADMIN</el-tag>
      </header>

      <main class="body">
        <router-view />
      </main>
    </div>

    <el-dialog v-model="pwdOpen" title="修改运维台密码" width="420px" append-to-body>
      <el-form label-position="top" @submit.prevent="savePassword">
        <el-form-item label="当前密码（从未设置过可留空）">
          <el-input v-model="pwd.current" type="password" show-password autocomplete="current-password" />
        </el-form-item>
        <el-form-item label="新密码（至少 8 位）">
          <el-input v-model="pwd.next" type="password" show-password autocomplete="new-password" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="pwd.confirm" type="password" show-password autocomplete="new-password" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="savePassword">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
  background: radial-gradient(900px 480px at 78% -12%, rgba(88, 166, 255, 0.09), transparent 62%), var(--gw-bg);
}

.side {
  width: 232px;
  flex: 0 0 232px;
  display: flex;
  flex-direction: column;
  background: var(--gw-side);
  border-right: 1px solid var(--gw-line-soft);
  padding: 16px 12px 14px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 8px 16px;
}

.brand-mark {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: linear-gradient(140deg, #58a6ff, #7ee787);
  color: #06121f;
  font-weight: 700;
  font-size: 15px;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.brand-text strong {
  font-size: 13.5px;
  letter-spacing: 0.02em;
}

.brand-text span {
  color: var(--gw-dim);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border: 0;
  background: transparent;
  --el-menu-bg-color: transparent;
  --el-menu-text-color: #c9d1d9;
  --el-menu-hover-bg-color: #1b222b;
  --el-menu-active-color: #ffffff;
  --el-menu-item-height: 40px;
}

.nav-group {
  margin: 14px 0 4px;
  padding: 0 10px;
  color: #6e7681;
  font-size: 10.5px;
  letter-spacing: 0.1em;
}

.nav :deep(.el-menu-item) {
  border-radius: 8px;
  margin: 2px 0;
}

.nav :deep(.el-menu-item.is-active) {
  background: linear-gradient(90deg, rgba(88, 166, 255, 0.18), rgba(88, 166, 255, 0.05));
  box-shadow: inset 2px 0 0 var(--gw-accent);
}

.nav :deep(.el-menu-item .el-icon) {
  font-size: 16px;
  color: inherit;
}

.side-foot {
  border-top: 1px solid var(--gw-line-soft);
  padding-top: 12px;
  margin-top: 8px;
}

.who {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 2px 6px 10px;
}

.avatar {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #212a34;
  border: 1px solid var(--gw-line);
  color: var(--gw-accent);
  font-size: 12px;
  font-weight: 600;
}

.who-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

.who-text strong {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.who-text span {
  color: var(--gw-dim);
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-btn {
  width: 100%;
  height: 30px;
  border: 1px solid var(--gw-line);
  border-radius: 7px;
  background: #151b22;
  color: var(--gw-dim);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.account-btn:hover {
  color: var(--gw-text);
  border-color: #3d4753;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 26px 14px;
  border-bottom: 1px solid var(--gw-line-soft);
}

.titles h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.titles p {
  margin: 3px 0 0;
  color: var(--gw-dim);
  font-size: 11.5px;
}

.role-tag {
  margin-left: auto;
  font-size: 10px;
  letter-spacing: 0.08em;
}

.nav-toggle {
  display: none;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--gw-line);
  border-radius: 8px;
  background: var(--gw-panel);
  color: var(--gw-text);
  cursor: pointer;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 26px 40px;
}

.nav-mask {
  display: none;
}

@media (max-width: 900px) {
  .side {
    position: fixed;
    z-index: 20;
    inset: 0 auto 0 0;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    box-shadow: 24px 0 48px rgba(0, 0, 0, 0.45);
  }

  .nav-open .side {
    transform: translateX(0);
  }

  .nav-open .nav-mask {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 19;
    background: rgba(1, 4, 9, 0.6);
  }

  .nav-toggle {
    display: inline-flex;
  }

  .topbar {
    padding: 14px 16px 12px;
  }

  .body {
    padding: 16px;
  }
}
</style>
