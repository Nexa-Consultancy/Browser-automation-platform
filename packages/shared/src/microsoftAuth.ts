export interface MicrosoftProfile {
  id: string;
  displayName: string;
  userPrincipalName: string;
  accessToken: string;
  refreshToken?: string;
  profilePath: string; // Path to saved browser data dir
  lastUsed: Date;
}

// In-memory cache (use Redis in production)
let profiles: Map<string, MicrosoftProfile> = new Map();

/**
 * Create/initialize a shared Microsoft auth session
 * Returns a profile ID that all browsers can use for MS Teams authentication
 */
export function createMicrosoftSession(
  profileName: string,
  accessToken?: string,
  refreshToken?: string
): MicrosoftProfile {
  const id = `teams:${profileName}:${Date.now()}`;

  profiles.set(id, {
    id,
    displayName: profileName || "Corporate Teams",
    userPrincipalName: process.env.DEFAULT_TEAMS_USER || "share@company.onmicrosoft.com",
    accessToken: accessToken || "",
    refreshToken: refreshToken || null,
    profilePath: getAppDataPath(),
    lastUsed: new Date(),
  });

  console.log(`[Microsoft Auth] Profile created: ${id}`);
  return profiles.get(id)!;
}

/**
 * Get active Microsoft auth session
 */
export function getMicrosoftSession(profileName?: string): MicrosoftProfile | null {
  if (!profileName) {
    // Return shared default profile
    return profiles.values().next().value ?? null; 
  }
  
  const key = `teams:${profileName}`;
  return profiles.get(key) ?? profiles.values().next().value ?? null;
}

/**
 * Authenticate browser session with MS Graph cookies/headers
 */
export async function authenticateBrowserSession(
  browserContext: any,
  profileId: string
): Promise<void> {
  const session = getMicrosoftSession(profileId);
  
  if (!session?.accessToken) {
    throw new Error("No Microsoft auth token available");
  }

  // Set MS Graph headers for Teams authentication
  browserContext.addInitScript((token) => {
    // Create a persistent cookie file for Teams auth
    const cookiePath = `${token.profilePath}/teams-auth-cookies-${token.id}.json`;
    console.log(`[Teams Auth] Saving auth cookies to: ${cookiePath}`);
  }, {
    id: profileId,
    profilePath: session.profilePath,
  });

  // Pass auth headers through puppeteer/context
  browserContext.authenticate({
    accessToken: session.accessToken,
    tenantId: process.env.TEAMS_TENANT_ID || "common",
  });
}

/**
 * Load saved MS Teams browser profile (with auto-login state)
 */
export async function loadSavedBrowserProfile(
  profileName: string
): Promise<void> {
  const session = getMicrosoftSession(profileName);
  const profilePath = `${session?.profilePath || getAppDataPath()}`;

  // Check for saved browser data directory (Chrome/Edge teams cookies)
  const cookieFile = `${profilePath}/Chrome/Default/Cookies`;
  
  if (!session.accessToken && !isCookiesPresent(cookieFile)) {
    throw new Error(`No auth cookies found for profile: ${profileName}`);
  }

  // Inject saved browser state into new context
  await authenticateBrowserSession(null, profileName!);
}

/**
 * Get all available Microsoft Teams sessions
 */
export function listSessions(): MicrosoftProfile[] {
  return Array.from(profiles.values());
}

function getAppDataPath(): string {
  // Use Docker volume path if containerized, else user home
  const isContainer = process.env.VOLUME_DATA;
  return isContainer 
    ? "/app/data/browsers" 
    : process.env.HOME || "~/Library/Application Support";
}

function isCookiesPresent(path: string): boolean {
  try {
    // Simple file existence check
    return require("fs").accessSync(path);
  } catch {
    return false;
  }
}
