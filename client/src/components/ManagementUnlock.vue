<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import { NInput, NButton, NAlert } from "naive-ui";
import { LockKeyhole } from "lucide-vue-next";
import { api } from "../api";
const emit = defineEmits<{ unlocked: [] }>();
const token = ref(""),
  busy = ref(false),
  error = ref("");
async function unlock() {
  busy.value = true;
  error.value = "";
  const value = token.value;
  token.value = "";
  try {
    await api.unlock(value);
    emit("unlocked");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
onUnmounted(() => {
  token.value = "";
});
</script>
<template>
  <section class="management-unlock" aria-labelledby="unlock-title">
    <LockKeyhole :size="30" class="auth-symbol" />
    <h1 id="unlock-title">解锁页面哨兵</h1>
    <p>此服务已启用身份保护。解锁后可查看监控和私人内容。</p>
    <form @submit.prevent="unlock">
      <label for="admin-token">管理令牌</label>
      <NInput
        id="admin-token"
        :input-props="{
          id: 'admin-token-input',
          autocomplete: 'off',
          'aria-label': '管理令牌',
        }"
        v-model:value="token"
        type="password"
        placeholder="输入 ADMIN_TOKEN"
        :disabled="busy"
      />
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NButton
        attr-type="submit"
        type="primary"
        :loading="busy"
        :disabled="!token.trim()"
        >解锁管理入口</NButton
      >
    </form>
    <p class="field-help">令牌仅用于本次解锁，不保存到浏览器本地存储。</p>
  </section>
</template>
