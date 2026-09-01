// Modified Settings View to add Microsoft login UI
import { useState } from "react";
import "../SettingsView.css";
import { authApi, getOrCreateSessionForAuth, createSessionWithProfile, getSessionFromAuth, refreshAuth } from "@api/sessionAuthClient";

interface SettingsViewProps {
  user?: User;
  jobs?: Job[];
  groups?: Group[];
  onRefresh?: VoidFunction;
}

export function SettingsView({ user, jobs, groups, onRefresh }: SettingsViewProps) {
  // Microsoft login form state
  const [email, setEmail] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginSuccess, setLoginSuccess] = useState<string | null>(null);

  // Handle Microsoft social authentication
  const handleMicrosoftLogin = async () => {
    if (!email) {
      alert("Please enter your corporate email");
      return;
    }

    setIsLoggingIn(true);
    try {
      await authApi.getOrCreateSessionForAuth();
      setLoginSuccess(`Authenticated with corporate account (${email})`);

      // Auto-create a virtual browser session for this user
      const session = await createSessionWithProfile("teams-shared-auth");
      
      console.log(`[Settings] Session created: ${session.id}`);
      onRefresh?.();
    } catch (error) {
      console.error("[Settings] MS Login error:", error);
      setLoginSuccess(null);
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Load existing cached auth sessions if any
  useEffect(() => {
    const loadCachedSessions = async () => {
      try {
        const sessions = await getOrCreateSessionForAuth();
        if (sessions.count > 0) {
          setLoginSuccess(`Auto-login! ${sessions.count} cached session(s) available`);
        }
      } catch {}
    };

    loadCachedSessions();
  }, []);

  return (
    <div className="settings-view">
      <h1>Settings</h1>

      {/* Microsoft Authentication Section */}
      <section className="auth-settings">
        <h2>Teams Authentication Settings</h2>

        {/* Login Form Card */}
        <Card title="Login with Microsoft">
          {loginSuccess && (
            <Alert type="success" message={loginSuccess} />
          )}

          <div className="auth-form">
            {isLoggingIn ? (
              <span className="loading">Signing in...</span>
            ) : (
              <>
                {/* Email input for organizational account */}
                <input
                  type="email"
                  placeholder="corporate@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={ !!loginSuccess}
                />

                <button onClick={handleMicrosoftLogin} disabled={!email || !!loginSuccess}>
                  Launch Teams Login Window
                </button>
              </>
            )}
          </div>

          {/* Session info */}
          <p className="info">
            Once logged in, this authentication is cached and shared across ALL virtual browsers.
          </p>
        </Card>

        {/* Cached Sessions List */}
        {loginSuccess && (
          <Card title="Cached Auth Sessions">
            <div className="sessions-list">
              <p>Total sessions: {!!loginSuccess ? "✓ Available" : "No cached sessions yet"}
                Click login once → all browsers reuse it!</p>
              <Alert type="info" message="Persistent volume enabled - auth survives restarts!" />
            </div>
          </Card>
        )}

      </section>

      {/* Other settings... */}
    </div>
  );
}
