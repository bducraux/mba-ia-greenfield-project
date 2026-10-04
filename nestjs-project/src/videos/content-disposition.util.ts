/** Used when the title has no printable ASCII left after stripping. */
const ASCII_FALLBACK_NAME = 'video';

/**
 * Printable ASCII only, without `"` and `\` (they would need quoting inside
 * the quoted-string). Accents are decomposed first so `é` degrades to `e`.
 */
function toAsciiFileName(title: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '')
    .trim();
  return ascii || ASCII_FALLBACK_NAME;
}

/** RFC 5987 `attr-char`: `encodeURIComponent` also leaves `'()*` unescaped. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `Content-Disposition` forcing a download: an ASCII `filename` fallback plus
 * the exact UTF-8 title in `filename*` (RFC 6266).
 */
export function buildAttachmentDisposition(title: string, ext: string): string {
  const fallback = `${toAsciiFileName(title)}.${ext}`;
  const encoded = `${encodeRfc5987(title)}.${ext}`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
