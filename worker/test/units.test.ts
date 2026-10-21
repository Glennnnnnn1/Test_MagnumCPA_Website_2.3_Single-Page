// Unit tests for the pure modules — the ones with real logic and no KV.
//
// Run with:  npm test   (Node 24 strips the TypeScript natively, no build step)
//
// These four are where a silent bug would be most expensive: a broken embed
// URL renders a blank iframe, a broken CSV escape is a security hole, and a
// broken token check is an auth bypass.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEmbedUrl } from '../src/videourl.ts';
import { csvCell, toCsv } from '../src/csv.ts';
import { hashPassword, verifyPassword, signToken, verifyToken, newAdminPayload, randomSecretB64 } from '../src/token.ts';
import { validateGateLead } from '../src/validate.ts';
import { bucketReferrer, parseEventKey, isSafeTarget } from '../src/analytics-core.ts';

describe('videourl', () => {
  test('converts a YouTube watch URL to an embed URL', () => {
    const r = normalizeEmbedUrl('https://www.youtube.com/watch?v=8ZnrVnLpm-o&t=42s');
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value.embedUrl, 'https://www.youtube.com/embed/8ZnrVnLpm-o?rel=0');
    assert.equal(r.ok && r.value.provider, 'youtube');
    // sourceUrl is what "View original" links to — it must stay the public post.
    assert.equal(r.ok && r.value.sourceUrl, 'https://www.youtube.com/watch?v=8ZnrVnLpm-o');
  });

  test('handles youtu.be and /shorts/', () => {
    for (const url of ['https://youtu.be/8ZnrVnLpm-o', 'https://www.youtube.com/shorts/8ZnrVnLpm-o']) {
      const r = normalizeEmbedUrl(url);
      assert.equal(r.ok && r.value.embedUrl, 'https://www.youtube.com/embed/8ZnrVnLpm-o?rel=0', url);
    }
  });

  test('converts a Google Drive share link to /preview', () => {
    const r = normalizeEmbedUrl('https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J/view?usp=sharing');
    assert.equal(r.ok && r.value.embedUrl, 'https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J/preview');
    assert.equal(r.ok && r.value.provider, 'drive');
  });

  test('is idempotent — re-submitting a stored embed URL is stable', () => {
    const once = normalizeEmbedUrl('https://www.youtube.com/watch?v=8ZnrVnLpm-o');
    assert.equal(once.ok, true);
    const twice = normalizeEmbedUrl(once.ok ? once.value.embedUrl : '');
    assert.equal(twice.ok && twice.value.embedUrl, once.ok && once.value.embedUrl);
  });

  test('rejects dangerous and unsupported URLs', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://www.youtube.com/watch?v=8ZnrVnLpm-o', // not https
      'https://evil.example.com/video.mp4',
      'not a url',
      '',
    ]) {
      assert.equal(normalizeEmbedUrl(bad).ok, false, `should reject: ${bad}`);
    }
  });
});

