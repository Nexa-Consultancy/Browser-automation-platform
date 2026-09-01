import { Router, Request, Response } from "express";
import axios from "axios";

const router = Router();

interface AuthToken {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  profileId: string; // Teams user ID
}

// Store in-memory token cache (use Redis in production)
const tokenCache = new Map<string, AuthToken>();

router.post("/login", async (req: Request, res: Response) => {
  try {
    const response = await axios.post(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      "grant_type=client_credentials&scope=https://graph.microsoft.com/.default",
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        auth: {
          username: process.env.TEAMS_CLIENT_ID || "",
          password: process.env.TEAMS_CLIENT_SECRET || "",
        },
      }
    );

    const { access_token: accessToken } = response.data;

    tokenCache.set("teams", {
      accessToken,
      refreshToken: null,
      expiresIn: response.data.expires_in,
      profileId: "shared-teams-auth",
    });

    res.json({ success: true, message: "Authenticated to Microsoft Graph" });
  } catch (error) {
    console.error("Microsoft auth error:", error);
    res.status(500).json({ error: "Failed to authenticate with Microsoft" });
  }
});

router.get("/profile", async (req: Request, res: Response) => {
  const token = tokenCache.get("teams");
  if (!token?.accessToken) {
    return res.status(401).json({ error: "Not authenticated with Microsoft Graph" });
  }

  try {
    const response = await axios.get(
      "https://graph.microsoft.com/v1.0/me",
      {
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
        },
      }
    );

    res.json({
      id: response.data.id,
      displayName: response.data.displayName || response.data.userPrincipalName,
      userPrincipalName: response.data.userPrincipalName,
      profileId: token.profileId,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch Microsoft profile" });
  }
});

export default router;
