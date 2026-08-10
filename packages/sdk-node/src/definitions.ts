import { TransportError } from "./transport.js";
import type { CohorlyGetFetcher, FlagDefinition } from "./types.js";

/**
 * Polls `GET /flags/local-evaluation` for flag definitions (ADR-0011).
 *
 * Failure policy: a failed poll keeps the last definitions - stale targeting
 * beats no targeting, and the alternative (dropping to remote evaluation on a
 * blip) would stampede the API exactly when it is unhealthy. A 401 (revoked or
 * wrong flag secret) is logged once and polling continues, so a rotated secret
 * recovers without a restart.
 */
export class FlagDefinitionsPoller {
  private definitions: FlagDefinition[] | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unauthorizedLogged = false;
  /** Resolves after the first refresh attempt settles (mainly for tests). */
  readonly ready: Promise<void>;

  constructor(
    private readonly opts: {
      url: string;
      secret: string;
      intervalMs: number;
      fetcher: CohorlyGetFetcher;
      log: (...args: unknown[]) => void;
    },
  ) {
    this.ready = this.refresh();
    if (this.opts.intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.refresh();
      }, this.opts.intervalMs);
      const timer = this.timer as { unref?: () => void };
      timer.unref?.();
    }
  }

  /** Last successfully fetched definitions, or null before the first success. */
  get(): FlagDefinition[] | null {
    return this.definitions;
  }

  /** Fetch definitions once. Never rejects; failures keep the last payload. */
  async refresh(): Promise<void> {
    try {
      const res = await this.opts.fetcher(this.opts.url, {
        Authorization: `Bearer ${this.opts.secret}`,
      });
      const flags = (res as { flags?: unknown } | null | undefined)?.flags;
      if (!Array.isArray(flags)) {
        this.opts.log("flag definitions response had no flags array, keeping last");
        return;
      }
      this.definitions = flags as FlagDefinition[];
    } catch (err) {
      if (err instanceof TransportError && err.status === 401) {
        if (!this.unauthorizedLogged) {
          this.unauthorizedLogged = true;
          this.opts.log(
            "flag secret rejected (401); local evaluation disabled until it is valid",
          );
        }
        return;
      }
      this.opts.log("flag definitions poll failed, keeping last definitions", err);
    }
  }

  /** Stop polling. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