describe('csv', () => {
  test('neutralises formula injection', () => {
    assert.equal(csvCell('=HYPERLINK("http://evil","x")'), '"\'=HYPERLINK(""http://evil"",""x"")"');
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    // No comma or double-quote in this one, so it needs the formula guard but
    // not RFC-4180 quoting.
    assert.equal(csvCell('=cmd|\' /c calc\'!A0'), '\'=cmd|\' /c calc\'!A0');
  });

  test('leaves phone numbers and negative numbers readable', () => {
    // A leading + or - only matters if it can form a real formula; these can't,
    // so they must not be disfigured with a stray apostrophe in every row.
    assert.equal(csvCell('+15551234567'), '+15551234567');
    assert.equal(csvCell('-42'), '-42');
    assert.equal(csvCell('(555) 123-4567'), '(555) 123-4567');
  });

  test('quotes per RFC 4180', () => {
    assert.equal(csvCell('O\'Brien, Jr'), '"O\'Brien, Jr"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell(null), '');
  });

  test('emits a UTF-8 BOM and CRLF line endings', () => {
    const csv = toCsv(['A', 'B'], [['1', 'Ünïcødé']]);
    assert.equal(csv.charCodeAt(0), 0xfeff, 'missing BOM — Excel would mangle non-ASCII');
    assert.match(csv, /\r\n/);
    assert.match(csv, /Ünïcødé/);
  });
});

describe('token', () => {
  test('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.match(hash, /^pbkdf2\$100000\$/);
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
    assert.equal(await verifyPassword('wrong', hash), false);
  });

  test('salts — the same password hashes differently every time', async () => {
    assert.notEqual(await hashPassword('same'), await hashPassword('same'));
  });

  test('refuses a malformed or work-factor-stripped hash', async () => {
    for (const bad of ['', 'plaintext', 'pbkdf2$1$c2FsdA==$aGFzaA==', 'md5$100000$a$b', 'pbkdf2$100000$a']) {
      assert.equal(await verifyPassword('anything', bad), false, `should reject: ${bad}`);
    }
  });

  test('round-trips a signed token', async () => {
    const secret = randomSecretB64();
    const token = await signToken(newAdminPayload(7), secret);
    const payload = await verifyToken(token, secret);
    assert.equal(payload?.scope, 'admin');
    assert.equal(payload?.ver, 7);
  });

  test('rejects a tampered payload, a bad signature and the wrong secret', async () => {
    const secret = randomSecretB64();
    const token = await signToken(newAdminPayload(1), secret);
    const [v, payload, sig] = token.split('.');

    assert.equal(await verifyToken(token.slice(0, -1) + 'A', secret), null, 'tampered signature');
    assert.equal(await verifyToken(`${v}.${btoa('{"scope":"admin","exp":99999999999,"ver":1}')}.${sig}`, secret), null, 'swapped payload');
    assert.equal(await verifyToken(token, randomSecretB64()), null, 'wrong secret');
    assert.equal(await verifyToken('garbage', secret), null);
  });

  test('rejects an expired token', async () => {
    const secret = randomSecretB64();
    const expired = await signToken(
      { scope: 'admin', iat: 1000, exp: 2000, jti: 'x', ver: 1 },
      secret
    );
    assert.equal(await verifyToken(expired, secret), null);
  });
});

describe('validateGateLead', () => {
  test('accepts the four gate fields without serviceNeeded', () => {
    const r = validateGateLead({ firstName: 'Dana', lastName: 'Whitfield', email: 'd@example.com', phone: '(555) 246-8100' });
    assert.equal(r.valid, true);
  });

  test('flags missing and malformed fields', () => {
    const r = validateGateLead({ firstName: 'Dana', email: 'not-an-email', phone: '12' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.lastName);
    assert.ok(r.errors.email);
    assert.ok(r.errors.phone);
  });

  test('coerces non-string input instead of throwing', () => {
    // The Worker parses arbitrary JSON; a direct API call can send anything.
    assert.doesNotThrow(() => validateGateLead({ firstName: 42, email: {}, phone: [] } as never));
  });
});

describe('analytics', () => {
  test('buckets referrers to a fixed set', () => {
    assert.equal(bucketReferrer('https://app.canopytax.com/portal/x'), 'canopy');
    assert.equal(bucketReferrer('https://www.google.com/search?q=cpa'), 'google');
    assert.equal(bucketReferrer(''), 'direct');
    assert.equal(bucketReferrer('not a url'), 'other');
    // The key-space guard: an arbitrary host must collapse to 'other'.
    assert.equal(bucketReferrer('https://attacker-controlled-domain.test/'), 'other');
  });

  test('parses well-formed event keys and rejects junk', () => {
    const p = parseEventKey('ev:1988160:play:abc-123:uuid-here');
    assert.deepEqual(p, { bucket: 1988160, type: 'play', target: 'abc-123' });
    assert.equal(parseEventKey('ev:1988160:play:abc-123'), null, 'too few segments');
    assert.equal(parseEventKey('ev:notanumber:play:a:b'), null);
    assert.equal(parseEventKey('lead:2026-09:x:y:z'), null);
    assert.equal(parseEventKey('ev:1:bogustype:a:b'), null);
  });

  test('only allows key-safe targets', () => {
    assert.equal(isSafeTarget('abc-123_XY'), true);
    assert.equal(isSafeTarget('has:colon'), false, 'a colon would corrupt the key structure');
    assert.equal(isSafeTarget(''), false);
    assert.equal(isSafeTarget('x'.repeat(65)), false);
  });
});
