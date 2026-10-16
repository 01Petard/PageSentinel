<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from "vue";
import { useRouter } from "vue-router";
import { NPopover, NSwitch, useMessage } from "naive-ui";
import {
  Bell,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  Monitor,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-vue-next";
import type { CheckRun } from "../../../shared/types";
import { statusLabel } from "../api";
import { claimNotificationResults } from "../notification-delivery";

type Update = CheckRun & { monitorName: string; monitorUrl: string };
type UpdatesResponse = { items: Update[]; cursor: number; hasMore: boolean };
type Permission = NotificationPermission | "unsupported" | "insecure";

const keys = {
  page: "pagesentinel.notifications.page.v1",
  browser: "pagesentinel.notifications.browser.v1",
  read: "pagesentinel.notifications.read.v1",
  cleared: "pagesentinel.notifications.cleared.v1",
  delivered: "pagesentinel.notifications.delivered-ids.v1",
  lease: "pagesentinel.notifications.lease.v1",
};
const router = useRouter();
const message = useMessage();
const panelId = useId();
const pageLabelId = useId();
const browserLabelId = useId();
const storageAvailable = ref(true);

function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    storageAvailable.value = false;
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    storageAvailable.value = false;
  }
}

const pageEnabled = ref(readStorage(keys.page) !== "false");
const browserEnabled = ref(readStorage(keys.browser) === "true");
const readCursor = ref(Number(readStorage(keys.read)) || 0);
const savedClearedCursor = Number(readStorage(keys.cleared));
const clearedCursor = ref(
  Number.isSafeInteger(savedClearedCursor) && savedClearedCursor >= 0
    ? savedClearedCursor
    : 0,
);
const permission = ref<Permission>("unsupported");
const requestingPermission = ref(false);
const browserError = ref("");
const browserDeliveryMessage = ref("");
const panelOpen = ref(false);
const items = ref<Update[]>([]);
const loading = ref(true);
const loadError = ref("");
const unreadCount = computed(
  () => items.value.filter((item) => item.id > readCursor.value).length,
);
const browserActive = computed(
  () => browserEnabled.value && permission.value === "granted",
);
const permissionDescription = computed(() => {
  if (permission.value === "insecure")
    return "当前地址不是安全上下文。请通过 HTTPS 或 localhost 打开后启用。";
  if (permission.value === "unsupported")
    return "当前浏览器不支持网页系统通知，请使用支持通知的浏览器。";
  if (permission.value === "denied")
    return "浏览器已阻止通知。请在此站点的通知权限中改为允许，再重新启用。";
  if (permission.value === "default")
    return "启用时会请求此站点的通知权限，由你在浏览器中决定是否允许。";
  return browserActive.value
    ? "已获浏览器许可。macOS 未显示时，请检查系统设置中的浏览器通知和专注模式。"
    : "浏览器已允许通知，打开此开关即可接收后续监控结果。";
});
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

