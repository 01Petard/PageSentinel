import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../errors.js";
import type { EncryptedState, StorageState } from "./types.js";

export function parseMasterKey(input: string): Buffer {
  const key = Buffer.from(input, "base64");
  if (key.length !== 32 || key.toString("base64") !== input)
    throw new AppError(
      "AUTH_CONFIG",
      "AUTH_MASTER_KEY 必须是 Base64 编码的 32 字节密钥。",
      503,
    );
  return key;
}
export function encryptState(
  profileId: string,
  revision: number,
  state: StorageState,
  key: Buffer,
): EncryptedState {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([profileId, revision])));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
export function decryptState(
  profileId: string,
  revision: number,
  encrypted: EncryptedState,
  key: Buffer,
): StorageState {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(encrypted.nonce, "base64"),
    );
    decipher.setAAD(Buffer.from(JSON.stringify([profileId, revision])));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    throw new AppError(
      "AUTH_STATE_UNAVAILABLE",
      "登录状态无法解密，请检查密钥或重新授权。",
      409,
    );
  }
}
