/**
 * Typed storage errors so domain services never depend on AWS SDK error names.
 */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Object key does not exist (`NotFound` / `NoSuchKey`). */
export class StorageObjectNotFoundError extends StorageError {}

/** Multipart upload id is unknown, completed or aborted (`NoSuchUpload`). */
export class StorageUploadNotFoundError extends StorageError {}

/** Storage rejected the part list (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`). */
export class StorageInvalidPartsError extends StorageError {}
