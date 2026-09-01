# Teams Authentication Fix - Guest/Unverified User Resolution

## Problem
When joining Teams meetings from the server's browser, users appear as "guest" or "unverified" instead of their real name. Locally it works fine, but on production server browsers don't have MS Teams authentication.

## Root Cause
Teams requires valid Microsoft Entra ID (Azure AD) OAuth tokens. New browser sessions on headless/server environments have no cached auth cookies for your org's Teams instance.

## Complete Fix - Shared Auth System

### 1. Setup Steps (Run Once)

```bash
# Copy auth config
cp Browser-automation-platform/.env.example Browser-automation-platform/.env.azure

# Edit with your values:
TEMS_TENANT_ID=your-company-com-on-microsoft-com
TEAMS_CLIENT_ID=xxx-xxx-xxx
ENABLE_SHARED_AUTH=true

# Start server with shared volume mount:
docker-compose up -d  # This ensures browser-data/ persists

# First user logs in via Teams link → auth cookies saved to /app/data/browsers

# Any new browser session will auto-load those cookies → no more "guest"!
```

### 2. How It Works

✓ **Persistent Browser Data**: MS Teams stores OAuth tokens in `chrome/user-data/` and app-specific folders  
✓ **Shared Volume Mount**: All containers mount to same `/app/data/browsers` directory  
✓ **Auto-Reused Auth**: New users get existing auth cookies → appears as real name, not "guest"  

### 3. Architecture

```
┌─────────────────────────────────────┐
│ Browser Instance 1 (User A joins)   │
│ → MS Teams login → Saves cookies    │
│ → Appears as: "John Doe"            │
└──────────────┬──────────────────────┘
               │ /app/data/browsers
┌──────────────▼──────────────────────┐
│ Shared Auth Cookie Store            │
│ (Persisted across sessions & users)  │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│ Browser Instance 2 (User B joins)   │
│ → Loads saved cookies → Auto-login  │
│ → Appears as: "Jane Smith"           │
└─────────────────────────────────────┘
```

### 4. Files Created

1. `packages/auth-instructions.md` - This guide
2. `packages/shared/src/microsoftAuth.ts` - Auth session management
3. `packages/dashboard/src/components/MicrosoftAuthProvider.tsx` - React component with login overlay
4. `.env.azure` - Azure/Entra ID config template
5. `docker-compose.auth.yml` - Volume configuration for shared auth

### 5. Quick Deploy Commands

```bash
# Enable shared auth on server
ENV_BROWSERS_DATA_DIR=/app/data/browsers-shared docker-compose up -d

# Wait a minute, then first user joins Teams → auth cached

# Done! All subsequent users get auto-auth
```

### 6. Verify It's Working

Check if browser data persists:
```bash
ls /app/data/browsers/Teams/Default/LoginToken.json  # Should exist

# Check for existing tokens with admin account:
ls -la chrome/user-data/default/Cookies-*
```

## Important Notes

- **First login required**: Someone must log in once to store auth cookies
- **Same tenant/domain**: All users should use Org Teams (not personal/professional accounts)  
- **Persistent volume needed**: Don't use tmpfs or ephemeral storage for browser data dir
- **Session refresh happens automatically** if tokens expire

## Troubleshooting

| Symptom | Solution |
|---------|----------|
| Still seeing "guest" | Clear browser cache: `docker-compose down; docker-compose up -d` |
| Wrong account showing | Delete `chrome/user-data/default/Default/Preferences.js` to reset profile |
| Can't find auth folder | Check shared volumes are mounted correctly: `docker-compose ps -a` |

## Next Steps (Optional)

If you want to manage auth via API, create Microsoft Graph integration in `/packages/api/src/routes/microsoft/` with client credentials flow for service-to-service auth.
