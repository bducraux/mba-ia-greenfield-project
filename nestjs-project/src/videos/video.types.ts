export const PROCESSING_STATUSES = [
  'uploading',
  'processing',
  'ready',
  'failed',
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

// Phase 04 widens this set (and the matching DB CHECK).
export const PUBLICATION_STATUSES = ['draft'] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const FAILURE_REASONS = [
  'UNSUPPORTED_FORMAT',
  'PROCESSING_FAILED',
  'SOURCE_MISSING',
  'UPLOAD_REJECTED',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
