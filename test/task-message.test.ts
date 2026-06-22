import { describe, expect, it } from 'vitest';
import { parseTaskMessage } from '../src/task/parser.js';

describe('parseTaskMessage', () => {
  it('accepts a task when instruction precedes keyed fields', () => {
    const result = parseTaskMessage(
      [
        'Fix the failing auth test and open a PR.',
        '',
        'repo: acme/web',
        'branch: main',
        'model: anthropic/claude-sonnet-4-5'
      ].join('\n')
    );

    expect(result).toMatchObject({
      ok: true,
      request: {
        instruction: 'Fix the failing auth test and open a PR.',
        repo: 'acme/web',
        branch: 'main',
        model: 'anthropic/claude-sonnet-4-5'
      }
    });
  });

  it('parses optional push override and case-insensitive field names', () => {
    const result = parseTaskMessage(
      [
        'Ship the fix.',
        'REPO: acme/web',
        'Branch: main',
        'MODEL: anthropic/claude-sonnet-4-5',
        'push: main'
      ].join('\n')
    );

    expect(result).toMatchObject({
      ok: true,
      request: {
        instruction: 'Ship the fix.',
        pushOverride: 'main'
      }
    });
  });

  it('rejects messages with no instruction prose', () => {
    const result = parseTaskMessage(
      ['repo: acme/web', 'branch: main', 'model: anthropic/claude-sonnet-4-5'].join('\n')
    );

    expect(result).toEqual({
      ok: false,
      message: 'Missing task instruction before the keyed fields.'
    });
  });

  it('rejects messages missing required keyed fields', () => {
    const result = parseTaskMessage(['Do the thing.', 'repo: acme/web'].join('\n'));

    expect(result).toEqual({
      ok: false,
      message: 'Missing required fields: branch, model'
    });
  });

  it('keeps prose with colons when the key is not a known metadata field', () => {
    const result = parseTaskMessage(
      [
        'Summary: fix flaky login test',
        '',
        'repo: acme/web',
        'branch: main',
        'model: anthropic/claude-sonnet-4-5'
      ].join('\n')
    );

    expect(result).toMatchObject({
      ok: true,
      request: {
        instruction: 'Summary: fix flaky login test',
        repo: 'acme/web',
        branch: 'main',
        model: 'anthropic/claude-sonnet-4-5'
      }
    });
  });

  it('handles Windows line endings', () => {
    const result = parseTaskMessage(
      'Fix it.\r\nrepo: acme/web\r\nbranch: main\r\nmodel: anthropic/claude-sonnet-4-5'
    );

    expect(result).toMatchObject({ ok: true, request: { instruction: 'Fix it.' } });
  });
});
