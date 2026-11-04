<script setup lang="ts">
import { Lock, User } from "@element-plus/icons-vue";
import type { FormInstance, FormRules } from "element-plus";
import { ElMessage } from "element-plus";
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError } from "../api/http";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const formRef = ref<FormInstance>();
const loading = ref(false);
const error = ref("");
const form = reactive({ email: "", password: "" });

const rules: FormRules = {
  email: [
    { required: true, message: "请输入管理员邮箱", trigger: "blur" },
    { type: "email", message: "邮箱格式不正确", trigger: "blur" },
  ],
  password: [{ required: true, message: "请输入密码", trigger: "blur" }],
};

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) {
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    await auth.login(form.email, form.password);
    ElMessage.success("欢迎回来");
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/";
    await router.replace(redirect);
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "登录失败，请稍后再试";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login">
    <section class="intro">
      <div class="intro-brand">
        <span class="mark">G</span>
        <span>GreyWork</span>
      </div>
      <h1>运维台</h1>
      <p>
        用户、设备、宿主、通道与模型用量的统一控制面。只有
        <code>role=admin</code> 的账号可以进入。
      </p>
      <ul class="points">
        <li><b>账号密码</b>登录，凭据只存 bcrypt 哈希</li>
        <li>禁用 / 踢下线 / 吊销设备即时生效</li>
        <li>所有运维动作写入审计日志</li>
      </ul>
      <div class="intro-foot">GreyWork Control Plane</div>
    </section>

    <section class="panel">
      <div class="panel-inner">
        <h2>管理员登录</h2>
        <p class="hint">初始密码来自 GREY_ADMIN_PASSWORD；未配置时见后端首次启动日志。</p>

        <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="alert" />

        <el-form ref="formRef" :model="form" :rules="rules" label-position="top" size="large" @submit.prevent="submit">
          <el-form-item label="邮箱" prop="email">
            <el-input v-model="form.email" placeholder="admin@example.com" autocomplete="username">
              <template #prefix
                ><el-icon><User /></el-icon
              ></template>
            </el-input>
          </el-form-item>
          <el-form-item label="密码" prop="password">
            <el-input
              v-model="form.password"
              type="password"
              show-password
              placeholder="••••••••"
              autocomplete="current-password"
              @keyup.enter="submit"
            >
              <template #prefix
                ><el-icon><Lock /></el-icon
              ></template>
            </el-input>
          </el-form-item>
          <el-button class="submit" type="primary" :loading="loading" native-type="submit" @click="submit"> 进入运维台 </el-button>
        </el-form>

        <p class="foot">普通用户请使用客户端的入场码登录，这里不接受普通账号。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.login {
  min-height: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 460px;
  background:
    radial-gradient(760px 460px at 18% 8%, rgba(88, 166, 255, 0.16), transparent 60%),
    radial-gradient(620px 420px at 92% 96%, rgba(63, 185, 80, 0.1), transparent 62%), var(--gw-bg);
}

.intro {
  padding: 64px 72px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  border-right: 1px solid var(--gw-line-soft);
}

.intro-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--gw-dim);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.mark {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: linear-gradient(140deg, #58a6ff, #7ee787);
  color: #06121f;
  font-weight: 700;
  font-size: 16px;
}

.intro h1 {
  margin: 26px 0 10px;
  font-size: 44px;
  line-height: 1.08;
  letter-spacing: -0.03em;
  font-weight: 600;
}

.intro p {
  max-width: 460px;
  margin: 0;
  color: var(--gw-dim);
  font-size: 13.5px;
  line-height: 1.8;
}

.intro code {
  color: var(--gw-accent);
  background: rgba(88, 166, 255, 0.1);
  border-radius: 4px;
  padding: 1px 5px;
}

.points {
  margin: 28px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: #b6c0cb;
  font-size: 12.5px;
}

.points li {
  display: flex;
  align-items: center;
  gap: 9px;
}

.points li::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--gw-mint);
}

.points b {
  color: var(--gw-text);
  font-weight: 500;
}

.intro-foot {
  margin-top: 44px;
  color: #4b5563;
  font-size: 10.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.panel {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: rgba(13, 17, 23, 0.6);
}

.panel-inner {
  width: 100%;
  max-width: 340px;
}

.panel h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.hint {
  margin: 6px 0 22px;
  color: var(--gw-dim);
  font-size: 11.5px;
  line-height: 1.6;
}

.alert {
  margin-bottom: 14px;
}

.submit {
  width: 100%;
  margin-top: 4px;
  height: 40px;
  font-weight: 500;
}

.foot {
  margin-top: 22px;
  color: #5b6572;
  font-size: 11px;
  line-height: 1.7;
}

@media (max-width: 900px) {
  .login {
    grid-template-columns: minmax(0, 1fr);
  }

  .intro {
    display: none;
  }
}
</style>
