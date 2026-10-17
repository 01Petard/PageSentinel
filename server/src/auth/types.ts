import type { BrowserContext } from "playwright";
import type { AuthProfileSummary } from "../../../shared/types.js";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
export interface EncryptedState {
  ciphertext: string;
  nonce: string;
  tag: string;
}
// This object stays inside the server; API responses use AuthProfileSummary.
export interface AuthContext {
  profile: AuthProfileSummary;
  state: StorageState;
  isCurrent: () => boolean;
  saveState: (state: StorageState) => void;
}
