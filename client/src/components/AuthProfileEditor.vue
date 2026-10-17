<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import {
  NDrawer,
  NDrawerContent,
  NForm,
  NFormItem,
  NInput,
  NButton,
  NAlert,
  NTabs,
  NTabPane,
  useDialog,
  useMessage,
} from "naive-ui";
import type {
  AuthProfileInput,
  AuthProfileSummary,
  AccountAction,
  CaptureSummary,
} from "../../../shared/types";
import { api } from "../api";
const props = defineProps<{
  show: boolean;
  profile: AuthProfileSummary | null;
  initial?: Partial<AuthProfileInput>;
}>();
const emit = defineEmits<{
  "update:show": [boolean];
  saved: [AuthProfileSummary];
}>();
const message = useMessage(),
  dialog = useDialog();
const current = ref<AuthProfileSummary | null>(null),
  tab = ref("config"),
  busy = ref(false),
  error = ref("");
const form = reactive<AuthProfileInput>({
  name: "",
  loginUrl: "",
  verificationUrl: "",
  allowedHosts: [],
  successSelector: "",
  loginUrlPrefix: "",
});
const hosts = ref(""),
  raw = ref(""),
  action = ref<AccountAction | null>(null);
const capture = ref<CaptureSummary | null>(null),
  code = ref(""),
  now = ref(Date.now());
const command = `npm run auth:login -- --server ${window.location.origin}`;
const choices = [
  { label: "同一账号更新 · 保留原基线", value: "SAME_ACCOUNT" },
  { label: "切换账号 · 重新建立基线", value: "SWITCH_ACCOUNT" },
];
function tabProps(name: string) {
  return {
    role: "tab",
    tabindex: tab.value === name ? 0 : -1,
    "aria-selected": tab.value === name,
    onKeydown: (event: KeyboardEvent) => {
      const names = current.value
        ? ["config", "import", "capture"]
        : ["config"];
      let next = name;
      if (event.key === "ArrowRight")
        next = names[(names.indexOf(name) + 1) % names.length]!;
      else if (event.key === "ArrowLeft")
        next = names[(names.indexOf(name) + names.length - 1) % names.length]!;
      else if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      tab.value = next;
      (event.currentTarget as HTMLElement)
        .closest('[role="tablist"]')
        ?.querySelector<HTMLElement>(`[data-auth-tab="${next}"]`)
        ?.focus();
    },
    "data-auth-tab": name,
  };
}
const terminal = (value: CaptureSummary | null) =>
  !!value &&
  ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(value.status);
const labels: Record<string, string> = {
  WAITING_HELPER: "等待本机助手连接",
  LOGGING_IN: "等待你完成登录 / MFA",
  SAVE_REQUESTED: "已请求保存，等待助手上传",
  VERIFYING: "部署端正在验证",
  COMPLETED: "验证通过，状态已加密保存",
  CANCELLED: "会话已取消，未保存新状态",
  EXPIRED: "会话已过期，请重新创建",
  FAILED: "未能保存，请检查登录或重新配对",
};
const countdown = computed(() => {
  const seconds = Math.max(
    0,
    Math.ceil(((capture.value?.expiresAt ?? 0) - now.value) / 1000),
  );
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
});
const summary = computed(() => {
  if (!raw.value.trim()) return "";
  try {
    const value = JSON.parse(raw.value),
      cookies = Array.isArray(value) ? value : (value.cookies ?? []),
      origins = Array.isArray(value.origins) ? value.origins : [];
    return `${cookies.length} 个 Cookie · ${origins.length} 个存储源 · 域：${[...new Set(cookies.map((c: any) => String(c.domain ?? "未指定")))].join("、") || "仅 origin 存储"} · ${cookies.filter((c: any) => c.expires > 0 && c.expires * 1000 < Date.now()).length} 个已过期`;
  } catch {
    return raw.value.trim().startsWith("#")
      ? "Netscape 格式不支持，请转换为 Cookie JSON。"
      : "Cookie 请求头将使用验证 URL 的精确主机；格式由服务端检查。";
  }
});
let polling: ReturnType<typeof setInterval> | undefined;
let fetching = false,
  generation = 0;
