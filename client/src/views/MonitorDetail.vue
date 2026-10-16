<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  inject,
  onMounted,
  onUnmounted,
  ref,
  watch,
  type Ref,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NButton,
  NAlert,
  NTabs,
  NTabPane,
  NPagination,
  NSkeleton,
  NSwitch,
  useMessage,
  useDialog,
} from "naive-ui";
import {
  ArrowLeft,
  ArrowUpRight,
  Play,
  Pencil,
  Trash2,
  Clock3,
  History,
  FileText,
  List,
  Check,
  CircleAlert,
  ImageOff,
  Power,
  Pause,
  ScanText,
} from "lucide-vue-next";
import type {
  Monitor,
  ChangeEvent,
  CheckRun,
  CurrentContent,
  CheckSource,
} from "../../../shared/types";
import { api, formatTime, formatInterval, statusLabel } from "../api";
const MonitorEditor = defineAsyncComponent(
  () => import("../components/MonitorEditor.vue"),
);
import ChangeDiff from "../components/ChangeDiff.vue";

const route = useRoute(),
  router = useRouter(),
  message = useMessage(),
  dialog = useDialog();
const ntfyConfigured = inject<Ref<boolean>>("ntfyConfigured", ref(false));
const id = computed(() => String(route.params.id));
const monitor = ref<Monitor | null>(null),
  events = ref<ChangeEvent[]>([]),
  checks = ref<CheckRun[]>([]);
const eventPage = ref(1),
  checkPage = ref(1),
  eventTotal = ref(0),
  checkTotal = ref(0);
const editor = ref(false),
  loading = ref(true),
  error = ref(""),
  busy = ref(false);
const current = ref<CurrentContent>({
    content: null,
    capturedAt: null,
    thumbnailAt: null,
  }),
  thumbnailFailed = ref(false);
const checkSourceLabel: Record<CheckSource, string> = {
  TASK_CONTROL: "任务开关",
  AUTO: "自动监控",
  MANUAL: "手动检查",
  CREATE: "创建任务",
  RULE_EDIT: "规则修改",
  MANUAL_BATCH: "全部刷新",
  LEGACY: "历史记录",
};
watch(
  () => current.value.thumbnailAt,
  () => {
    thumbnailFailed.value = false;
  },
);
let timer: ReturnType<typeof setInterval>,
  fetching = false,
  mutationVersion = 0;
