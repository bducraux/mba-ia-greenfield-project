import { randomBytes } from 'crypto';

const SHORT_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// 8 random bytes encode to exactly 11 base64url chars (no padding).
export function generateShortId(): string {
  return randomBytes(8).toString('base64url');
}

export function isValidShortId(value: string): boolean {
  return SHORT_ID_PATTERN.test(value);
}