async function cleanup() {
  generation++;
  clearInterval(polling);
  raw.value = "";
  code.value = "";
  const previous = capture.value;
  capture.value = null;
  if (previous && !terminal(previous))
    await api.cancelCapture(previous.id).catch(() => {});
}
watch(
  () => props.show,
  (show) => {
    if (!show) {
      void cleanup();
      return;
    }
    current.value = props.profile;
    const p = props.profile ?? props.initial;
    Object.assign(form, {
      name: p?.name ?? "",
      loginUrl: p?.loginUrl ?? "",
      verificationUrl: p?.verificationUrl ?? "",
      allowedHosts: p?.allowedHosts ?? [],
      successSelector: p?.successSelector ?? "",
      loginUrlPrefix: p?.loginUrlPrefix ?? "",
    });
    hosts.value = form.allowedHosts.join("\n");
    raw.value = "";
    action.value = null;
    tab.value = "config";
    error.value = "";
  },
  { immediate: true },
);
async function saveConfig() {
  busy.value = true;
  error.value = "";
  try {
    const input = {
      ...form,
      allowedHosts: hosts.value.split(/[\s,，]+/).filter(Boolean),
      loginUrlPrefix: form.loginUrlPrefix?.trim() || "",
    };
    current.value = current.value
      ? await api.updateProfile(current.value.id, input)
      : await api.createProfile(input);
    message.success("身份配置已保存，请导入状态或在专用窗口登录。");
    if (!props.profile) tab.value = "capture";
    emit("saved", current.value);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function importState() {
  if (!current.value || !action.value) return;
  busy.value = true;
  error.value = "";
  const value = raw.value;
  raw.value = "";
  try {
    current.value = await api.importProfile(
      current.value.id,
      value,
      action.value,
    );
    message.success("部署端验证通过，状态已加密保存。");
    emit("saved", current.value);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function fileChanged(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file) return;
  raw.value = "";
  error.value = "";
  if (file.size > 2 * 1024 * 1024) {
    error.value = "文件超过 2 MiB，请导出必要域的登录状态后重试。";
    return;
  }
  const version = generation;
  try {
    const value = await file.text();
    if (props.show && version === generation) raw.value = value;
  } catch {
    error.value = "文件无法读取，请重新选择。";
  }
}
async function poll() {
  now.value = Date.now();
  if (!capture.value || fetching || terminal(capture.value)) return;
  fetching = true;
  const id = capture.value.id,
    version = generation;
  try {
    const value = await api.capture(id);
    if (version !== generation) return;
    capture.value = value;
    if (terminal(value)) {
      code.value = "";
      clearInterval(polling);
      if (value.status === "COMPLETED") {
        current.value =
          (await api.profiles()).find((p) => p.id === value.profileId) ??
          current.value;
        if (current.value) emit("saved", current.value);
      }
    }
  } catch (e) {
    if (version === generation) error.value = (e as Error).message;
  } finally {
    fetching = false;
  }
}
async function start() {
  if (!current.value || !action.value) return;
  busy.value = true;
  error.value = "";
  try {
    const value = await api.startCapture(current.value.id, action.value);
    capture.value = value;
    code.value = value.pairingCode;
    now.value = Date.now();
    polling = setInterval(poll, 2000);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function saveCapture() {
  if (!capture.value) return;
  busy.value = true;
  try {
    capture.value = await api.saveCapture(capture.value.id);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function cancel() {
  if (!capture.value) return;
  capture.value = await api
    .cancelCapture(capture.value.id)
    .catch(() => capture.value);
  code.value = "";
  clearInterval(polling);
}
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    message.success("已复制");
  } catch {
    message.info("请手动选择并复制上面的文本。");
  }
}
function revoke() {
  if (!current.value) return;
  dialog.warning({
    title: "清除登录状态",
    content: `关联的 ${current.value.boundCount} 个任务将登录阻塞，原内容与用户开关保留。`,
    positiveText: "清除登录态",
    negativeText: "取消",
    onPositiveClick: async () => {
      busy.value = true;
      try {
        current.value = await api.revokeProfile(current.value!.id);
        emit("saved", current.value);
      } catch (e) {
        error.value = (e as Error).message;
      } finally {
        busy.value = false;
      }
    },
  });
}
onUnmounted(() => {
  void cleanup();
});
</script>
<template>
  <NDrawer
    :show="show"
    :width="600"
    class="monitor-editor"
    :mask-closable="!busy"
    :close-on-esc="!busy"
    @update:show="emit('update:show', $event)"
  >
    <NDrawerContent
      :title="current ? current.name : '新建登录身份'"
      :closable="!busy"
    >
      <p class="field-help">
        只保存登录状态，不保存账号密码。已有状态和凭证值不会返回到页面。
      </p>
      <NTabs
        v-model:value="tab"
        type="line"
        role="tablist"
        aria-label="身份管理方式"
      >
        <NTabPane name="config" tab="身份配置" :tab-props="tabProps('config')">
          <NForm label-placement="top" @submit.prevent="saveConfig">
            <NFormItem label="身份名称"
              ><NInput
                v-model:value="form.name"
                :input-props="{ 'aria-label': '身份名称' }"
                :maxlength="120"
                :disabled="busy"
                placeholder="例如：工作站点账号"
            /></NFormItem>
            <NFormItem label="登录 URL"
              ><NInput
                v-model:value="form.loginUrl"
                :input-props="{ 'aria-label': '登录 URL' }"
                :disabled="busy"
                placeholder="https://example.com/login"
            /></NFormItem>
            <NFormItem label="验证 URL"
              ><NInput
                v-model:value="form.verificationUrl"
                :input-props="{ 'aria-label': '验证 URL' }"
                :disabled="busy"
                placeholder="https://example.com/account"
            /></NFormItem>
            <NFormItem label="批准主机（每行一个，最多 20 个）"
              ><NInput
                v-model:value="hosts"
                type="textarea"
                :input-props="{ 'aria-label': '批准主机' }"
                :disabled="busy"
                placeholder="example.com&#10;sso.example.org"
            /></NFormItem>
            <p class="field-help">
              目标、SSO 和 Cookie 父域分别批准。不自动信任子域或共享后缀。
            </p>
            <NFormItem label="登录成功标记 CSS"
              ><NInput
                v-model:value="form.successSelector"
                :input-props="{ 'aria-label': '登录成功标记 CSS' }"
                :disabled="busy"
                placeholder="仅登录后可见且唯一，如 .account-menu"
            /></NFormItem>
            <NFormItem label="登录跳转 URL 前缀（可选）"
              ><NInput
                v-model:value="form.loginUrlPrefix"
                :input-props="{ 'aria-label': '登录跳转 URL 前缀' }"
                :disabled="busy"
                placeholder="https://example.com/login"
            /></NFormItem>
            <NButton
              type="primary"
              :loading="busy"
              :disabled="!form.name.trim()"
              @click="saveConfig"
              >保存身份配置</NButton
            >
          </NForm>
        </NTabPane>
        <NTabPane
          name="import"
          tab="导入状态"
          :tab-props="tabProps('import')"
          :disabled="!current"
        >
          <NAlert type="info" :show-icon="false"
            >支持 Cookie JSON、Cookie 请求头和 storageState（含
            IndexedDB）。最大 2 MiB / 500 个 Cookie。不支持 Netscape 和
            sessionStorage。</NAlert
          >
          <NFormItem label="账号更新方式"
            ><select
              v-model="action"
              class="auth-select"
              :disabled="busy"
              aria-label="账号更新方式"
            >
              <option :value="null" disabled>请选择，服务端不会猜测账号</option>
              <option
                v-for="choice in choices"
                :key="choice.value"
                :value="choice.value"
              >
                {{ choice.label }}
              </option>
            </select></NFormItem
          >
          <label class="auth-file"
            >选择状态文件<input
              type="file"
              accept=".json,.txt,application/json,text/plain"
              :disabled="busy"
              @change="fileChanged"
          /></label>
          <NFormItem label="登录状态内容"
            ><NInput
              v-model:value="raw"
              type="textarea"
              :autosize="{ minRows: 6, maxRows: 12 }"
              :input-props="{
                'aria-label': '登录状态内容',
                autocomplete: 'off',
                spellcheck: false,
              }"
              :disabled="busy"
              placeholder="粘贴 Cookie JSON、Cookie: … 或 storageState"
          /></NFormItem>
          <p v-if="summary" class="auth-safe-summary" role="status">
            {{ summary }}
          </p>
          <NButton
            type="primary"
            :loading="busy"
            :disabled="!raw.trim() || !action"
            @click="importState"
            >验证并保存登录状态</NButton
          >
        </NTabPane>
        <NTabPane
          name="capture"
          tab="专用窗口登录"
          :tab-props="tabProps('capture')"
          :disabled="!current"
        >
          <NAlert type="info" :show-icon="false"
            >需在装有 Node 和完整 Chromium 的电脑终端运行助手。Docker
            只负责部署端采集；手机页面不会直接弹出电脑窗口。</NAlert
          >
          <NFormItem label="账号更新方式"
            ><select
              v-model="action"
              class="auth-select"
              :disabled="busy || (!!capture && !terminal(capture))"
              aria-label="专用窗口账号更新方式"
            >
              <option :value="null" disabled>请选择账号更新方式</option>
              <option
                v-for="choice in choices"
                :key="choice.value"
                :value="choice.value"
              >
                {{ choice.label }}
              </option>
            </select></NFormItem
          >
          <NButton
            v-if="!capture || terminal(capture)"
            type="primary"
            :loading="busy"
            :disabled="!action"
            @click="start"
            >创建一次性登录会话</NButton
          >
          <section v-if="capture" class="auth-capture" aria-live="polite">
            <h3>{{ labels[capture.status] }}</h3>
            <template v-if="!terminal(capture)">
              <p>剩余 {{ countdown }} · 配对码仅限此身份且只能使用一次。</p>
              <label
                >在电脑的项目目录运行<code>{{ command }}</code></label
              >
              <NButton size="small" @click="copy(command)"
                >复制助手命令</NButton
              >
              <template v-if="code"
                ><label
                  >终端提示后输入此配对码<code class="auth-pair-code">{{
                    code
                  }}</code></label
                ><NButton size="small" @click="copy(code)"
                  >复制一次性配对码</NButton
                ></template
              >
              <p>
                首次缺少浏览器时先运行
                <code>npm run browser:install</code>。登录、扫码和 MFA
                由你操作；只有下方明确保存才上传。
              </p>
              <div class="auth-actions">
                <NButton
                  type="primary"
                  :loading="busy"
                  :disabled="capture.status !== 'LOGGING_IN'"
                  @click="saveCapture"
                  >保存登录状态</NButton
                ><NButton @click="cancel">取消登录会话</NButton>
              </div>
            </template>
            <p v-if="capture.errorCode" class="field-help">
              {{ capture.errorCode }} · 请检查域范围、成功标记，必要时重新配对。
            </p>
          </section>
        </NTabPane>
      </NTabs>
      <NAlert v-if="error" type="error" role="alert" class="save-error">{{
        error
      }}</NAlert>
      <template #footer
        ><div class="drawer-footer">
          <span v-if="current">关联 {{ current.boundCount }} 个任务</span
          ><NButton v-if="current" :disabled="busy" @click="revoke"
            >清除登录态</NButton
          ><NButton :disabled="busy" @click="emit('update:show', false)"
            >关闭</NButton
          >
        </div></template
      >
    </NDrawerContent>
  </NDrawer>
</template>
