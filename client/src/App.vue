<script setup lang="ts">
import { onMounted, onUnmounted, provide, ref } from "vue";
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  zhCN,
  dateZhCN,
} from "naive-ui";
import { Radar, LayoutGrid, BellRing, BellOff } from "lucide-vue-next";
import { api } from "./api";
import NotificationCenter from "./components/NotificationCenter.vue";
import "./notifications.css";

const ntfyConfigured = ref(false),
  connected = ref(true);
provide("ntfyConfigured", ntfyConfigured);
let timer: ReturnType<typeof setInterval>;
async function health() {
  try {
    ntfyConfigured.value = (await api.health()).ntfyConfigured;
    connected.value = true;
  } catch {
    connected.value = false;
  }
}
onMounted(() => {
  void health();
  timer = setInterval(health, 10000);
});
onUnmounted(() => clearInterval(timer));
const theme = {
  common: {
    primaryColor: "#6941d9",
    primaryColorHover: "#5730c0",
    primaryColorPressed: "#45249e",
    borderRadius: "10px",
    textColorBase: "#29243d",
    placeholderColor: "#74647f",
    fontSize: "15px",
    fontSizeSmall: "14px",
    fontFamily:
      '"Avenir Next", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
  },
};
</script>

<template>
  <NConfigProvider
    :theme-overrides="theme"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <NMessageProvider
      ><NDialogProvider>
        <div class="app-shell">
          <header class="app-header">
            <RouterLink class="brand" to="/" aria-label="PageSentinel 首页"
              ><span class="brand-symbol" :class="{ online: connected }"
                ><Radar :size="25" :stroke-width="1.8" /></span
              ><span>PageSentinel<small>页面哨兵</small></span></RouterLink
            >
            <nav aria-label="主导航">
              <RouterLink to="/" class="nav-link" aria-label="监控任务"
                ><LayoutGrid :size="16" /><span>监控任务</span></RouterLink
              >
            </nav>
            <div class="header-status">
              <span class="local-label"
                ><span class="state-dot" :class="{ danger: !connected }"></span
                >{{ connected ? "监控服务运行中" : "监控服务离线" }}</span
              >
              <NotificationCenter />
            </div>
          </header>
          <div v-if="!connected" role="alert" class="connection-error">
            暂时无法连接服务，正在自动重试。请确认后端仍在运行。
          </div>
          <main class="main-content"><RouterView :key="$route.path" /></main>
          <footer class="app-footer">
            <span class="footer-motto"
              ><span class="footer-spark"></span>Track what matters.</span
            ><span
              ><BellRing v-if="ntfyConfigured" :size="14" /><BellOff
                v-else
                :size="14"
              />{{
                ntfyConfigured
                  ? "ntfy 通知已配置"
                  : "ntfy 未配置 · 变化仍会保存"
              }}</span
            >
          </footer>
        </div>
      </NDialogProvider></NMessageProvider
    >
  </NConfigProvider>
</template>
