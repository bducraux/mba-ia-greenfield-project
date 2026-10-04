import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  REDIS_HOST: 'redis',
  STORAGE_ENDPOINT: 'http://seaweedfs:8333',
  STORAGE_PUBLIC_ENDPOINT: 'http://localhost:8333',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ACCESS_KEY: 'access',
  STORAGE_SECRET_KEY: 'secret',
  STORAGE_BUCKET: 'videos',
  STORAGE_THUMBNAILS_BUCKET: 'thumbnails',
  STORAGE_FORCE_PATH_STYLE: 'true',
  STORAGE_CORS_ORIGIN: 'http://localhost:3001',
};

interface EnvValidationResult {
  error?: ValidationError;
  value: Record<string, unknown>;
}

const validate = (env: Record<string, string>): EnvValidationResult =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — REDIS_*', () => {
  it('should reject a missing REDIS_HOST', () => {
    const withoutRedisHost: Record<string, string> = { ...requiredEnv };
    delete withoutRedisHost.REDIS_HOST;
    const { error } = envValidationSchema.validate(withoutRedisHost, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_HOST');
  });

  it('should default REDIS_PORT to 6379 when not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.REDIS_PORT).toBe(6379);
  });

  it('should reject a REDIS_PORT outside the valid port range', () => {
    const { error } = validate({ REDIS_PORT: '70000' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});

describe('envValidationSchema — STORAGE_*', () => {
  const validateWithout = (key: string): EnvValidationResult => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[key];
    return envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
  };

  it.each([
    'STORAGE_ENDPOINT',
    'STORAGE_PUBLIC_ENDPOINT',
    'STORAGE_REGION',
    'STORAGE_ACCESS_KEY',
    'STORAGE_SECRET_KEY',
    'STORAGE_BUCKET',
    'STORAGE_THUMBNAILS_BUCKET',
    'STORAGE_FORCE_PATH_STYLE',
    'STORAGE_CORS_ORIGIN',
  ])('should reject a missing %s', (key) => {
    const { error } = validateWithout(key);
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should coerce STORAGE_FORCE_PATH_STYLE to a boolean', () => {
    const { value, error } = validate({ STORAGE_FORCE_PATH_STYLE: 'false' });
    expect(error).toBeUndefined();
    expect(value.STORAGE_FORCE_PATH_STYLE).toBe(false);
  });
});
