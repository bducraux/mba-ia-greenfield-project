import type { ValueTransformer } from 'typeorm';

// node-postgres returns `bigint` columns as strings to avoid precision loss.
// Only use on columns whose values stay within Number.MAX_SAFE_INTEGER.
export const bigintNumberTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};
