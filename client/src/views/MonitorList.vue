<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onMounted,
  onUnmounted,
  ref,
} from "vue";
import { useRouter } from "vue-router";
import {
  NButton,
  NInput,
  NSkeleton,
  NSwitch,
  NAlert,
  useMessage,
} from "naive-ui";
import {
  Plus,
  Search,
  ArrowUpRight,
  Play,
  Focus,
  FileText,
  List,
  ArrowRight,
  RefreshCw,
  Sparkles,
  ScanLine,
  Clock3,
} from "lucide-vue-next";
import type { Monitor } from "../../../shared/types";
import {
  api,
  domain,
  formatTime,
  formatInterval,
  formatCountdown,
  relativeTime,
  statusLabel,
} from "../api";
const MonitorEditor = defineAsyncComponent(
  () => import("../components/MonitorEditor.vue"),
);

const router = useRouter(),
  message = useMessage();
const monitors = ref<Monitor[]>([]),
  loading = ref(true),
  error = ref(""),
  query = ref(""),
  filter = ref("all"),
  editor = ref(false);
const busy = ref(new Set<string>());
const now = ref(Date.now());
const refreshingAll = ref(false),
  startingRefresh = ref(false);
const options = [
  { label: "全部任务", value: "all" },
  { label: "监控中", value: "enabled" },
  { label: "已暂停", value: "paused" },
  { label: "检查失败", value: "failed" },
];
const filtered = computed(() =>
  monitors.value.filter(
    (m) =>
      (!query.value ||
        `${m.name} ${m.url}`
          .toLowerCase()
          .includes(query.value.toLowerCase())) &&
      (filter.value === "all" ||
        (filter.value === "enabled" && m.enabled) ||
        (filter.value === "paused" && !m.enabled) ||
        (filter.value === "failed" &&
          (m.lastStatus === "FAILED" || !!m.authBlockedCode))),
  ),
);
let timer: ReturnType<typeof setInterval>,
  fetching = false,
  mutationVersion = 0;
