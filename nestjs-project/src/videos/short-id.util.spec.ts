import { generateShortId, isValidShortId } from './short-id.util';

describe('generateShortId', () => {
  it('returns 11 base64url characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateShortId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('returns a different value on each call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateShortId()));
    expect(ids.size).toBe(100);
  });
});

describe('isValidShortId', () => {
  it('accepts a generated short id', () => {
    expect(isValidShortId(generateShortId())).toBe(true);
  });

  it('accepts 11 chars including - and _', () => {
    expect(isValidShortId('aZ09_-aZ09_')).toBe(true);
  });

  it.each([
    ['too short', 'abcdefghij'],
    ['too long', 'abcdefghijkl'],
    ['empty', ''],
    ['standard base64 chars', 'abcdefghi+/'],
    ['padding', 'abcdefghij='],
    ['whitespace', ' abcdefghij'],
    ['uuid', '3f1c2a9e-8d4b-4c1e-9a7f-2b6d5e8c1a0f'],
  ])('rejects %s', (_label, value) => {
    expect(isValidShortId(value)).toBe(false);
  });
});
