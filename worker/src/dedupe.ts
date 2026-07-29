import { kvGetJSON, kvPutJSON } from './kv';

const EMAIL_PHONE_WINDOW_SECONDS = 60 * 60 * 24; // 24h: same email/phone re-submitting
const NAME_WINDOW_SECONDS = 60 * 10;             // 10min: same name in a short burst

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  reasons: string[];
}

export async function checkDuplicate(
  kv: KVNamespace,
  email: string,
  phone: string,
  fullName: string
): Promise<DuplicateCheckResult> {
  const reasons: string[] = [];

  if (await kvGetJSON(kv, `dup:email:${email}`)) reasons.push('duplicate_email');
  if (await kvGetJSON(kv, `dup:phone:${phone}`)) reasons.push('duplicate_phone');
  if (await kvGetJSON(kv, `dup:name:${fullName.toLowerCase()}`)) reasons.push('duplicate_name_recent');

  return { isDuplicate: reasons.length > 0, reasons };
}

export async function markSubmitted(kv: KVNamespace, email: string, phone: string, fullName: string): Promise<void> {
  await Promise.all([
    kvPutJSON(kv, `dup:email:${email}`, { at: Date.now() }, EMAIL_PHONE_WINDOW_SECONDS),
    kvPutJSON(kv, `dup:phone:${phone}`, { at: Date.now() }, EMAIL_PHONE_WINDOW_SECONDS),
    kvPutJSON(kv, `dup:name:${fullName.toLowerCase()}`, { at: Date.now() }, NAME_WINDOW_SECONDS),
  ]);
}
