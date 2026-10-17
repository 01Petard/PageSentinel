import type {
  Monitor,
  MonitorInput,
  Rule,
  ExtractResult,
  PageResult,
  ChangeEvent,
  CheckRun,
  CurrentContent,
  AuthProfileInput,
  AuthProfileSummary,
  AccountAction,
  CaptureSummary,
  ManagementSession,
} from "../../shared/types";
import { reactive } from "vue";

export const managementSession = reactive<
  ManagementSession & { loaded: boolean }
>({ required: false, unlocked: false, loaded: false });

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(managementSession.csrfToken
        ? { "x-csrf-token": managementSession.csrfToken }
        : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    if (response.status === 401 && managementSession.required) {
      managementSession.unlocked = false;
      managementSession.csrfToken = undefined;
    }
    const error = await response.json().catch(() => null);
    throw new Error(error?.message ?? "无法连接服务，请稍后重试。");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export const api = {
  session: async () => {
    const value = await request<ManagementSession>("/admin/session");
    Object.assign(managementSession, {
      csrfToken: undefined,
      ...value,
      loaded: true,
    });
    return value;
  },
  unlock: async (token: string) => {
    const value = await request<ManagementSession>("/admin/session", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    Object.assign(managementSession, { ...value, loaded: true });
    return value;
  },
  logout: async () => {
    await request<void>("/admin/session", { method: "DELETE" });
    Object.assign(managementSession, { unlocked: false, csrfToken: undefined });
  },
  profiles: () => request<AuthProfileSummary[]>("/auth-profiles"),
  createProfile: (input: AuthProfileInput) =>
    request<AuthProfileSummary>("/auth-profiles", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateProfile: (id: string, input: Partial<AuthProfileInput>) =>
    request<AuthProfileSummary>(`/auth-profiles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  importProfile: (id: string, input: string, accountAction: AccountAction) =>
    request<AuthProfileSummary>(`/auth-profiles/${id}/import`, {
      method: "POST",
      body: JSON.stringify({ input, accountAction }),
    }),
  verifyProfile: (id: string) =>
    request<AuthProfileSummary>(`/auth-profiles/${id}/verify`, {
      method: "POST",
    }),
  revokeProfile: (id: string) =>
    request<AuthProfileSummary>(`/auth-profiles/${id}/revoke`, {
      method: "POST",
    }),
  deleteProfile: (id: string) =>
    request<void>(`/auth-profiles/${id}`, { method: "DELETE" }),
  startCapture: (id: string, accountAction: AccountAction) =>
    request<CaptureSummary & { pairingCode: string }>(
      `/auth-profiles/${id}/captures`,
      { method: "POST", body: JSON.stringify({ accountAction }) },
    ),
  capture: (id: string) => request<CaptureSummary>(`/auth-captures/${id}`),
  saveCapture: (id: string) =>
    request<CaptureSummary>(`/auth-captures/${id}/save`, { method: "POST" }),
  cancelCapture: (id: string) =>
    request<CaptureSummary>(`/auth-captures/${id}`, { method: "DELETE" }),
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
    request<{ total: number; blocked: { id: string; status: string }[] }>(
      "/monitors/check-all",
      { method: "POST" },
    ),
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
  AUTH_REQUIRED: "需要重新登录",
  AUTH_UNVERIFIED: "登录标记未通过",
  AUTH_UPDATED: "登录授权已更新",
  AUTH_REVOKED: "登录授权已清除",
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
