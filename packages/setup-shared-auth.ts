import { getOrCreateSessionForAuth, createSessionWithProfile } from "@api/sessionAuthClient";

/**
 * Run this script once after starting the server to:
 * 1. Authenticate with Microsoft account
 * 2. Cache auth cookies
 * 3. Make them available to all virtual browsers
 */

async function main() {
  console.log("[Setup] Starting Teams shared auth setup...");
  
  // Step 1: Get existing cached session (if any) or create new one
  try {
    const sessions = await getOrCreateSessionForAuth();
    if (sessions.count > 0) {
      console.log(`[Setup] ✓ Found ${sessions.count} cached session(s)`);
      console.log("[Setup] All browsers will auto-reuse this auth!");
    } else {
      throw new Error("No cached sessions. Please login first via Settings page.");
    }
  } catch (error) {
    if (error.message?.includes("not authenticated")) {
      console.log("[Setup] → No cache yet. Login via Settings > Login with Microsoft button.");
    } else {
      throw error;
    }
  }

  // Step 2: Create browser session with cached auth
  try {
    const session = await createSessionWithProfile("teams-shared-auth");
    console.log(`[Setup] ✓ Created session: ${session.id}`);
    console.log("[Setup] Done! Go to Teams link → users will auto-login.");
  } catch (error) {
    console.error("[Setup] Error:", error);
  }
}

main();
