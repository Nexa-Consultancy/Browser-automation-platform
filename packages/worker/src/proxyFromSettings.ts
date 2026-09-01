export interface BrowserProxy {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Builds the Playwright proxy object from the Settings map, or undefined when
 * egress routing is off. HTTP proxies support username/password; Chromium
 * can't answer a SOCKS5 auth challenge, so SOCKS credentials are dropped
 * (IP-allowlist the server with the provider instead).
 */
export function proxyFromSettings(s: Record<string, string>): BrowserProxy | undefined {
  if (s.PROXY_ENABLED !== "true" || !s.PROXY_HOST || !s.PROXY_PORT) return undefined;
  const socks = s.PROXY_TYPE === "socks5";
  const scheme = socks ? "socks5" : "http";
  const proxy: BrowserProxy = { server: `${scheme}://${s.PROXY_HOST}:${s.PROXY_PORT}` };
  if (!socks && s.PROXY_USER) {
    proxy.username = s.PROXY_USER;
    if (s.PROXY_PASS) proxy.password = s.PROXY_PASS;
  }
  return proxy;
}
