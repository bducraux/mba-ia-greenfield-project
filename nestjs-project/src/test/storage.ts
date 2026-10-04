import { request } from 'node:http';

export interface StorageHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface StorageHttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

/**
 * Sends a request to a storage URL (presigned or public) from inside the
 * Compose network. Browser-facing URLs use STORAGE_PUBLIC_ENDPOINT
 * (`localhost:8333`), which is not reachable from a container, so the TCP
 * connection goes to STORAGE_ENDPOINT while the original `Host` header is
 * kept — SigV4 signs the host, so it must match what the URL was signed for.
 */
export async function storageHttpRequest(
  url: string,
  options: StorageHttpOptions = {},
): Promise<StorageHttpResponse> {
  const target = new URL(url);
  const internal = new URL(process.env.STORAGE_ENDPOINT ?? '');

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: internal.hostname,
        port: internal.port,
        method: options.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        headers: {
          ...options.headers,
          Host: target.host,
          ...(options.body ? { 'Content-Length': options.body.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
