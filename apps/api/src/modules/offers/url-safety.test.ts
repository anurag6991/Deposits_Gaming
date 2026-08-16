import { describe, expect, it } from 'vitest';
import { isSafeHttpUrl } from '@deposits/shared';

/**
 * Offer URLs are rendered as a clickable link on the publisher task screen, so
 * a non-http scheme stored here becomes script execution in the publisher's
 * browser. Zod's .url() accepts every scheme, which is how this got through the
 * first time; a live probe found it.
 */
describe('offer URL safety', () => {
  it('accepts ordinary web addresses', () => {
    for (const url of [
      'https://example.com',
      'http://example.com/offer?a=1',
      'https://sub.domain.example.co.uk/path#frag',
      'https://example.com:8443/x',
    ]) {
      expect(isSafeHttpUrl(url), url).toBe(true);
    }
  });

  it('rejects schemes that execute or embed content', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'about:blank',
    ]) {
      expect(isSafeHttpUrl(url), url).toBe(false);
    }
  });

  it('rejects anything that is not a URL at all', () => {
    for (const url of ['', 'not a url', '//example.com', 'example.com']) {
      expect(isSafeHttpUrl(url), url).toBe(false);
    }
  });
});
