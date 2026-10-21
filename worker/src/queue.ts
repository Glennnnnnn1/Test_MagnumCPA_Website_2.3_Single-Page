// The Canopy delivery retry queue's shape and backoff constants, shared by the
// route that enqueues (routes/lead.ts) and the cron that drains it (index.ts).
// Extracted from index.ts unchanged when the router was split out.
import type { NormalizedLead } from './canopy-client';

export const MAX_CANOPY_ATTEMPTS = 8;
export const BASE_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes, doubles per attempt

export interface PendingCanopyItem {
  id: string;
  lead: NormalizedLead;
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
}
