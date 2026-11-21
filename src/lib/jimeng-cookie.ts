export function parseCookiePairs(cookie: string): Array<[string, string]> {
  return cookie
    .trim()
    .replace(/^cookie\s*:\s*/i, "")
    .split(/[;\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf("=");
      const name = item.slice(0, separator).trim();
      if (separator < 1 || !name || /\s/.test(name)) {
        throw new Error("Cookie 格式无效");
      }
      return [name, item.slice(separator + 1).trim()] as [string, string];
    });
}

export function normalizeCookieHeader(
  credential: string | undefined,
  sessionCookie: string
): string {
  const raw = credential?.trim().replace(/^cookie\s*:\s*/i, "");
  if (!raw || /^[^\s;=]+$/.test(raw)) return sessionCookie;
  const pairs = parseCookiePairs(raw);
  if (!pairs.length) throw new Error("Cookie 格式无效");
  return pairs.map(([name, value]) => `${name}=${value}`).join("; ");
}
