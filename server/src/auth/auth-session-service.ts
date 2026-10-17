import type { AuthProfileService } from "./auth-profile-service.js";
import type { AuthContext } from "./types.js";

export class AuthSessionService {
  private tails = new Map<string, Promise<void>>();
  constructor(readonly profiles: AuthProfileService) {}
  async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(id, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(id) === tail) this.tails.delete(id);
    }
  }
  withProfile<T>(
    id: string,
    operation: (context: AuthContext) => Promise<T>,
  ): Promise<T> {
    return this.withLock(id, async () => {
      const profile = this.profiles.get(id),
        state = this.profiles.loadState(id);
      const isCurrent = () => {
        try {
          return this.profiles.get(id).revision === profile.revision;
        } catch {
          return false;
        }
      };
      return operation({
        profile,
        state,
        isCurrent,
        saveState: (value) => {
          if (isCurrent())
            this.profiles.writeState(id, profile.revision, value);
        },
      });
    });
  }
}
