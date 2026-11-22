/**
 * The delta log (GAP S1, S3; backend design §4, §7.1): the last hour of sequenced messages, in memory only.
 * Each message is serialised once when it is logged and the same string is sent to every socket and every
 * `?since=` catch-up. After a restart the ring is empty, so a reconnecting client gets a snapshot.
 */
import type { ServerMessage } from "@cme/shared";

/** The messages that carry a seq: snapshot, delta, alert. */
export type SequencedMessage = Extract<ServerMessage, { seq: number }>;

export interface Sequenced {
  msg: SequencedMessage;
  /** JSON.stringify(msg), computed once. */
  str: string;
}

/** Serialises a message once, for the ring and for broadcasting. */
export const sequenced = (msg: SequencedMessage): Sequenced => ({ msg, str: JSON.stringify(msg) });

export interface DeltaRingOptions {
  /** Messages older than this (by msg.ts, relative to the newest message) are dropped. Default 3600. */
  maxAgeS?: number;
  /** Hard cap on the number of messages kept. Default 2000. */
  maxCount?: number;
}

export class DeltaRing {
  readonly maxAgeS: number;
  readonly maxCount: number;
  private entries: Sequenced[] = [];
  private newest: number;

  /** @param currentSeq the seq already committed (readSeq on start), so since(currentSeq) is [] even when empty. */
  constructor(currentSeq: number, opts: DeltaRingOptions = {}) {
    this.newest = currentSeq;
    this.maxAgeS = opts.maxAgeS ?? 3600;
    this.maxCount = opts.maxCount ?? 2000;
  }

  get newestSeq(): number {
    return this.newest;
  }

  get size(): number {
    return this.entries.length;
  }

  /** seq of the oldest message held, or null when empty. */
  get oldestSeq(): number | null {
    return this.entries.length ? this.entries[0].msg.seq : null;
  }

  /**
   * Logs messages in seq order. Each seq must be greater than the newest one; a gap (seq > newest + 1)
   * empties the ring first so that `since` can never return a non-contiguous run.
   * Throws on a seq that is not newer (that would mean a reused seq, GAP R3).
   */
  push(...entries: Sequenced[]): void {
    for (const e of entries) {
      const s = e.msg.seq;
      if (s <= this.newest) throw new Error(`delta ring: seq ${s} is not after ${this.newest}`);
      if (s !== this.newest + 1) this.entries = [];
      this.entries.push(e);
      this.newest = s;
    }
    const last = this.entries[this.entries.length - 1];
    if (last) this.prune(last.msg.ts);
  }

  /** Drops messages older than now − maxAgeS and anything over maxCount. Called by push; callable on its own. */
  prune(now: number): void {
    const cutoff = now - this.maxAgeS;
    let drop = 0;
    while (drop < this.entries.length && this.entries[drop].msg.ts < cutoff) drop++;
    drop = Math.max(drop, this.entries.length - this.maxCount);
    if (drop > 0) this.entries.splice(0, drop);
  }

  /**
   * What a client that has seen up to `seq` needs:
   * - [] when it is up to date (seq == newestSeq);
   * - the contiguous messages seq+1 … newestSeq when the ring still holds them;
   * - null when it can't say (seq ahead of the server, older than the ring, not an integer): send a snapshot.
   */
  since(seq: number): Sequenced[] | null {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.newest) return null;
    if (seq === this.newest) return [];
    const oldest = this.oldestSeq;
    if (oldest === null || seq + 1 < oldest) return null;
    return this.entries.slice(seq + 1 - oldest);
  }
}
