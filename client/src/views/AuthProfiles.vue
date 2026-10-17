<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NAlert, NSkeleton, useDialog, useMessage } from "naive-ui";
import { Plus, KeyRound, RefreshCw, Trash2 } from "lucide-vue-next";
import type {
  AuthProfileInput,
  AuthProfileSummary,
  Monitor,
} from "../../../shared/types";
import { api, formatTime, managementSession } from "../api";
import AuthProfileEditor from "../components/AuthProfileEditor.vue";
const route = useRoute(),
  router = useRouter();
const monitorId =
  typeof route.query.monitor === "string" ? route.query.monitor : "";
const sourceMonitor = ref<Monitor | null>(null),
  bindingId = ref("");
const initial = computed<Partial<AuthProfileInput>>(() =>
  sourceMonitor.value
    ? {
        name: `${sourceMonitor.value.name} 登录`.slice(0, 120),
        loginUrl: sourceMonitor.value.url,
        verificationUrl: sourceMonitor.value.url,
        allowedHosts: [new URL(sourceMonitor.value.url).hostname],
      }
    : {},
);
const compatibleProfiles = computed(() =>
  sourceMonitor.value
    ? profiles.value.filter((p) =>
        p.allowedHosts.includes(new URL(sourceMonitor.value!.url).hostname),
      )
    : [],
);
const canBind = computed(() =>
  compatibleProfiles.value.some(
    (p) => p.id === bindingId.value && p.status === "READY",
  ),
);
const generateKeys = `node -e "const {randomBytes}=require('node:crypto'); console.log('ADMIN_TOKEN='+randomBytes(32).toString('base64url')); console.log('AUTH_MASTER_KEY='+randomBytes(32).toString('base64'))"`;
const profiles = ref<AuthProfileSummary[]>([]),
  loading = ref(true),
  error = ref(""),
  show = ref(false),
  selected = ref<AuthProfileSummary | null>(null),
  busy = ref("");
const message = useMessage(),
  dialog = useDialog();
