import type {
  Monitor,
  MonitorInput,
  Rule,
  ExtractResult,
  PageResult,
  ChangeEvent,
  CheckRun,
  CurrentContent,
} from "../../shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message ?? "无法连接服务，请稍后重试。");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export const api = {
  health: () => request<{ status: string; ntfyConfigured: boolean }>("/health"),
  settings: () => request<{ refreshingAll: boolean }>("/settings"),
  list: () => request<Monitor[]>("/monitors"),
  get: (id: string) => request<Monitor>(`/monitors/${encodeURIComponent(id)}`),
  current: (id: string) =>
    request<CurrentContent>(`/monitors/${encodeURIComponent(id)}/current`),
  thumbnail: (id: string, capturedAt: number) =>
    `/api/monitors/${encodeURIComponent(id)}/thumbnail?v=${capturedAt}`,
  create: (input: MonitorInput) =>
    request<Monitor>("/monitors", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: string, input: Partial<MonitorInput>) =>
    request<Monitor>(`/monitors/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  delete: (id: string) =>
    request<void>(`/monitors/${encodeURIComponent(id)}`, { method: "DELETE" }),
  test: (rule: Rule) =>
    request<ExtractResult>("/monitors/test", {
      method: "POST",
      body: JSON.stringify(rule),
    }),
  check: (id: string) =>
    request<{ status?: string; discarded?: boolean }>(
      `/monitors/${encodeURIComponent(id)}/check`,
      { method: "POST" },
    ),
  checkAll: () =>
    request<{ total: number }>("/monitors/check-all", { method: "POST" }),
  events: (id: string, pageIndex = 1) =>
    request<PageResult<ChangeEvent>>(
      `/monitors/${encodeURIComponent(id)}/events?pageIndex=${pageIndex}`,
    ),
  checks: (id: string, pageIndex = 1) =>
    request<PageResult<CheckRun>>(
      `/monitors/${encodeURIComponent(id)}/checks?pageIndex=${pageIndex}`,
    ),
};
export const statusLabel: Record<string, string> = {
  ENABLED: "开启自动检查",
  DISABLED: "关闭自动检查",
  BASELINE: "已建立基线",
  UNCHANGED: "无变化",
  CHANGED: "发现变化",
  FAILED: "检查失败",
};
export function formatTime(value: number | null) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(value)
    : "尚无记录";
}
export function formatInterval(minutes: number) {
  const hours = Math.floor(minutes / 60),
    remainder = minutes % 60;
  return [hours ? `${hours} 小时` : "", remainder ? `${remainder} 分钟` : ""]
    .filter(Boolean)
    .join(" ");
}
export function formatCountdown(deadline: number, now = Date.now()) {
  const minutes = Math.ceil(Math.max(0, deadline - now) / 60_000);
  return `${Math.floor(minutes / 60)}时${minutes % 60}分`;
}
export function relativeTime(value: number | null) {
  if (!value) return "尚未检查";
  const minutes = Math.floor((Date.now() - value) / 60_000);
  return minutes < 1
    ? "刚刚"
    : minutes < 60
      ? `${minutes} 分钟前`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} 小时前`
        : `${Math.floor(minutes / 1440)} 天前`;
}
export function domain(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
