export enum MonitorMode {
  TEXT = "TEXT",
  LIST = "LIST",
}
export type Mode = "TEXT" | "LIST";
export type RunStatus = "BASELINE" | "UNCHANGED" | "CHANGED" | "FAILED";
export type NotificationStatus = "PENDING" | "SENT";

export interface Rule {
  url: string;
  mode: Mode;
  selector: string;
  ignoreSelectors?: string[];
  titleSelector?: string;
  linkSelector?: string;
}
export interface MonitorInput extends Rule {
  name: string;
  intervalMinutes: number;
  enabled: boolean;
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
}
export type CheckSource =
  | "AUTO"
  | "MANUAL"
  | "CREATE"
  | "RULE_EDIT"
  | "MANUAL_BATCH"
  | "LEGACY"
  | "TASK_CONTROL";
export interface CurrentContent {
  content: ExtractResult | null;
  capturedAt: number | null;
  thumbnailAt: number | null;
}
export type CheckRunStatus = RunStatus | "ENABLED" | "DISABLED";
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
