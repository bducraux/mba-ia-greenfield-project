import { buildAttachmentDisposition } from './content-disposition.util';

describe('buildAttachmentDisposition', () => {
  it('should use the title as-is for a plain ASCII title', () => {
    expect(buildAttachmentDisposition('my clip', 'mp4')).toBe(
      `attachment; filename="my clip.mp4"; filename*=UTF-8''my%20clip.mp4`,
    );
  });

  it('should percent-encode an accented title and degrade the ASCII fallback', () => {
    expect(buildAttachmentDisposition('Férias "2026"', 'mp4')).toBe(
      `attachment; filename="Ferias 2026.mp4"; filename*=UTF-8''F%C3%A9rias%20%222026%22.mp4`,
    );
  });

  it('should strip quotes and backslashes from the ASCII fallback only', () => {
    expect(buildAttachmentDisposition('a\\b"c', 'webm')).toBe(
      `attachment; filename="abc.webm"; filename*=UTF-8''a%5Cb%22c.webm`,
    );
  });

  it('should percent-encode the RFC 5987 characters encodeURIComponent keeps', () => {
    const header = buildAttachmentDisposition("it's (a)*", 'mp4');

    expect(header).toContain(`filename*=UTF-8''it%27s%20%28a%29%2A.mp4`);
  });

  it('should drop control characters from the ASCII fallback', () => {
    const header = buildAttachmentDisposition('line\r\nbreak', 'mp4');

    expect(header).toContain('filename="linebreak.mp4"');
    expect(header).not.toMatch(/[\r\n]/);
  });

  it('should fall back to a generic name when no ASCII remains', () => {
    expect(buildAttachmentDisposition('日本語', 'mp4')).toBe(
      `attachment; filename="video.mp4"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.mp4`,
    );
  });
});
