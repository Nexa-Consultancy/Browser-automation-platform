import { sql } from ".";

interface MicrosoftSession {
  id: string;
  profileName: string;
  userPrincipalName: string;
  displayName: string;
  active: boolean;
  lastAccessedAt: Date;
}

/**
 * Register a new Microsoft Teams auth session in database
 */
export async function registerMicrosoftSession(
  profileName: string,
  userPrincipalName: string,
  clientRequestId?: string
): Promise<string> {
  const id = `teams_${Date.now()}_${profileName}`;
  
  // For browser sharing, we store session metadata (not the actual tokens)
  await sql`
    INSERT INTO microsoft_sessions (id, profile_name, user_principal_name, display_name, active, client_request_id)
    VALUES (${id}, ${profileName}, ${userPrincipalName}, ${profileName}, true, ${clientRequestId})
    ON CONFLICT (id) DO UPDATE SET 
      active = true,
      last_accessed_at = NOW(),
      user_principal_name = excluded.user_principal_name
  `;

  return id;
}

/**
 * Get all active Microsoft sessions for Teams authentication
 */
export async function getActiveMicrosoftSessions(): Promise<MicrosoftSession[]> {
  return sql`
    SELECT * FROM microsoft_sessions 
    WHERE active = true 
    ORDER BY last_accessed_at DESC
  `;
}

/**
 * Deactivate an old session (keeps only one per company domain)
 */
export async function deactivateOldSessions(userPrincipalName: string): Promise<void> {
  await sql`
    UPDATE microsoft_sessions 
    SET active = false, last_accessed_at = NOW() - interval '30 days'
    WHERE profile_name LIKE ${userPrincipalName}
      AND id != current_id
    RETURNING *
  `;
}

/**
 * Get Microsoft session for a specific browser context
 */
export async function getMicrosoftSessionForBrowser(
  containerId: string
): Promise<string | null> {
  const sessionId = await sql`
    SELECT client_request_id FROM microsoft_sessions 
    WHERE active = true 
      AND profile_name NOT LIKE '%personal%'
    LIMIT 1
  `;

  return sessionId?.clientRequestid || null;
}
