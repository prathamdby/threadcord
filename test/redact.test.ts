import { describe, expect, it } from 'vitest';
import { redact, summarizeError } from '../src/util/redact.js';

describe('redact', () => {
  it('strips GitHub tokens from status text', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890AB';
    const sanitized = redact(`clone failed with ${token}`);

    expect(sanitized).not.toContain(token);
    expect(sanitized).toContain('[redacted]');
  });

  it('strips assignment-shaped secrets', () => {
    expect(redact('config token=super-secret-value')).toBe('config [redacted]');
  });
});

describe('summarizeError', () => {
  it('redacts secrets embedded in error messages', () => {
    const error = new Error('request failed: api_key=not-for-discord');

    expect(summarizeError(error)).toBe('request failed: [redacted]');
  });
});
