import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { adminApi } from "../api";
import { clearSession, readToken, readUser, writeSession } from "../api/session";
import type { UserSummary } from "../types";

export const useAuthStore = defineStore("auth", () => {
  const token = ref<string | null>(readToken());
  const user = ref<UserSummary | null>(readUser());

  const isAdmin = computed(() => user.value?.role === "admin");
  const displayName = computed(() => user.value?.displayName || user.value?.email || "未知用户");

  async function login(email: string, password: string): Promise<void> {
    const session = await adminApi.login(email.trim(), password);
    writeSession(session.token, session.user);
    token.value = session.token;
    user.value = session.user;
  }

  async function logout(): Promise<void> {
    try {
      if (token.value) {
        await adminApi.logout();
      }
    } finally {
      clearSession();
      token.value = null;
      user.value = null;
    }
  }

  function forget(): void {
    clearSession();
    token.value = null;
    user.value = null;
  }

  return { token, user, isAdmin, displayName, login, logout, forget };
});
