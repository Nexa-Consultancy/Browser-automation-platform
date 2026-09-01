import { createContext, useContext, useEffect, useState } from "react";

interface MicrosoftAuthContextType {
  profile: string | null;
  login: () => Promise<void>;
  selectProfile: (profileName: string) => Promise<void>;
}

const AuthContext = createContext<MicrosoftAuthContextType | undefined>(undefined);

export function useMicrosoftAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useMicrosoftAuth must be used within MicrosoftAuthProvider");
  }
  return context;
}

interface MicrosoftAuthProps {
  profileNames?: string[];
}

export function MicrosoftAuthProvider({ children, profileNames }: MicrosoftAuthProps) {
  const [profile, setProfile] = useState<string | null>(null);

  // Try to auto-select first available corporate Teams profile on load
  useEffect(() => {
    const savedProfile = localStorage.getItem("teams_corporate_profile");
    if (savedProfile && profileNames?.includes(savedProfile)) {
      setProfile(savedProfile);
    }
  }, [profileNames]);

  const login = async () => {
    try {
      // Redirect to MS Teams/Entra ID OAuth consent screen
      window.location.href = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
    } catch (error) {
      console.error("Login error:", error);
    }
  };

  const selectProfile = async (profileName: string) => {
    localStorage.setItem("teams_corporate_profile", profileName);
    setProfile(profileName);
    
    // If browser automation platform is containerized with volume mount,
    // the Teams cookies will be automatically shared across all new users.
    console.log(`[AuthProvider] Selected corporate profile: ${profileName}`);
  };

  return (
    <AuthContext.Provider value={{ profile, login, selectProfile }}>
      {children}
      
      {/* Global login overlay - only shows when no auth found */}
      {!profile && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#1e1e1e",
              padding: "30px",
              borderRadius: "8px",
              color: "#fff",
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            }}
          >
            <h2 style={{ margin: 0, marginBottom: "20px" }}>Teams Authentication Required</h2>
            <p style={{ margin: 0, color: "#aaa", marginBottom: "20px" }}>
              Please sign in with your Microsoft account to join Teams meetings.
            </p>
            <button
              onClick={login}
              style={{
                background: "#0078d4",
                color: "#fff",
                border: "none",
                padding: "12px 24px",
                borderRadius: "6px",
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              Sign in with Microsoft
            </button>
          </div>
        </div>
      )}

      {/* Profile selector button for users */}
      <select
        onChange={(e) => selectProfile(e.target.value)}
        value={profile || ""}
        style={{
          position: "fixed",
          bottom: "20px",
          right: "20px",
          background: "#333",
          color: "#fff",
          padding: "8px 16px",
          borderRadius: "4px",
          border: "1px solid #555",
          cursor: "pointer",
        }}
      >
        <option value="">Select Teams Profile</option>
        {profileNames?.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </AuthContext.Provider>
  );
}
