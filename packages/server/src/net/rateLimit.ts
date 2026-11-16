/**
 * Fixed-window rate limiter.
 *
 * Deliberately simple: one counter per connection, reset every `windowMs`. A token
 * bucket would smooth bursts more gracefully, but the requirement here is "drop
 * abusive frames without disconnecting an honest player", and a counter does that
 * in three lines with no allocation per message.
 *
 * Dropped frames are counted but *not* fatal: a client that legitimately bursts
 * (e.g. a lag spike flushing queued INPUTs) recovers on the next window.
 */
export interface RateLimiterOptions {
  /** Maximum messages allowed per window. */
  readonly limit: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

export class RateLimiter {
  readonly limit: number;
  readonly windowMs: number;

  #windowStart: number;
  #count = 0;
  #dropped = 0;
  readonly #now: () => number;

  constructor(options: RateLimiterOptions) {
    this.limit = Math.max(1, options.limit);
    this.windowMs = Math.max(1, options.windowMs);
    this.#now = options.now ?? ((): number => performance.now());
    this.#windowStart = this.#now();
  }

  /** `true` when the message may be processed, `false` when it must be dropped. */
  tryConsume(): boolean {
    const now = this.#now();
    if (now - this.#windowStart >= this.windowMs) {
      this.#windowStart = now;
      this.#count = 0;
    }

    if (this.#count >= this.limit) {
      this.#dropped += 1;
      return false;
    }

    this.#count += 1;
    return true;
  }

  /** Messages dropped since this limiter was created. */
  get droppedCount(): number {
    return this.#dropped;
  }

  /** Messages accepted in the current window. */
  get currentCount(): number {
    return this.#count;
  }
}
