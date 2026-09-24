<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { login } from "@greywork/host-ipc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * 服务端态的登录门。
 *
 * 只有 password 一个字段：服务端是单用户自托管，没有用户名概念。密码经同源 POST
 * `/api/login` 换 HttpOnly cookie，成功后由 AuthGate 放行 Shell。
 *
 * 错误文案直接用服务端返回的 `error` 字段（密码错误 / 限流 / 未认证都是它），只在
 * 拿不到任何文案时才回落本地化的兜底句 —— 服务端比渲染端更清楚失败原因。
 */
const emit = defineEmits<{ authenticated: [] }>();
const { t } = useI18n();

const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit(): Promise<void> {
  if (busy.value) return;
  error.value = "";
  busy.value = true;
  try {
    await login(password.value);
    // 成功后立刻清空：密码没有理由在内存里多留一秒。
    password.value = "";
    emit("authenticated");
  } catch (cause) {
    error.value = cause instanceof Error && cause.message ? cause.message : t("auth.failed");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="grid size-full place-items-center bg-background px-4">
    <form class="w-full max-w-[320px]" data-testid="login-view" @submit.prevent="submit">
      <h1 class="text-[15px] font-medium text-foreground">{{ t("auth.title") }}</h1>
      <p class="mt-1 text-[11.5px] leading-relaxed text-dim2">{{ t("auth.subtitle") }}</p>

      <label class="mt-4 block">
        <span class="text-[11.5px] text-dim2">{{ t("auth.passwordLabel") }}</span>
        <Input
          v-model="password"
          type="password"
          autocomplete="current-password"
          autofocus
          class="mt-1"
          :placeholder="t('auth.passwordPlaceholder')"
          data-testid="login-password"
        />
      </label>

      <p v-if="error" class="mt-2 text-[11px] leading-relaxed text-destructive" data-testid="login-error">
        {{ error }}
      </p>

      <Button type="submit" class="mt-4 w-full" :disabled="busy" data-testid="login-submit">
        {{ busy ? t("auth.submitting") : t("auth.submit") }}
      </Button>
    </form>
  </div>
</template>
