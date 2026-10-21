// Library analytics — the KV half. All pure logic lives in analytics-core.ts.
//
// The shape here is driven by two KV constraints rather than by taste:
//   * A single key absorbs roughly one write per second, so a hot counter
//     incremented per click would throttle under any burst.
//   * Read-modify-write on a shared counter loses increments whenever two
//     requests overlap.
// Both disappear if requests never touch the counters. So a request only
// *appends* a throwaway event key, and the cron is the sole writer of every
// rolled-up total.
//
// The second trick: an event carries all of its data in the key NAME
// (ev:{bucket}:{type}:{target}:{uuid}) and an empty value. The rollup can then
// fold thousands of events with list() calls alone and never get() a single
// one — which is what keeps it inside the Worker subrequest budget.
import type { Env } from './kv';
import { kvGetJSON, kvPutJSON, kvListAll, uuid } from './kv';
import {
  bucketOf, dayOf, monthOf, emptyStats, mergeInto, applyEvent,
  parseEventKey, isSafeTarget, type StatsDoc, type EventType,
} from './analytics-core';

export {
  bucketOf, bucketReferrer, parseEventKey, isSafeTarget,
  type StatsDoc, type EventType,
} from './analytics-core';

const EVENT_TTL_SECONDS = 60 * 60 * 24; // events are disposable once rolled up
const STATS_TTL_SECONDS = 60 * 60 * 24 * 400;
const WATERMARK_KEY = 'stats:watermark';
const TOTALS_KEY = 'stats:totals';

// Appends one event. Never throws into the request path: analytics failing is
// never a reason for a visitor's page or form submission to fail.
export async function recordEvent(env: Env, type: EventType, target: string): Promise<void> {
  if (!isSafeTarget(target)) return;
  try {
    const key = `ev:${bucketOf(Date.now())}:${type}:${target}:${uuid()}`;
    await env.LIBRARY_KV.put(key, '1', { expirationTtl: EVENT_TTL_SECONDS });
  } catch {
    /* analytics is best-effort by design */
  }
}

// Folds every complete 15-minute bucket into its day and month documents.
//
// Buckets at or after the current one are skipped — they're still being
// written to, and folding a half-full bucket would lose whatever arrived
// afterwards. The watermark makes the whole pass idempotent, so a run that
// dies partway through is safe to repeat. Rolled-up event keys are left to
// expire on their own 24h TTL rather than deleted: deletes would cost one
// subrequest each, and that is the budget this design exists to protect.
export async function rollupAnalytics(
  env: Env,
  categoryOf: (videoId: string) => string | undefined
): Promise<{ folded: number; through: number }> {
  const currentBucket = bucketOf(Date.now());
  const watermark = await kvGetJSON<{ lastBucket: number }>(env.LIBRARY_KV, WATERMARK_KEY);
  const from = watermark?.lastBucket ?? 0;
  if (currentBucket - 1 <= from) return { folded: 0, through: from };

  const names = await kvListAll(env.LIBRARY_KV, 'ev:');
  const byDay = new Map<string, StatsDoc>();
  const byMonth = new Map<string, StatsDoc>();
  let folded = 0;

  for (const name of names) {
    const ev = parseEventKey(name);
    if (!ev) continue;
    if (ev.bucket <= from || ev.bucket >= currentBucket) continue;

    const day = dayOf(ev.bucket);
    const month = monthOf(ev.bucket);
    if (!byDay.has(day)) byDay.set(day, emptyStats());
    if (!byMonth.has(month)) byMonth.set(month, emptyStats());

    applyEvent(byDay.get(day)!, ev, categoryOf);
    applyEvent(byMonth.get(month)!, ev, categoryOf);
    folded++;
  }

  const totals = (await kvGetJSON<StatsDoc>(env.LIBRARY_KV, TOTALS_KEY)) ?? emptyStats();

  for (const [day, stats] of byDay) {
    const key = `stats:day:${day}`;
    const existing = (await kvGetJSON<StatsDoc>(env.LIBRARY_KV, key)) ?? emptyStats();
    mergeInto(existing, stats);
    await kvPutJSON(env.LIBRARY_KV, key, existing, STATS_TTL_SECONDS);
    mergeInto(totals, stats);
  }
  for (const [month, stats] of byMonth) {
    const key = `stats:month:${month}`;
    const existing = (await kvGetJSON<StatsDoc>(env.LIBRARY_KV, key)) ?? emptyStats();
    mergeInto(existing, stats);
    await kvPutJSON(env.LIBRARY_KV, key, existing, STATS_TTL_SECONDS);
  }

  await kvPutJSON(env.LIBRARY_KV, TOTALS_KEY, totals);
  await kvPutJSON(env.LIBRARY_KV, WATERMARK_KEY, { lastBucket: currentBucket - 1 });

  return { folded, through: currentBucket - 1 };
}

export interface AnalyticsSummary {
  days: number;
  from: string;
  to: string;
  totals: StatsDoc;
  series: Array<{ date: string; leads: number; plays: number }>;
  pendingEvents: boolean;
}

// Reads at most `days` daily documents — 30 by default, which with the
// catalogue and settings reads stays under the free plan's 50-subrequest cap.
export async function getSummary(env: Env, days: number): Promise<AnalyticsSummary> {
  const clamped = Math.max(1, Math.min(days, 90));
  const totals = emptyStats();
  const series: Array<{ date: string; leads: number; plays: number }> = [];

  const today = new Date();
  const dates: string[] = [];
  for (let i = clamped - 1; i >= 0; i--) {
    dates.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
  }

  for (const date of dates) {
    const stats = (await kvGetJSON<StatsDoc>(env.LIBRARY_KV, `stats:day:${date}`)) ?? emptyStats();
    mergeInto(totals, stats);
    series.push({
      date,
      leads: stats.leads,
      plays: Object.values(stats.plays).reduce((a, b) => a + b, 0),
    });
  }

  const watermark = await kvGetJSON<{ lastBucket: number }>(env.LIBRARY_KV, WATERMARK_KEY);
  return {
    days: clamped,
    from: dates[0],
    to: dates[dates.length - 1],
    totals,
    series,
    // Tells the admin UI to say "updated every 15 minutes" rather than letting
    // Glenn think a play he just tested was lost.
    pendingEvents: (watermark?.lastBucket ?? 0) < bucketOf(Date.now()) - 1,
  };
}