async function load() {
  now.value = Date.now();
  if (fetching) return;
  fetching = true;
  const version = mutationVersion;
  try {
    const [items, settings] = await Promise.all([api.list(), api.settings()]);
    if (version !== mutationVersion) return;
    monitors.value = items;
    if (refreshingAll.value && !settings.refreshingAll) {
      message.success("全部任务已完成本轮刷新");
    }
    refreshingAll.value = settings.refreshingAll;
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
    fetching = false;
  }
}
async function checkAll() {
  startingRefresh.value = true;
  try {
    const { total, blocked } = await api.checkAll();
    mutationVersion++;
    refreshingAll.value = total > 0;
    message.info(
      total
        ? `已开始刷新全部 ${total} 个任务，包含已暂停任务${blocked.length ? `；${blocked.length} 个任务因登录阻塞保留原结果` : ""}`
        : "暂无可刷新的任务",
    );
    await load();
  } catch (e) {
    message.error((e as Error).message);
    await load();
  } finally {
    startingRefresh.value = false;
  }
}
async function toggle(m: Monitor) {
  busy.value.add(m.id);
  try {
    const updated = await api.update(m.id, { enabled: !m.enabled });
    mutationVersion++;
    monitors.value = monitors.value.map((item) =>
      item.id === m.id ? { ...item, ...updated } : item,
    );
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    busy.value.delete(m.id);
  }
}
async function check(m: Monitor) {
  busy.value.add(m.id);
  try {
    const result = await api.check(m.id);
    message.info(
      result.discarded
        ? "规则已修改，已丢弃旧结果"
        : (statusLabel[result.status ?? ""] ?? "检查完成"),
    );
    await load();
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    busy.value.delete(m.id);
  }
}
function saved(m: Monitor) {
  void router.push(`/monitors/${m.id}`);
}
onMounted(() => {
  void load();
  timer = setInterval(load, 3000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="page-heading list-heading">
    <div>
      <h1>
        监控任务<span class="heading-spark" aria-hidden="true"
          ><Sparkles :size="28"
        /></span>
      </h1>
      <p>网页的变化，留给哨兵。你的时间，留给自己。</p>
    </div>
    <NButton
      type="primary"
      size="large"
      class="create-monitor-button"
      @click="editor = true"
      ><template #icon><Plus :size="18" /></template>新建监控</NButton
    >
  </div>
  <NAlert v-if="error" type="error" class="page-alert" role="alert"
    >{{ error }}<NButton text @click="load">重新加载</NButton></NAlert
  >
  <div class="list-toolbar">
    <div class="filter-tabs" role="group" aria-label="筛选任务状态">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        :aria-pressed="filter === option.value"
        :class="{ active: filter === option.value }"
        @click="filter = option.value"
      >
        {{ option.label }}
      </button>
    </div>
    <div class="list-search">
      <NInput
        v-model:value="query"
        placeholder="搜索名称或网址"
        :input-props="{ 'aria-label': '搜索监控' }"
        clearable
        ><template #prefix><Search :size="16" /></template
      ></NInput>
    </div>
    <span class="task-count">{{ filtered.length }} 个任务</span>
    <NButton
      class="refresh-all-button"
      :loading="startingRefresh || refreshingAll"
      :disabled="
        loading || !monitors.length || startingRefresh || refreshingAll
      "
      title="立即检查所有任务，包含已暂停任务"
      @click="checkAll"
      ><template #icon><RefreshCw :size="16" /></template
      >{{ refreshingAll ? "正在刷新全部" : "强制刷新全部" }}</NButton
    >
  </div>
  <div v-if="loading" class="list-loading" aria-label="正在加载">
    <NSkeleton v-for="n in 3" :key="n" height="82px" />
  </div>
  <section v-else-if="!monitors.length && !error" class="empty-state">
    <div class="empty-radar" aria-hidden="true">
      <span class="radar-ring ring-one"></span
      ><span class="radar-ring ring-two"></span
      ><Focus :size="46" :stroke-width="1.5" /><span
        class="radar-signal"
      ></span>
    </div>
    <h2>好奇的事，让哨兵替你盯着。</h2>
    <p>
      更新日志的一行改动，或公告列表的一篇新文章。<br />选定区域，测试规则，哨兵就会开始留意。
    </p>
    <NButton type="primary" @click="editor = true"
      >创建第一个监控<template #icon><Plus :size="16" /></template
    ></NButton>
    <div class="empty-modes">
      <span><FileText :size="16" /> 区域变化</span
      ><span><List :size="16" /> 列表新增条目</span>
    </div>
  </section>
  <section v-else-if="!filtered.length && !error" class="empty-state compact">
    <Search :size="30" />
    <h2>没有匹配的监控</h2>
    <p>试试其他名称、网址或任务状态。</p>
    <NButton
      @click="
        query = '';
        filter = 'all';
      "
      >清除筛选</NButton
    >
  </section>
  <div v-else-if="filtered.length" class="monitor-table">
    <div class="monitor-table-head">
      <span>监控页面</span><span>模式</span><span>最近结果</span
      ><span>最近变化 / 下次检查</span><span>自动监控</span><span>操作</span>
    </div>
    <article v-for="m in filtered" :key="m.id" class="monitor-row">
      <div class="monitor-name">
        <span class="monitor-avatar" :class="m.mode.toLowerCase()"
          ><ScanLine v-if="m.mode === 'TEXT'" :size="23" /><List
            v-else
            :size="23"
        /></span>
        <div class="monitor-title-group">
          <RouterLink :to="`/monitors/${m.id}`"
            >{{ m.name }}<ArrowUpRight :size="15" /></RouterLink
          ><span
            >{{ domain(m.url) }} · 每
            {{ formatInterval(m.intervalMinutes) }}</span
          >
        </div>
      </div>
      <div class="monitor-mode">
        <FileText v-if="m.mode === 'TEXT'" :size="15" /><List
          v-else
          :size="15"
        />{{ m.mode === "TEXT" ? "文本" : "列表" }}
      </div>
      <div class="monitor-status">
        <span
          class="status-text"
          :class="{
            failed:
              (m.lastStatus === 'FAILED' || !!m.authBlockedCode) && m.enabled,
            paused: !m.enabled,
          }"
          ><span
            class="state-dot"
            :class="{
              danger:
                (m.lastStatus === 'FAILED' || !!m.authBlockedCode) && m.enabled,
              muted: !m.enabled,
              pulse: m.running,
            }"
          ></span
          >{{
            m.running
              ? "检查中…"
              : m.authBlockedCode
                ? statusLabel[m.authBlockedCode]
                : !m.enabled
                  ? "已暂停"
                  : m.lastStatus
                    ? statusLabel[m.lastStatus]
                    : "等待首次检查"
          }}</span
        ><span :title="formatTime(m.lastCheckedAt)"
          >{{
            m.lastStatus && (!m.enabled || m.running)
              ? `${statusLabel[m.lastStatus]} · `
              : ""
          }}{{ relativeTime(m.lastCheckedAt) }}</span
        >
        <RouterLink v-if="m.authBlockedCode" to="/auth-profiles"
          >重新登录 / 验证</RouterLink
        >
      </div>
      <div class="monitor-times">
        <div class="monitor-time-line">
          <span class="monitor-time-label">变化</span>
          <time
            v-if="m.lastChangedAt"
            class="monitor-time-value"
            :datetime="new Date(m.lastChangedAt).toISOString()"
            >{{ formatTime(m.lastChangedAt) }}</time
          >
          <span v-else class="monitor-time-value">尚无变化</span>
        </div>
        <div class="monitor-time-line">
          <span class="monitor-time-label">下次</span>
          <span
            class="next-check-countdown"
            :class="{ 'is-paused': !m.enabled }"
            :title="
              m.enabled
                ? `计划时间：${formatTime(m.nextRunAt)}`
                : '已暂停自动检查，仍可手动刷新'
            "
          >
            <Clock3 :size="13" />{{
              m.running
                ? "正在检查"
                : m.authBlockedCode
                  ? "等待重新授权"
                  : !m.enabled
                    ? "仅手动检查"
                    : m.nextRunAt <= now
                      ? "等待调度"
                      : `${formatCountdown(m.nextRunAt, now)}后`
            }}
          </span>
        </div>
      </div>
      <div class="row-auto-monitoring">
        <span class="mobile-field-label">自动监控</span>
        <NSwitch
          :value="m.enabled"
          :loading="busy.has(m.id)"
          :disabled="busy.has(m.id)"
          :aria-label="`${m.name} 自动监控`"
          @update:value="toggle(m)"
        />
      </div>
      <div class="row-actions">
        <NButton
          quaternary
          circle
          :disabled="m.running || busy.has(m.id)"
          :aria-label="`立即检查 ${m.name}`"
          title="立即检查"
          @click="check(m)"
          ><Play :size="16" /></NButton
        ><RouterLink
          :to="`/monitors/${m.id}`"
          class="detail-link"
          :aria-label="`查看 ${m.name}`"
          ><ArrowRight :size="17"
        /></RouterLink>
      </div>
    </article>
  </div>
  <MonitorEditor v-if="editor" v-model:show="editor" @saved="saved" />
</template>