const labels = {
  EMPTY: "等待登录",
  READY: "已验证",
  NEEDS_LOGIN: "需要重新登录",
};
async function load() {
  try {
    if (monitorId) {
      sourceMonitor.value = await api.get(monitorId);
      if (!bindingId.value)
        bindingId.value = sourceMonitor.value.authProfileId ?? "";
    }
    if (managementSession.required) profiles.value = await api.profiles();
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
async function saved(profile: AuthProfileSummary) {
  bindingId.value = profile.id;
  await load();
}
async function bind() {
  if (!sourceMonitor.value || !canBind.value) return;
  busy.value = "bind";
  error.value = "";
  try {
    const monitor = sourceMonitor.value;
    if (monitor.authProfileId !== bindingId.value)
      await api.update(monitor.id, {
        authProfileId: bindingId.value,
        authSuccessSelector: "",
      });
    await api.check(monitor.id);
    await router.push(`/monitors/${encodeURIComponent(monitor.id)}`);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = "";
  }
}
function edit(p: AuthProfileSummary | null) {
  selected.value = p;
  show.value = true;
}
async function verify(p: AuthProfileSummary) {
  busy.value = p.id;
  try {
    await api.verifyProfile(p.id);
    message.success("部署端验证通过；成功标记匹配的任务已解除阻塞。");
    await load();
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    busy.value = "";
  }
}
function remove(p: AuthProfileSummary) {
  dialog.warning({
    title: "删除登录身份",
    content: p.boundCount
      ? `仍关联 ${p.boundCount} 个任务，请先在任务编辑器解除绑定。`
      : `删除“${p.name}”的状态，已有历史仍受管理鉴权保护。`,
    positiveText: p.boundCount ? undefined : "删除身份",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await api.deleteProfile(p.id);
        await load();
      } catch (e) {
        message.error((e as Error).message);
      }
    },
  });
}
onMounted(load);
</script>
<template>
  <section class="auth-page">
    <div class="page-heading">
      <div>
        <h1>登录身份</h1>
        <p>一次登录，让监控安全延续。失效时保留内容，等待你重新授权。</p>
      </div>
      <NButton
        v-if="managementSession.required"
        type="primary"
        @click="edit(null)"
        ><template #icon><Plus :size="17" /></template>新建登录身份</NButton
      >
    </div>
    <section
      v-if="sourceMonitor"
      class="auth-task-context"
      aria-label="当前任务登录配置"
    >
      <h2>为“{{ sourceMonitor.name }}”配置登录</h2>
      <p>{{ sourceMonitor.url }}</p>
      <p>
        先创建或管理身份，在专用窗口完成登录并保存，或导入已有状态。服务端验证通过后，再绑定到这个任务并重新检查。
      </p>
      <template v-if="managementSession.required">
        <label
          >此任务使用的身份<select
            v-model="bindingId"
            class="auth-select"
            aria-label="此任务使用的身份"
            :disabled="busy === 'bind'"
          >
            <option value="">请选择已验证的身份</option>
            <option
              v-for="p in compatibleProfiles"
              :key="p.id"
              :value="p.id"
              :disabled="p.status !== 'READY'"
            >
              {{ p.name }} · {{ labels[p.status] }}
            </option>
          </select></label
        >
        <div class="auth-actions">
          <NButton
            type="primary"
            :disabled="!canBind"
            :loading="busy === 'bind'"
            @click="bind"
            >绑定身份并重新检查</NButton
          ><RouterLink :to="`/monitors/${sourceMonitor.id}`"
            >返回监控</RouterLink
          >
        </div>
        <p class="field-help">
          更换身份会重新建立基线，任务原有的自动监控开关保持。已验证身份仍遇到
          403 时，需要检查该页面的权限或站点访问限制。
        </p>
      </template>
    </section>
    <NAlert
      v-if="!managementSession.required"
      type="info"
      :show-icon="false"
      class="auth-setup"
    >
      <strong>先启用登录身份保护</strong>
      <ol>
        <li>
          在项目终端运行下方命令，将生成的两行配置写入本地
          <code>.env</code>；已有密钥请保留，不要覆盖。
        </li>
        <li>
          重启本地 <code>npm run dev</code>；Docker
          部署需重新创建服务以读取配置。
        </li>
        <li>
          刷新本页，用 <code>ADMIN_TOKEN</code> 解锁管理入口，再创建登录身份。
        </li>
      </ol>
      <pre>{{ generateKeys }}</pre>
      <p>
        ADMIN_TOKEN 用于解锁本应用，AUTH_MASTER_KEY
        用于加密目标站点的登录状态。启用后所有监控数据都需要管理解锁，请妥善保管两项配置。
      </p>
    </NAlert>
    <NAlert v-if="error" type="error" role="alert"
      >{{ error }}<NButton text @click="load">重试</NButton></NAlert
    >
    <NSkeleton v-if="loading" height="160px" />
    <div
      v-else-if="managementSession.required && !profiles.length"
      class="auth-empty"
    >
      <KeyRound :size="32" />
      <h2>先添加一个登录身份</h2>
      <p>配置允许的主机和登录成功标记，再导入状态或运行本机助手。</p>
      <NButton @click="edit(null)">创建第一个身份</NButton>
    </div>
    <div v-else class="auth-profile-list">
      <article v-for="p in profiles" :key="p.id" class="auth-profile-row">
        <KeyRound :size="21" class="auth-symbol" />
        <div class="auth-profile-info">
          <button class="auth-profile-name" @click="edit(p)">
            {{ p.name }}
          </button>
          <p class="auth-hosts">{{ p.allowedHosts.join(" · ") }}</p>
          <small
            >{{
              p.source === "CAPTURE"
                ? "专用窗口"
                : p.source === "IMPORT"
                  ? "导入状态"
                  : "尚未授权"
            }}
            · {{ p.boundCount }} 个关联任务 · 最后验证
            {{ formatTime(p.verifiedAt) }}</small
          >
          <p v-if="p.errorCode" class="auth-problem">
            状态不可用，请重新授权或检查部署密钥。
          </p>
        </div>
        <span
          class="auth-profile-status"
          :class="{ ready: p.status === 'READY' }"
          >{{ labels[p.status] }}</span
        >
        <div class="auth-actions">
          <NButton
            :loading="busy === p.id"
            :disabled="p.status === 'EMPTY'"
            @click="verify(p)"
            ><template #icon><RefreshCw :size="15" /></template>验证</NButton
          ><NButton @click="edit(p)">管理 / 登录</NButton
          ><NButton
            quaternary
            :aria-label="`删除身份 ${p.name}`"
            @click="remove(p)"
            ><Trash2 :size="17"
          /></NButton>
        </div>
      </article>
    </div>
    <AuthProfileEditor
      v-model:show="show"
      :profile="selected"
      :initial="initial"
      @saved="saved"
    />
  </section>
</template>
