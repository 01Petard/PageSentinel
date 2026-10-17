export enum MonitorMode {
  TEXT = "TEXT",
  LIST = "LIST",
}
export type Mode = "TEXT" | "LIST";
export type RunStatus = "BASELINE" | "UNCHANGED" | "CHANGED" | "FAILED";
export type AuthRunStatus = "AUTH_REQUIRED" | "AUTH_UNVERIFIED";
export type AuthStatus = "EMPTY" | "READY" | "NEEDS_LOGIN";
export type AccountAction = "SAME_ACCOUNT" | "SWITCH_ACCOUNT";
export interface AuthProfileInput {
  name: string;
  loginUrl: string;
  verificationUrl: string;
  allowedHosts: string[];
  successSelector: string;
  loginUrlPrefix?: string;
}
export interface AuthProfileSummary extends AuthProfileInput {
  id: string;
  source: "IMPORT" | "CAPTURE" | null;
  status: AuthStatus;
  revision: number;
  stateVersion: number;
  verifiedAt: number | null;
  errorCode: string | null;
  boundCount: number;
  createdAt: number;
  updatedAt: number;
}
export type CaptureStatus =
  | "WAITING_HELPER"
  | "LOGGING_IN"
  | "SAVE_REQUESTED"
  | "VERIFYING"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED"
  | "FAILED";
export interface CaptureSummary {
  id: string;
  profileId: string;
  status: CaptureStatus;
  expiresAt: number;
  errorCode: string | null;
}
export interface ManagementSession {
  required: boolean;
  unlocked: boolean;
  csrfToken?: string;
  ntfyConfigured?: boolean;
}
export type NotificationStatus = "PENDING" | "SENT";

export interface Rule {
  url: string;
  mode: Mode;
  selector: string;
  ignoreSelectors?: string[];
  titleSelector?: string;
  linkSelector?: string;
  authProfileId?: string | null;
  authSuccessSelector?: string;
}
export interface MonitorInput extends Rule {
  name: string;
  intervalMinutes: number;
  enabled: boolean;
  notificationPolicy?: "SUMMARY" | "FULL";
}
export interface ListItem {
  key: string;
  title: string;
  url: string;
}
export type ExtractResult =
  | { mode: "TEXT"; text: string; hash: string; matchCount: number }
  | { mode: "LIST"; items: ListItem[]; hash: string; matchCount: number };
export interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
  count?: number;
}
export interface Monitor extends MonitorInput {
  id: string;
  revision: number;
  baselineSnapshotId: number | null;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number;
  lastCheckedAt: number | null;
  lastChangedAt: number | null;
  lastStatus: RunStatus | null;
  lastError: string | null;
  failureCount: number;
  running?: boolean;
  authBlockedCode?: AuthRunStatus | null;
  authBlockedAt?: number | null;
}
export type CheckSource =
  | "AUTO"
  | "MANUAL"
  | "CREATE"
  | "RULE_EDIT"
  | "MANUAL_BATCH"
  | "LEGACY"
  | "TASK_CONTROL"
  | "AUTH_CONTROL";
export interface CurrentContent {
  content: ExtractResult | null;
  capturedAt: number | null;
  thumbnailAt: number | null;
}
export type CheckRunStatus =
  | RunStatus
  | AuthRunStatus
  | "ENABLED"
  | "DISABLED"
  | "AUTH_UPDATED"
  | "AUTH_REVOKED";
export interface CheckRun {
  id: number;
  monitorId: string;
  status: CheckRunStatus;
  durationMs: number;
  source: CheckSource;
  summary: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  checkedAt: number;
}
export type ChangeDetail =
  | {
      mode: "TEXT";
      oldSnapshotId: number;
      newSnapshotId: number;
      before: string;
      after: string;
      diff: DiffPart[];
    }
  | { mode: "LIST"; items: ListItem[] };
export interface ChangeEvent {
  id: number;
  monitorId: string;
  type: Mode;
  detail: ChangeDetail;
  notificationStatus: NotificationStatus;
  notificationAttempts: number;
  nextNotificationAt: number;
  notificationError: string | null;
  createdAt: number;
}
export interface PageResult<T> {
  items: T[];
  total: number;
  pageIndex: number;
  pageSize: number;
}
