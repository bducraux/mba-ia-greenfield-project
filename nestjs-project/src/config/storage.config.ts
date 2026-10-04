import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT ?? '',
  publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT ?? '',
  region: process.env.STORAGE_REGION ?? '',
  accessKey: process.env.STORAGE_ACCESS_KEY ?? '',
  secretKey: process.env.STORAGE_SECRET_KEY ?? '',
  bucket: process.env.STORAGE_BUCKET ?? '',
  thumbnailsBucket: process.env.STORAGE_THUMBNAILS_BUCKET ?? '',
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === 'true',
  corsOrigin: process.env.STORAGE_CORS_ORIGIN ?? '',
}));
