/**
 * Remote MCP URL and header validation (`docs/design.md` §5.7).
 *
 * The spec's remote-server requirements are not fully expressible in JSON
 * Schema, so they are enforced by custom checks here: the URL must be
 * absolute HTTP(S) with no user info and no fragment, non-loopback hosts
 * require HTTPS, header names must be valid HTTP field names with no
 * duplicates under case-insensitive comparison.
 */

/** HTTP field-name token (RFC 7230): tchar characters. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validates a remote MCP URL against the spec rules.
 *
 * @param url - The URL to check.
 * @returns A problem description, or null when valid.
 */
export function validateRemoteUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'server URL is not a valid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'server URL must be absolute http(s)';
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'server URL must not contain user info';
  }
  if (parsed.hash !== '') {
    return 'server URL must not contain a fragment';
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.protocol === 'http:' && !isLoopbackHost(host)) {
    return 'non-loopback server URLs must use https';
  }
  return null;
}

/**
 * Checks whether the host is localhost or a loopback IP literal.
 *
 * @param host - Lowercased hostname (brackets already stripped).
 * @returns True for `localhost`, `::1`, or any `127.x.x.x` literal.
 */
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') {
    return true;
  }
  return /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * Validates HTTP header names: well-formed field names, unique under
 * case-insensitive comparison (not expressible in JSON Schema).
 *
 * @param headers - The headers to validate.
 * @returns A problem description, or null when valid.
 */
export function validateHeaders(headers: Record<string, string>): string | null {
  const seen = new Set<string>();
  for (const name of Object.keys(headers)) {
    if (!HEADER_NAME_RE.test(name)) {
      return `header name "${name}" is not a valid HTTP field name`;
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      return `duplicate header name "${name}" (case-insensitive)`;
    }
    seen.add(lower);
  }
  return null;
}