async function load() {
  if (fetching) return;
  fetching = true;
  const version = mutationVersion;
  try {
    const [m, e, c, content] = await Promise.all([
      api.get(id.value),
      api.events(id.value, eventPage.value),
      api.checks(id.value, checkPage.value),
      api.current(id.value),
    ]);
    if (version !== mutationVersion) return;
    monitor.value = m;
    events.value = e.items;
    eventTotal.value = e.total;
    checks.value = c.items;
    checkTotal.value = c.total;
    current.value = content;
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
    fetching = false;
  }
}
async function check() {
  if (!monitor.value) return;
  busy.value = true;
  try {
    const result = await api.check(id.value);
    message.info(
      result.discarded
        ? "规则已修改，已丢弃旧结果"
        : (statusLabel[result.status ?? ""] ?? "检查完成"),
    );
    await load();
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    busy.value = false;
  }
}
async function toggle() {
  if (!monitor.value) return;
  busy.value = true;
  try {
    const updated = await api.update(id.value, {
      enabled: !monitor.value.enabled,
    });
    mutationVersion++;
    monitor.value = { ...monitor.value, ...updated };
    checkPage.value = 1;
    const history = await api.checks(id.value);
    checks.value = history.items;
    checkTotal.value = history.total;
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    busy.value = false;
  }
}
function remove() {
  dialog.warning({
    title: "删除这个监控？",
    content: "任务、快照、变化历史和待发通知将一并删除。此操作无法撤销。",
    positiveText: "删除监控",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await api.delete(id.value);
        message.success("监控已删除");
        await router.push("/");
      } catch (e) {
        message.error((e as Error).message);
        return false;
      }
    },
  });
}
function changeEventPage(page: number) {
  eventPage.value = page;
  void load();
}
function changeCheckPage(page: number) {
  checkPage.value = page;
  void load();
}
onMounted(() => {
  void load();
  timer = setInterval(load, 3000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <RouterLink to="/" class="back-link"
    ><ArrowLeft :size="16" /> 所有监控</RouterLink
  >
  <NAlert v-if="error" type="error" class="page-alert" role="alert"
    >{{ error }}<NButton text @click="load">重新加载</NButton></NAlert
  >
  <NSkeleton v-if="loading" height="240px" />
  <template v-if="monitor">
    <div class="page-heading detail-heading">
      <div>
        <div class="title-line">
          <span class="detail-monitor-icon"
            ><FileText v-if="monitor.mode === 'TEXT'" :size="26" /><List
              v-else
              :size="26"
          /></span>
          <h1>{{ monitor.name }}</h1>
          <span class="simple-badge" :class="{ paused: !monitor.enabled }"
            ><span
              class="state-dot"
              :class="{
                muted: !monitor.enabled,
                pulse: monitor.running,
              }"
            ></span
            >{{
              monitor.running
                ? "检查中…"
                : monitor.enabled
                  ? "监控中"
                  : "已暂停"
            }}</span
          >
        </div>
        <a
          class="source-link"
          :href="monitor.url"
          target="_blank"
          rel="noopener noreferrer"
          >{{ monitor.url }}<ArrowUpRight :size="14"
        /></a>
      </div>
      <div class="detail-commands">
        <div class="detail-automation" :class="{ enabled: monitor.enabled }">
          <span class="detail-automation-icon"><Power :size="19" /></span>
          <div class="detail-automation-copy">
            <div class="detail-automation-title">
              <span>自动监控</span>
              <span class="detail-automation-status">{{
                monitor.enabled ? "已开启" : "已暂停"
              }}</span>
            </div>
            <p>
              {{
                monitor.enabled
                  ? `后台每 ${formatInterval(monitor.intervalMinutes)} 检查`
                  : "随时可用「立即检查」手动刷新"
              }}
            </p>
          </div>
          <NSwitch
            :value="monitor.enabled"
            :loading="busy"
            :disabled="busy"
            aria-label="本任务自动监控"
            @update:value="toggle"
          />
        </div>
        <div class="detail-actions">
          <NButton :disabled="busy" @click="editor = true"
            ><template #icon><Pencil :size="15" /></template>编辑规则</NButton
          ><NButton
            type="primary"
            :loading="busy || monitor.running"
            :disabled="monitor.running"
            @click="check"
            ><template #icon><Play :size="15" /></template>立即检查</NButton
          >
          <NButton type="error" :disabled="busy" @click="remove"
            ><template #icon><Trash2 :size="15" /></template>删除监控</NButton
          >
        </div>
      </div>
    </div>
    <NAlert
      v-if="monitor.lastStatus === 'FAILED'"
      type="error"
      class="page-alert"
      :show-icon="false"
      ><strong>最近一次检查失败</strong>
      <p>
        {{ monitor.lastError }} 已保留上次成功采集的内容。{{
          monitor.enabled ? "自动检查将退避重试。" : "可手动立即检查重试。"
        }}
      </p></NAlert
    >
    <section class="rule-summary" aria-label="规则摘要">
      <div>
        <span>监控模式</span
        ><strong
          ><FileText v-if="monitor.mode === 'TEXT'" :size="15" /><List
            v-else
            :size="15"
          />{{ monitor.mode === "TEXT" ? "区域变化" : "列表新增条目" }}</strong
        >
      </div>
      <div>
        <span>CSS 选择器</span><code>{{ monitor.selector }}</code>
      </div>
      <div>
        <span>检查间隔</span
        ><strong>每 {{ formatInterval(monitor.intervalMinutes) }}</strong>
      </div>
      <div>
        <span>下次检查</span
        ><strong>{{
          monitor.enabled ? formatTime(monitor.nextRunAt) : "本任务已暂停"
        }}</strong>
      </div>
      <div
        class="rule-extra"
        v-if="monitor.mode === 'TEXT' && monitor.ignoreSelectors?.length"
      >
        <span>排除子元素</span
        ><code>{{ monitor.ignoreSelectors.join("，") }}</code>
      </div>
      <div class="rule-extra" v-if="monitor.mode === 'LIST'">
        <span>字段提取</span
        ><code
          >标题：{{ monitor.titleSelector || "条目文本" }} · 链接：{{
            monitor.linkSelector || "唯一链接"
          }}</code
        >
      </div>
    </section>
    <NTabs type="line" class="history-tabs" animated>
      <NTabPane name="current" tab="当前内容">
        <div v-if="!current.content" class="empty-history">
          <ScanText :size="30" :stroke-width="1.4" />
          <h2>等待首次成功采集</h2>
          <p>点击立即检查后，可在这里查看网页缩略图和实际提取的内容。</p>
        </div>
        <section v-else class="current-content" aria-label="当前采集内容">
          <div class="current-content-heading">
            <div>
              <h2>最新成功采集</h2>
              <p>
                <time>{{ formatTime(current.capturedAt) }}</time
                ><span
                  >匹配 {{ current.content.matchCount }} 个{{
                    current.content.mode === "TEXT" ? "区域" : "条目"
                  }}</span
                ><span>{{
                  current.content.mode === "TEXT"
                    ? `${current.content.text.length} 字符`
                    : `${current.content.items.length} 个条目`
                }}</span>
              </p>
            </div>
            <span
              v-if="monitor.lastStatus === 'FAILED'"
              class="content-retained"
              >最近检查失败，显示上次成功内容</span
            >
          </div>
          <div class="current-content-grid">
            <figure class="page-thumbnail">
              <div class="current-section-heading">
                <strong>页面缩略图</strong
                ><span v-if="current.thumbnailAt">{{
                  formatTime(current.thumbnailAt)
                }}</span>
              </div>
              <a
                v-if="current.thumbnailAt && !thumbnailFailed"
                :href="api.thumbnail(id, current.thumbnailAt)"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="查看完整页面缩略图"
              >
                <img
                  :src="api.thumbnail(id, current.thumbnailAt)"
                  :alt="`${monitor.name} 最近成功采集的页面缩略图`"
                  @error="thumbnailFailed = true"
                />
              </a>
              <div v-else class="thumbnail-placeholder">
                <ImageOff :size="30" :stroke-width="1.4" />
                <strong>{{
                  thumbnailFailed ? "缩略图暂时无法加载" : "暂无页面缩略图"
                }}</strong>
                <p>
                  {{
                    thumbnailFailed
                      ? "请检查网络，或在下次检查后重试。"
                      : "旧采集记录没有缩略图，下次成功检查时生成。"
                  }}
                </p>
              </div>
              <figcaption>页面画面供参考，变化判断以提取内容为准。</figcaption>
            </figure>
            <div class="extracted-content">
              <div class="current-section-heading">
                <strong>{{
                  current.content.mode === "TEXT" ? "提取文本" : "提取条目"
                }}</strong
                ><span :title="monitor.selector">{{ monitor.selector }}</span>
              </div>
              <pre
                v-if="current.content.mode === 'TEXT'"
                class="current-text"
                >{{ current.content.text }}</pre>
              <ol v-else class="current-items">
                <li v-for="item in current.content.items" :key="item.key">
                  <a :href="item.url" target="_blank" rel="noopener noreferrer"
                    >{{ item.title }}<ArrowUpRight :size="15" /></a
                  ><span>{{ item.url }}</span>
                </li>
              </ol>
            </div>
          </div>
          <p class="baseline-note">
            首次采集建立基线，只有有效变化才会推送 ntfy。
          </p>
        </section>
      </NTabPane>
      <NTabPane name="events" :tab="`变化历史 · ${eventTotal}`">
        <div v-if="!events.length" class="empty-history">
          <History :size="30" :stroke-width="1.4" />
          <h2>
            {{
              monitor.baselineSnapshotId ? "还没有发现变化" : "等待首次有效采集"
            }}
          </h2>
          <p>
            {{
              monitor.baselineSnapshotId
                ? "当前内容已作为基线。下次发现有效变化时，证据会保存在这里。"
                : "首次成功检查只建立基线，后续变化才会出现在这里。"
            }}
          </p>
        </div>
        <div v-else class="event-timeline">
          <article v-for="event in events" :key="event.id" class="event-entry">
            <div class="event-meta">
              <time>{{ formatTime(event.createdAt) }}</time
              ><span
                :class="[
                  'notification-label',
                  { sent: event.notificationStatus === 'SENT' },
                ]"
                ><Check
                  v-if="event.notificationStatus === 'SENT'"
                  :size="13"
                /><Clock3 v-else :size="13" />{{
                  event.notificationStatus === "SENT"
                    ? "已推送 ntfy"
                    : !ntfyConfigured
                      ? "等待配置 ntfy"
                      : event.notificationAttempts
                        ? "推送失败，等待重试"
                        : "等待推送"
                }}</span
              >
            </div>
            <h2>
              {{
                event.detail.mode === "TEXT"
                  ? "区域变化"
                  : `发现 ${event.detail.items.length} 个新条目`
              }}
            </h2>
            <p
              v-if="
                event.notificationAttempts &&
                event.notificationStatus === 'PENDING'
              "
              class="notification-error"
            >
              {{ event.notificationError }} 下次重试：{{
                formatTime(event.nextNotificationAt)
              }}
            </p>
            <ChangeDiff
              v-if="event.detail.mode === 'TEXT'"
              :parts="event.detail.diff"
            />
            <ul v-else class="new-items" aria-label="本次新增条目">
              <li v-for="item in event.detail.items" :key="item.key">
                <a :href="item.url" target="_blank" rel="noopener noreferrer"
                  >{{ item.title }}<ArrowUpRight :size="15" /></a
                ><small>{{ item.url }}</small>
              </li>
            </ul>
          </article>
        </div>
        <NPagination
          v-if="eventTotal > 20"
          :page="eventPage"
          :page-size="20"
          :item-count="eventTotal"
          @update:page="changeEventPage"
        />
      </NTabPane>
      <NTabPane name="checks" :tab="`执行记录 · ${checkTotal}`"
        ><div v-if="!checks.length" class="empty-history">
          <Clock3 :size="30" />
          <h2>还没有执行记录</h2>
          <p>任务正在等待采集，你也可以手动立即检查。</p>
        </div>
        <div v-else class="check-history">
          <div class="check-table-head" aria-hidden="true">
            <span>检查结果 / 摘要</span><span>触发来源</span
            ><span>执行时间</span><span>耗时</span>
          </div>
          <div v-for="run in checks" :key="run.id" class="check-row">
            <div class="check-result">
              <strong
                :class="{
                  failed: run.status === 'FAILED',
                  success: run.status !== 'FAILED' && run.status !== 'DISABLED',
                  paused: run.status === 'DISABLED',
                }"
                ><CircleAlert v-if="run.status === 'FAILED'" :size="16" /><Power
                  v-else-if="run.status === 'ENABLED'"
                  :size="16"
                /><Pause
                  v-else-if="run.status === 'DISABLED'"
                  :size="16"
                /><Check v-else :size="16" />{{
                  statusLabel[run.status]
                }}</strong
              >
              <p class="check-summary">
                {{
                  run.summary ||
                  (run.status === "ENABLED"
                    ? "已开启本任务自动检查，将按设置的间隔执行。"
                    : run.status === "DISABLED"
                      ? "已关闭本任务自动检查，仍可手动检查。"
                      : run.status === "FAILED"
                        ? "本次采集未成功，保留上次有效内容。"
                        : run.status === "BASELINE"
                          ? "首次有效采集，已建立后续对比基线。"
                          : run.status === "CHANGED"
                            ? "发现有效变化，详情见变化历史。"
                            : "提取内容与上次有效采集一致。")
                }}
              </p>
              <p v-if="run.errorMessage || run.errorCode" class="check-error">
                <code v-if="run.errorCode">{{ run.errorCode }}</code
                >{{ run.errorMessage }}
              </p>
            </div>
            <span class="check-source">{{
              checkSourceLabel[run.source] || "历史记录"
            }}</span>
            <time>{{ formatTime(run.checkedAt) }}</time
            ><span class="check-duration">{{
              run.status === "ENABLED" || run.status === "DISABLED"
                ? "—"
                : `${(run.durationMs / 1000).toFixed(2)} 秒`
            }}</span>
          </div>
        </div>
        <NPagination
          v-if="checkTotal > 20"
          :page="checkPage"
          :page-size="20"
          :item-count="checkTotal"
          @update:page="changeCheckPage"
      /></NTabPane>
    </NTabs>
    <MonitorEditor
      v-if="editor"
      v-model:show="editor"
      :monitor="monitor"
      @saved="load"
    />
  </template>
</template>
