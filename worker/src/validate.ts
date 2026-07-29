export interface LeadInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  businessName?: string;
  state?: string;
  serviceNeeded?: string;
  revenue?: string;
  preferredContact?: string;
  bestTimeToCall?: string;
  message?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Accepts common US formats: (555) 555-5555, 555-555-5555, 555.555.5555, 5555555555, +1 555 555 5555
const US_PHONE_RE = /^\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/;

const REQUIRED_FIELDS: (keyof LeadInput)[] = ['firstName', 'lastName', 'email', 'phone', 'serviceNeeded'];
const MAX_MESSAGE_LEN = 2000;
const MAX_TEXT_LEN = 200;

// This parses arbitrary, untrusted JSON — the declared `LeadInput` type is
// only a compile-time hint, not a runtime guarantee. A direct API call could
// send a number/object/array for any field, so every value must be coerced
// to a string defensively before calling .trim()/.test() on it, rather than
// trusting the type and risking an uncaught exception on malformed input.
function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function validateLead(lead: LeadInput): ValidationResult {
  const errors: Record<string, string> = {};

  for (const field of REQUIRED_FIELDS) {
    const v = asString(lead[field]).trim();
    if (!v) errors[field] = 'This field is required.';
  }

  const email = asString(lead.email).trim();
  if (email && !EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';

  const phone = asString(lead.phone).trim();
  if (phone && !US_PHONE_RE.test(phone)) errors.phone = 'Enter a valid US phone number.';

  if (asString(lead.message).length > MAX_MESSAGE_LEN) errors.message = 'Message is too long.';
  for (const field of ['firstName', 'lastName', 'businessName', 'state', 'serviceNeeded', 'revenue', 'preferredContact', 'bestTimeToCall'] as const) {
    if (asString(lead[field]).length > MAX_TEXT_LEN) errors[field] = 'Value is too long.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
