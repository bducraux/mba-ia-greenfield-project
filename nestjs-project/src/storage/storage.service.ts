import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { STORAGE_SDK_ERRORS } from './storage.constants';
import {
  StorageError,
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from './storage.errors';

/** Logical bucket: `videos` = private STORAGE_BUCKET, `thumbnails` = public-read STORAGE_THUMBNAILS_BUCKET. */
export type StorageBucket = 'videos' | 'thumbnails';

/** `internal` signs for STORAGE_ENDPOINT (server/worker), `public` for STORAGE_PUBLIC_ENDPOINT (browser). */
export type StorageClientKind = 'internal' | 'public';

export interface StoragePart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface StorageObjectHead {
  contentLength: number;
  contentType?: string;
}

export interface PutObjectOptions {
  contentType: string;
  cacheControl?: string;
}

export interface PresignGetOptions {
  expiresIn: number;
  responseContentDisposition?: string;
}

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.internalClient = this.createClient(config.endpoint);
    this.publicClient = this.createClient(config.publicEndpoint);
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new StorageError('Storage did not return an UploadId');
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async listParts(key: string, uploadId: string): Promise<StoragePart[]> {
    const parts: StoragePart[] = [];
    let marker: string | undefined;
    try {
      do {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.config.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber ?? 0,
            etag: part.ETag ?? '',
            size: part.Size ?? 0,
          });
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
    } catch (error) {
      throw this.mapError(error);
    }
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map(({ partNumber, etag }) => ({
              PartNumber: partNumber,
              ETag: etag,
            })),
          },
        }),
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async headObject(
    bucket: StorageBucket,
    key: string,
  ): Promise<StorageObjectHead> {
    try {
      const head = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
      );
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType,
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async deleteObject(bucket: StorageBucket, key: string): Promise<void> {
    try {
      await this.internalClient.send(
        new DeleteObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async putObject(
    bucket: StorageBucket,
    key: string,
    body: Buffer,
    options: PutObjectOptions,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucketName(bucket),
        Key: key,
        Body: body,
        ContentType: options.contentType,
        CacheControl: options.cacheControl,
      }),
    );
  }

  async presignGetObject(
    client: StorageClientKind,
    key: string,
    options: PresignGetOptions,
  ): Promise<string> {
    return getSignedUrl(
      client === 'public' ? this.publicClient : this.internalClient,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: options.expiresIn },
    );
  }

  buildPublicObjectUrl(bucket: StorageBucket, key: string): string {
    const base = new URL(this.config.publicEndpoint);
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const name = this.bucketName(bucket);
    if (this.config.forcePathStyle) {
      const path = base.pathname.replace(/\/$/, '');
      return `${base.origin}${path}/${name}/${encodedKey}`;
    }
    return `${base.protocol}//${name}.${base.host}/${encodedKey}`;
  }

  private bucketName(bucket: StorageBucket): string {
    return bucket === 'videos'
      ? this.config.bucket
      : this.config.thumbnailsBucket;
  }

  private createClient(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
      // Presigned part URLs are PUT by the browser, which cannot send SDK
      // flexible-checksum headers; only compute checksums when S3 requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private mapError(error: unknown): unknown {
    const name = (error as { name?: string } | null)?.name;
    if (!name) return error;
    const matches = (names: readonly string[]): boolean => names.includes(name);
    if (matches(STORAGE_SDK_ERRORS.OBJECT_NOT_FOUND)) {
      return new StorageObjectNotFoundError(name, { cause: error });
    }
    if (matches(STORAGE_SDK_ERRORS.UPLOAD_NOT_FOUND)) {
      return new StorageUploadNotFoundError(name, { cause: error });
    }
    if (matches(STORAGE_SDK_ERRORS.INVALID_PARTS)) {
      return new StorageInvalidPartsError(name, { cause: error });
    }
    return error;
  }
}
