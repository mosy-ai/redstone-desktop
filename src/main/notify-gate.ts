/**
 * How many native notifications the shell is allowed to raise, and how often.
 *
 * The bug this exists for: a single network outage raised one "sync keeps
 * failing" notification *per linked folder*, all in the same second, and raised
 * a fresh set every time the connection flapped. Four folders and a bad
 * afternoon was nineteen identical alerts; nothing in the path had a limit.
 *
 * Two rules, because the two failure shapes are different:
 *
 *   1. **The same thing twice is once.** A repeated message inside the cool-off
 *      tells the user nothing they are not already looking at.
 *   2. **A burst is a burst.** Distinct messages arriving together — one per
 *      folder — are one event to a person, so the window caps them regardless
 *      of wording, and the suppressed count is reported rather than dropped
 *      silently.
 *
 * Pure and time-injected: the whole point is the arithmetic, and arithmetic
 * that can only be exercised by waiting ten real minutes does not get tested.
 */

/** A repeat of the same message inside this window is suppressed. */
export const COOLOFF_MS = 10 * 60_000;
/** How far back the burst cap looks. */
export const BURST_WINDOW_MS = 60_000;
/** The most notifications allowed inside one burst window. */
export const BURST_LIMIT = 3;

export type Verdict =
  | { show: true; alsoSuppressed: number }
  | { show: false; reason: 'duplicate' | 'burst' };

export class NotifyGate {
  private lastShownAt = new Map<string, number>();
  private shownAt: number[] = [];
  private suppressed = 0;

  /**
   * Whether to raise this notification now.
   *
   * `alsoSuppressed` is how many were held back since the last one got through,
   * so the caller can say "and 4 more" instead of pretending they never
   * happened.
   */
  decide(key: string, now: number): Verdict {
    const last = this.lastShownAt.get(key);
    if (last !== undefined && now - last < COOLOFF_MS) {
      this.suppressed += 1;
      return { show: false, reason: 'duplicate' };
    }

    this.shownAt = this.shownAt.filter((t) => now - t < BURST_WINDOW_MS);
    if (this.shownAt.length >= BURST_LIMIT) {
      this.suppressed += 1;
      return { show: false, reason: 'burst' };
    }

    const alsoSuppressed = this.suppressed;
    this.suppressed = 0;
    this.shownAt.push(now);
    this.lastShownAt.set(key, now);

    // The cool-off bounds how long a key is worth remembering; without this the
    // map grows for the life of the process, one entry per distinct message.
    if (this.lastShownAt.size > 200) {
      for (const [k, t] of this.lastShownAt) {
        if (now - t >= COOLOFF_MS) this.lastShownAt.delete(k);
      }
    }
    return { show: true, alsoSuppressed };
  }
}
