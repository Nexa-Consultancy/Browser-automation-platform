// Guards the one place a step's target URL reaches a real network/filesystem
// call: `open <url>` → page.goto(). Steps (and the CSV values they template
// in) are user-authored, so without this an "open" step could pull local
// files off the worker container (file:///etc/passwd) or hit the cloud
// metadata endpoint (http://169.254.169.254/, a well-known credential-theft
// vector) and then exfiltrate the response via a follow-up
// `screenshot`/`wait for text` step.
//
// Deliberately NOT blocked: localhost / 127.0.0.1 and RFC1918 private
// ranges (10.x, 172.16-31.x, 192.168.x). Testing an app that only lives on
// localhost or an internal network is this tool's actual intended use —
// this platform may itself be deployed on the same host or LAN as the
// application under test.

const BLOCKED_HOSTNAMES = new Set(["metadata.google.internal", "metadata"]);

function isLinkLocalIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  return Number(m[1]) === 169 && Number(m[2]) === 254; // 169.254.0.0/16, incl. cloud metadata
}

/**
 * Throws if the URL isn't safe to navigate to. Only http/https are allowed
 * (blocks file:, chrome:, data:, javascript:, etc.), and the link-local /
 * cloud-metadata range is blocked. This is a literal hostname/IP check, not
 * DNS-rebinding-proof — adequate for this tool's threat model (a small team
 * testing applications they own), not a hard network sandbox.
 */
export function assertSafeNavigationTarget(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`"${rawUrl}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Refusing to open "${rawUrl}" — only http/https URLs are allowed`);
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || isLinkLocalIPv4(host) || host === "[fe80::0]" || host.startsWith("fe80:")) {
    throw new Error(`Refusing to open "${rawUrl}" — points at a link-local/cloud-metadata address`);
  }
}
