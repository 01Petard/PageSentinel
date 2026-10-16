import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { AppError } from "../errors.js";

export async function assertPublicUrl(
  raw: string,
  allowedHosts: string[] = [],
): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("INVALID_URL", "请输入有效的 HTTP(S) URL。");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new AppError("INVALID_URL", "仅支持不含用户名和密码的 HTTP(S) URL。");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (allowedHosts.includes(host)) return;
  let addresses: { address: string }[];
  try {
    addresses = ipaddr.isValid(host)
      ? [{ address: host }]
      : await lookup(host, { all: true });
  } catch {
    throw new AppError("DNS_FAILED", "目标域名解析失败。");
  }
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) => ipaddr.process(address).range() !== "unicast",
    )
  )
    throw new AppError(
      "PRIVATE_ADDRESS",
      "仅支持公开网页，禁止访问本机、私有或保留地址。",
    );
}
