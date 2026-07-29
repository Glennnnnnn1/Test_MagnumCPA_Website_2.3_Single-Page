import { kvPutJSON, uuid } from './kv';

const AUDIT_RETENTION_SECONDS = 60 * 60 * 24 * 90; // 90 days; adjust as needed

export interface AuditEvent {
  type: string;         // e.g. 'lead_accepted' | 'lead_flagged' | 'canopy_pending' | 'canopy_created'
  reason?: string;
  email?: string;
  ip?: string;
  meta?: Record<string, unknown>;
}

export async function logEvent(kv: KVNamespace, event: AuditEvent): Promise<void> {
  const key = `audit:${new Date().toISOString()}:${uuid()}`;
  await kvPutJSON(kv, key, { ...event, at: Date.now() }, AUDIT_RETENTION_SECONDS);
}
