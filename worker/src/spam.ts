// A small, easily-extended list — not exhaustive. Add domains as real spam
// patterns are observed in the audit log.
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', '10minutemail.com',
  'yopmail.com', 'throwawaymail.com', 'trashmail.com', 'getnada.com',
  'sharklasers.com', 'dispostable.com',
]);

const SPAM_KEYWORDS = [
  'seo services', 'backlink', 'crypto investment', 'bitcoin opportunity',
  'work from home', 'click here to claim', 'viagra', 'weight loss pill',
  'guaranteed loan', 'wire transfer', 'inheritance fund', 'casino bonus',
];

export const SPAM_SCORE_THRESHOLD = 5;

export interface SpamCheckInput {
  honeypot: string;
  userAgent: string | null;
  email: string;
  message: string;
}

export interface SpamCheckResult {
  score: number;
  reasons: string[];
  isHoneypot: boolean;
}

export function computeSpamScore(input: SpamCheckInput): SpamCheckResult {
  const reasons: string[] = [];
  let score = 0;

  const isHoneypot = input.honeypot.trim().length > 0;
  if (isHoneypot) {
    // Caller short-circuits on this — scoring the rest is unnecessary once a
    // honeypot fires, but we still report it for the audit log.
    reasons.push('honeypot_filled');
    return { score: 100, reasons, isHoneypot: true };
  }

  if (!input.userAgent || input.userAgent.trim().length < 5) {
    score += 2;
    reasons.push('missing_or_short_user_agent');
  }

  const emailDomain = input.email.split('@')[1]?.toLowerCase();
  if (emailDomain && DISPOSABLE_EMAIL_DOMAINS.has(emailDomain)) {
    score += 4;
    reasons.push('disposable_email_domain');
  }

  const lowerMessage = input.message.toLowerCase();
  for (const kw of SPAM_KEYWORDS) {
    if (lowerMessage.includes(kw)) {
      score += 3;
      reasons.push(`spam_keyword:${kw}`);
    }
  }

  const linkCount = (input.message.match(/https?:\/\//gi) || []).length;
  if (linkCount >= 2) {
    score += 3;
    reasons.push('multiple_links_in_message');
  }

  return { score, reasons, isHoneypot: false };
}
