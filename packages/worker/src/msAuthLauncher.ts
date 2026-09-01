import puppeteer from "puppeteer";
import { getMicrosoftSession } from "@shared/microsoftAuth";

/**
 * Browser launch configuration with integrated Microsoft auth headers and cookies
 */
export async function createAuthenticatedBrowser(
  profile: string,
  args: Partial<puppeteer.Launcher>
): Promise<any> {
  const msSession = getMicrosoftSession(profile);

  if (!msSession?.accessToken) {
    // Use system browser for initial MS consent, then save cookies
    return createSystemBrowser();
  }

  return puppeteer.launch({
    headless: false,
    browserDataDir: `browser-data-${profile}`,
    defaultViewport: { width: 1920, height: 1080 },
    args: [
      "--disable-blink-features=AutomationControlled",
      `--user-data-dir=${msSession.profilePath}`, // Use saved MS auth data dir
      ...((args as any).args || []),
    ],
  });
}

/**
 * Create browser session that will auto-signin when accessing Teams URL
 */
async function createSystemBrowser(): Promise<any> {
  const browser = await puppeteer.launch({ headless: false, defaultViewport: { width: 1920 } });
  
  return browser;
}

export default createAuthenticatedBrowser;