let cursor: number | null = null;
let deliveredIds: number[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let request: AbortController | undefined;
const pending = new Map<number, Update>();
const nativeNotifications = new Map<Notification, number>();

function refreshPermission() {
  try {
    permission.value = !window.isSecureContext
      ? "insecure"
      : !("Notification" in window)
        ? "unsupported"
        : Notification.permission;
  } catch {
    permission.value = "unsupported";
  }
}

function resultSummary(item: Update) {
  return (
    item.summary ||
    (item.status === "FAILED" ? item.errorMessage : null) ||
    statusLabel[item.status]
  );
}

function markRead() {
  readCursor.value = Math.max(readCursor.value, items.value[0]?.id || 0);
  writeStorage(keys.read, String(readCursor.value));
}

function applyClearedCursor(value: number) {
  clearedCursor.value = Math.max(clearedCursor.value, value);
  readCursor.value = Math.max(readCursor.value, clearedCursor.value);
  items.value = items.value.filter((item) => item.id > clearedCursor.value);
  for (const id of pending.keys())
    if (id <= clearedCursor.value) pending.delete(id);
  for (const [notification, id] of nativeNotifications) {
    if (id > clearedCursor.value) continue;
    try {
      notification.close();
    } catch {
      /* The browser may already have closed it. */
    }
    nativeNotifications.delete(notification);
  }
}

function clearNotifications() {
  const through = Math.max(
    clearedCursor.value,
    cursor ?? 0,
    items.value[0]?.id ?? 0,
    ...pending.keys(),
  );
  applyClearedCursor(through);
  writeStorage(keys.cleared, String(clearedCursor.value));
  writeStorage(keys.read, String(readCursor.value));
  browserDeliveryMessage.value = "";
}

function setPanelOpen(value: boolean) {
  panelOpen.value = value;
  if (value) {
    refreshPermission();
    markRead();
  }
}

function openResult(item: Update) {
  panelOpen.value = false;
  void router.push(`/monitors/${encodeURIComponent(item.monitorId)}`);
}

function setPageEnabled(value: boolean) {
  pageEnabled.value = value;
  writeStorage(keys.page, String(value));
}

async function setBrowserEnabled(value: boolean) {
  browserError.value = "";
  if (!value) {
    browserEnabled.value = false;
    writeStorage(keys.browser, "false");
    return;
  }
  refreshPermission();
  if (permission.value === "insecure" || permission.value === "unsupported") {
    browserError.value = permissionDescription.value;
    return;
  }
  if (permission.value === "denied") {
    browserError.value = permissionDescription.value;
    return;
  }
  requestingPermission.value = true;
  try {
    // This function is called only by the user's switch interaction.
    if (permission.value === "default")
      permission.value = await Notification.requestPermission();
    browserEnabled.value = permission.value === "granted";
    writeStorage(keys.browser, String(browserEnabled.value));
    if (browserEnabled.value)
      message.success("浏览器通知已启用，可发送最近结果进行测试。");
    else
      browserError.value =
        permission.value === "denied"
          ? "通知权限未获允许。请在此站点权限中允许通知后重试。"
          : "尚未允许通知，可以再次打开开关请求权限。";
  } catch {
    browserError.value = "浏览器未能完成权限请求，请检查站点通知权限后重试。";
    refreshPermission();
  } finally {
    requestingPermission.value = false;
  }
}

function sendBrowserNotification(item: Update, test = false) {
  refreshPermission();
  if (!browserActive.value) return false;
  try {
    const notification = new Notification(
      `${test ? "测试通知" : "PageSentinel"} · ${statusLabel[item.status]}`,
      {
        body: `${item.monitorName}\n${resultSummary(item)}\n${timeFormatter.format(item.checkedAt)}`,
        tag: `pagesentinel-${test ? "test-" : ""}${item.id}`,
      },
    );
    nativeNotifications.set(notification, item.id);
    if (test) browserDeliveryMessage.value = "等待浏览器确认显示…";
    notification.onshow = () => {
      if (test) browserDeliveryMessage.value = "浏览器已确认显示最近结果通知。";
    };
    notification.onclose = () => nativeNotifications.delete(notification);
    notification.onclick = () => {
      window.focus();
      openResult(item);
      try {
        notification.close();
      } catch {
        // The result navigation still works if the browser already closed it.
      } finally {
        nativeNotifications.delete(notification);
      }
    };
    notification.onerror = () => {
      if (test) browserDeliveryMessage.value = "";
      browserError.value =
        "浏览器未能显示系统通知，请检查浏览器及操作系统的通知设置。";
      nativeNotifications.delete(notification);
    };
    browserError.value = "";
    return true;
  } catch {
    browserError.value =
      "当前浏览器未能创建系统通知，请检查站点权限和系统通知设置。";
    return false;
  }
}

function testBrowserNotification() {
  if (!items.value[0]) {
    message.info("暂无监控结果可测试，请先完成一次监控检查。");
    return;
  }
  if (sendBrowserNotification(items.value[0], true))
    message.info("测试通知已交给浏览器，请检查系统通知中心。");
  else if (browserError.value) message.error(browserError.value);
}

async function deliverPending() {
  const deliver = () => {
    if (disposed) return;
    let sharedIds: number[] = [];
    try {
      const stored: unknown = JSON.parse(readStorage(keys.delivered) || "[]");
      if (Array.isArray(stored))
        sharedIds = stored
          .filter((id) => Number.isSafeInteger(id) && id >= 0)
          .slice(0, 1000);
    } catch {
      /* Invalid or unavailable storage falls back to this tab's delivered IDs. */
    }
    const claimed = claimNotificationResults(
      [...pending.values()],
      [...deliveredIds, ...sharedIds],
      clearedCursor.value,
    );
    const fresh = claimed.fresh;
    if (fresh.length) {
      // Claim individual IDs before side effects while the origin-wide lock is held.
      deliveredIds = claimed.deliveredIds;
      writeStorage(keys.delivered, JSON.stringify(deliveredIds));
      for (const item of fresh) {
        if (pageEnabled.value) {
          const text = `${item.monitorName} · ${statusLabel[item.status]}：${resultSummary(item)} · ${timeFormatter.format(item.checkedAt)}`;
          if (item.status === "FAILED")
            message.warning(text, { duration: 7000 });
          else if (item.status === "CHANGED")
            message.success(text, { duration: 7000 });
          else message.info(text, { duration: 5000 });
        }
        if (browserActive.value) sendBrowserNotification(item);
      }
    }
    pending.clear();
  };

  if (navigator.locks) {
    try {
      await navigator.locks.request("pagesentinel-notifications", deliver);
      return;
    } catch {
      // A browser may expose Web Locks but restrict it for this context.
    }
  }
  // Older browsers use a short storage lease; losing tabs retry next poll.
  const now = Date.now();
  const existing = readStorage(keys.lease);
  if (existing) {
    const expires = Number(existing.split(":", 1)[0]);
    if (expires > now) return;
  }
  if (!storageAvailable.value) {
    deliver();
    return;
  }
  const lease = `${now + 1000}:${Math.random()}`;
  writeStorage(keys.lease, lease);
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (readStorage(keys.lease) !== lease) return;
  deliver();
  if (readStorage(keys.lease) === lease) writeStorage(keys.lease, "0");
}

async function poll() {
  request = new AbortController();
  try {
    let hasMore: boolean;
    do {
      const initial = cursor === null;
      const response = await fetch(
        `/api/updates${initial ? "" : `?after=${cursor}`}`,
        { cache: "no-store", signal: request.signal },
      );
      if (!response.ok) throw new Error("updates unavailable");
      const data = (await response.json()) as UpdatesResponse;
      if (disposed) return;
      if (data.hasMore && data.cursor <= (cursor ?? -1))
        throw new Error("updates cursor did not advance");
      const combined = new Map(items.value.map((item) => [item.id, item]));
      for (const item of data.items)
        if (item.id > clearedCursor.value) combined.set(item.id, item);
      items.value = [...combined.values()]
        .filter((item) => item.id > clearedCursor.value)
        .sort((a, b) => b.id - a.id)
        .slice(0, 20);
      if (initial && readStorage(keys.read) === null) {
        readCursor.value = data.cursor;
        writeStorage(keys.read, String(data.cursor));
      }
      if (!initial)
        for (const item of data.items)
          if (item.id > clearedCursor.value) pending.set(item.id, item);
      cursor = data.cursor;
      if (panelOpen.value) markRead();
      if (!initial) await deliverPending();
      hasMore = data.hasMore;
    } while (hasMore && !disposed);
    loadError.value = "";
  } catch (error) {
    if (
      !disposed &&
      !(error instanceof DOMException && error.name === "AbortError")
    )
      loadError.value = "通知结果暂时无法加载，正在自动重试。";
  } finally {
    loading.value = false;
    if (!disposed) timer = setTimeout(poll, 3000);
  }
}

function syncStorage(event: StorageEvent) {
  if (event.key === keys.cleared) {
    const through = Number(event.newValue);
    if (Number.isSafeInteger(through) && through >= 0)
      applyClearedCursor(through);
  }
  if (event.key === keys.page) pageEnabled.value = event.newValue !== "false";
  if (event.key === keys.browser)
    browserEnabled.value = event.newValue === "true";
  if (event.key === keys.read)
    readCursor.value = Math.max(readCursor.value, Number(event.newValue) || 0);
}

onMounted(() => {
  refreshPermission();
  window.addEventListener("focus", refreshPermission);
  window.addEventListener("storage", syncStorage);
  void poll();
});
onUnmounted(() => {
  disposed = true;
  clearTimeout(timer);
  request?.abort();
  window.removeEventListener("focus", refreshPermission);
  window.removeEventListener("storage", syncStorage);
  pending.clear();
  for (const notification of nativeNotifications.keys()) {
    try {
      notification.close();
    } catch {
      // Some browsers revoke access to an already closed notification.
    }
  }
  nativeNotifications.clear();
});
</script>

<template>
  <NPopover
    trigger="click"
    placement="bottom-end"
    raw
    :show-arrow="false"
    :show="panelOpen"
    @update:show="setPanelOpen"
  >
    <template #trigger>
      <button
        class="notification-trigger"
        type="button"
        :class="{ active: panelOpen }"
        :aria-label="`通知中心，${unreadCount} 条未读`"
        :aria-expanded="panelOpen"
        :aria-controls="panelId"
      >
        <Bell :size="19" /><span class="notification-trigger-label">通知</span>
        <span
          v-if="unreadCount"
          class="notification-count"
          aria-hidden="true"
          >{{ unreadCount > 9 ? "9+" : unreadCount }}</span
        >
      </button>
    </template>
    <section :id="panelId" class="notification-panel" aria-label="通知中心">
      <div class="notification-heading">
        <div>
          <h2>通知中心</h2>
          <p>最近 20 条监控结果</p>
        </div>
        <button
          class="notification-icon-button"
          type="button"
          aria-label="关闭通知中心"
          @click="panelOpen = false"
        >
          <X :size="19" />
        </button>
      </div>
      <div class="notification-settings">
        <div class="notification-setting">
          <div>
            <strong :id="pageLabelId"><Bell :size="16" />页面消息提醒</strong>
            <p>新结果在当前页面显示提示</p>
          </div>
          <NSwitch
            :value="pageEnabled"
            :aria-labelledby="pageLabelId"
            @update:value="setPageEnabled"
          />
        </div>
        <div class="notification-setting">
          <div>
            <strong :id="browserLabelId"
              ><Monitor :size="16" />浏览器系统通知</strong
            >
            <p>由浏览器发送到系统通知中心</p>
          </div>
          <NSwitch
            :value="browserActive"
            :loading="requestingPermission"
            :aria-labelledby="browserLabelId"
            @update:value="setBrowserEnabled"
          />
        </div>
        <p class="notification-permission">{{ permissionDescription }}</p>
        <p v-if="browserError" class="notification-problem" role="alert">
          {{ browserError }}
        </p>
        <button
          class="notification-test"
          type="button"
          :disabled="!browserActive || !items.length"
          @click="testBrowserNotification"
        >
          <Send :size="15" />发送最近结果测试通知
        </button>
        <p
          v-if="browserDeliveryMessage"
          class="notification-permission"
          role="status"
        >
          {{ browserDeliveryMessage }}
        </p>
        <p v-if="!items.length && !loading" class="notification-permission">
          暂无监控结果可测试，请先完成一次检查。
        </p>
        <p v-if="!storageAvailable" class="notification-problem" role="status">
          浏览器禁止本地存储，设置仅本页有效，多标签页提醒可能重复。
        </p>
      </div>
      <div class="notification-results-heading">
        <h3>最近结果</h3>
        <div class="notification-result-actions">
          <button type="button" class="notification-read" @click="markRead">
            <CheckCheck :size="16" />全部已读
          </button>
          <button
            type="button"
            class="notification-read notification-clear"
            :disabled="loading || !items.length"
            title="清空当前浏览器中的所有通知"
            @click="clearNotifications"
          >
            <Trash2 :size="16" />清空通知
          </button>
        </div>
      </div>
      <div class="notification-results" aria-label="最近监控结果">
        <p v-if="loadError" class="notification-load-error" role="status">
          <CircleAlert :size="16" />{{ loadError }}
        </p>
        <div
          v-if="loading && !items.length"
          class="notification-empty"
          role="status"
        >
          <LoaderCircle class="notification-loading" :size="23" />
          <p>正在加载监控结果</p>
        </div>
        <div v-else-if="!items.length && !loadError" class="notification-empty">
          <Bell :size="25" /><strong>{{
            clearedCursor ? "通知已清空" : "还没有监控结果"
          }}</strong>
          <p>
            {{
              clearedCursor
                ? "新的监控结果会显示在这里。"
                : "完成一次检查后，结果会出现在这里。"
            }}
          </p>
        </div>
        <RouterLink
          v-for="item in items"
          :key="item.id"
          :to="`/monitors/${encodeURIComponent(item.monitorId)}`"
          class="notification-result"
          :class="{
            unread: item.id > readCursor,
            failed: item.status === 'FAILED',
          }"
          @click="panelOpen = false"
        >
          <span
            class="notification-result-icon"
            :class="item.status.toLowerCase()"
            ><CircleAlert v-if="item.status === 'FAILED'" :size="18" /><Sparkles
              v-else-if="item.status === 'CHANGED'"
              :size="18" /><CircleCheck v-else :size="18"
          /></span>
          <span class="notification-result-content"
            ><span class="notification-result-title"
              ><strong>{{ item.monitorName }}</strong
              ><span>{{ statusLabel[item.status] }}</span></span
            ><span class="notification-summary">{{ resultSummary(item) }}</span
            ><time :datetime="new Date(item.checkedAt).toISOString()">{{
              timeFormatter.format(item.checkedAt)
            }}</time></span
          ><ChevronRight :size="16" />
        </RouterLink>
      </div>
      <p class="notification-footnote">关闭页面后的通知需配置 ntfy。</p>
    </section>
  </NPopover>
</template>
