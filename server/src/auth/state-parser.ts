import { z } from "zod";
import { isIP } from "node:net";
import { getPublicSuffix } from "tldts";
import type { AuthProfileInput } from "../../../shared/types.js";
import type { StorageState } from "./types.js";
import { AppError } from "../errors.js";

export const STATE_LIMIT = 2 * 1024 * 1024;
const pair = z.strictObject({ name: z.string(), value: z.string() });
const keyPath = {
  keyPath: z.string().optional(),
  keyPathArray: z.array(z.string()).optional(),
};
// These fields match the installed Playwright protocol's IndexedDBDatabase schema.
const database = z.strictObject({
  name: z.string(),
  version: z.number().int().positive(),
  stores: z.array(
    z.strictObject({
      name: z.string(),
      autoIncrement: z.boolean(),
      ...keyPath,
      records: z.array(
        z.strictObject({
          key: z.unknown().optional(),
          keyEncoded: z.unknown().optional(),
          value: z.unknown().optional(),
          valueEncoded: z.unknown().optional(),
        }),
      ),
      indexes: z.array(
        z.strictObject({
          name: z.string(),
          ...keyPath,
          multiEntry: z.boolean(),
          unique: z.boolean(),
        }),
      ),
    }),
  ),
});
const cookie = z.strictObject({
  name: z
    .string()
    .min(1)
    .regex(/^[!#$%&'*+.^_`|~\w-]+$/),
  value: z.string().refine((v) => !/[\x00-\x1f\x7f]/.test(v)),
  domain: z.string().min(1),
  path: z.string().startsWith("/").default("/"),
  expires: z.number().finite().min(-1).max(100_000_000_000).default(-1),
  httpOnly: z.boolean().default(false),
  secure: z.boolean().default(false),
  sameSite: z.enum(["Strict", "Lax", "None"]).default("Lax"),
});
const stateSchema = z.strictObject({
  cookies: z.array(cookie).max(500),
  origins: z
    .array(
      z.strictObject({
        origin: z.string(),
        localStorage: z.array(pair),
        indexedDB: z.array(database).optional(),
      }),
    )
    .max(20),
});
export function validHost(host: string): boolean {
  if (
    host !== host.toLowerCase() ||
    host.startsWith(".") ||
    host.endsWith(".") ||
    /[/\s:@?#*]/.test(host)
  )
    return false;
  if (isIP(host)) return true;
  return (
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) &&
    host.length <= 253 &&
    host !== getPublicSuffix(host, { allowPrivateDomains: true })
  );
}
export function assertApprovedUrl(
  raw: string,
  profile: Pick<AuthProfileInput, "allowedHosts">,
) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("AUTH_DOMAIN", "登录地址无效。", 400);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !profile.allowedHosts.includes(url.hostname)
  )
    throw new AppError("AUTH_DOMAIN", "地址主机未获此登录身份批准。", 400);
  return url;
}
export function normalizeAuthState(
  input: unknown,
  profile: Pick<AuthProfileInput, "allowedHosts" | "verificationUrl">,
): StorageState {
  const invalid = () =>
    new AppError(
      "INVALID_AUTH_STATE",
      "登录状态格式不支持，请使用 Cookie JSON、Cookie 请求头或标准 storageState（不支持 Netscape、sessionStorage、OPFS 或私钥）。",
      400,
    );
  try {
    if (
      Buffer.byteLength(
        typeof input === "string" ? input : (JSON.stringify(input) ?? ""),
      ) > STATE_LIMIT
    )
      throw new AppError("AUTH_STATE_LIMIT", "登录状态不能超过 2 MiB。", 413);
    if (typeof input === "string") {
      const raw = input.trim();
      if (
        !raw ||
        raw.startsWith("#") ||
        (/[\t\r\n]/.test(raw) && !/^[\[{]/.test(raw))
      )
        throw invalid();
      if (/^[\[{]/.test(raw)) {
        try {
          input = JSON.parse(raw);
        } catch {
          throw invalid();
        }
      } else {
        const host = assertApprovedUrl(profile.verificationUrl, profile);
        input = {
          origins: [],
          cookies: raw
            .replace(/^Cookie:\s*/i, "")
            .split(";")
            .map((part) => {
              const index = part.indexOf("=");
              if (index <= 0) throw invalid();
              return {
                name: part.slice(0, index).trim(),
                value: part.slice(index + 1).trim(),
                domain: host.hostname,
                path: "/",
                expires: -1,
                secure: host.protocol === "https:",
                httpOnly: false,
                sameSite: "Lax",
              };
            }),
        };
      }
    }
    if (Array.isArray(input)) input = { cookies: input, origins: [] };
    const parsed = stateSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const state = parsed.data;
    if (!state.cookies.length && !state.origins.length) throw invalid();
    for (const c of state.cookies) {
      const domain = c.domain.replace(/^\./, "");
      if (!validHost(domain) || !profile.allowedHosts.includes(domain))
        throw new AppError(
          "AUTH_DOMAIN",
          "Cookie 域不在批准范围，父域必须单独批准且不能是公共或共享后缀。",
          400,
        );
    }
    for (const origin of state.origins) {
      const url = assertApprovedUrl(origin.origin, profile);
      if (origin.origin !== url.origin) throw invalid();
    }
    if (Buffer.byteLength(JSON.stringify(state)) > STATE_LIMIT)
      throw new AppError("AUTH_STATE_LIMIT", "登录状态不能超过 2 MiB。", 413);
    return state;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid();
  }
}

export function approvedState(
  state: StorageState,
  profile: Pick<AuthProfileInput, "allowedHosts" | "verificationUrl">,
): StorageState {
  // A browser can collect unrelated third-party cookies; never upload or persist them.
  const filtered = {
    cookies: state.cookies.filter((c) =>
      profile.allowedHosts.includes(c.domain.replace(/^\./, "")),
    ),
    origins: state.origins.filter((o) => {
      try {
        return profile.allowedHosts.includes(new URL(o.origin).hostname);
      } catch {
        return false;
      }
    }),
  };
  return normalizeAuthState(filtered, profile);
}
