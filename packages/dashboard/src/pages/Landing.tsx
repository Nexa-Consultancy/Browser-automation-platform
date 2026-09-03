import { PUBLIC_PATHS, navigate } from "../nav";

/**
 * The public face of the product. Someone arriving at the bare domain has
 * no idea what this is, so the page has one job: say what it does, show
 * that it is a real scheduling/automation tool rather than a script, and
 * put Log in / Sign up where people look for them (top right).
 */

const FEATURES: { title: string; body: string; icon: string }[] = [
  {
    icon: "🗓",
    title: "Runs on its own schedule",
    body:
      "Give a group a link, a task and a window — 12:30 to 3:00 PM, Mon–Fri — and the server opens the browsers, joins, and closes them again. Nobody has to be at their desk.",
  },
  {
    icon: "🏢",
    title: "Organizations, groups, people",
    body:
      "Model the company the way it actually is: an organization holds departments, a department holds people. Move people between groups, or between organizations, in bulk.",
  },
  {
    icon: "🔐",
    title: "Real logins, captured once",
    body:
      "Each person signs into Microsoft/Teams once. The session is saved and reused, so every run joins as them — not as a typed guest name. Online/offline tells you at a glance who is ready.",
  },
  {
    icon: "🖥",
    title: "Watch it live, take over",
    body:
      "Every session streams back as live video. If something needs a human, click straight into the browser and drive it yourself, then hand it back.",
  },
  {
    icon: "🧩",
    title: "Reusable step templates",
    body:
      "Write the steps once in plain English — click, fill, wait for text, wait for video — and set one as the default so every new group starts ready to save.",
  },
  {
    icon: "🔔",
    title: "Tells you when it breaks",
    body:
      "Failures and lifecycle events go to email, Discord or Telegram, with the user, the group and a suggested first move — not a bare stack trace.",
  },
];

const STEPS: { n: string; title: string; body: string }[] = [
  { n: "1", title: "Create an organization", body: "Your company, a client, or a campus." },
  { n: "2", title: "Add groups and people", body: "A department per group; people sign in once each." },
  { n: "3", title: "Set the window", body: "Days and times. The server takes it from there, every day." },
];

export function Landing({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="site">
      <header className="site-header">
        <div className="site-brand">
          <span className="mark" />
          <span>Browser Automation</span>
        </div>
        <nav className="site-nav">
          <a href="#features" onClick={(e) => { e.preventDefault(); document.getElementById("features")?.scrollIntoView({ behavior: "smooth" }); }}>
            Features
          </a>
          <a href="#how" onClick={(e) => { e.preventDefault(); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); }}>
            How it works
          </a>
          {signedIn ? (
            <button className="primary" onClick={() => navigate("/dashboard")}>
              Open dashboard
            </button>
          ) : (
            <>
              <button onClick={() => navigate(PUBLIC_PATHS.login)}>Log in</button>
              <button className="primary" onClick={() => navigate(PUBLIC_PATHS.signup)}>
                Sign up
              </button>
            </>
          )}
        </nav>
      </header>

      <section className="site-hero">
        <div className="site-hero-text">
          <div className="site-eyebrow">Scheduled browser automation</div>
          <h1>
            Meetings that join themselves.
            <br />
            Every day, on time, without you.
          </h1>
          <p>
            Put your people and their links into groups, set the window once, and the server opens a real signed-in
            browser for each of them — then closes it when the window ends. Watch any session live, or take the
            controls yourself.
          </p>
          <div className="site-hero-actions">
            {signedIn ? (
              <button className="primary big" onClick={() => navigate("/dashboard")}>
                Open dashboard
              </button>
            ) : (
              <>
                <button className="primary big" onClick={() => navigate(PUBLIC_PATHS.signup)}>
                  Get started
                </button>
                <button className="big" onClick={() => navigate(PUBLIC_PATHS.login)}>
                  Log in
                </button>
              </>
            )}
          </div>
          <div className="site-hero-note">New accounts are reviewed before they're switched on.</div>
        </div>

        {/* A miniature of the real product rather than stock art — it is the
            quickest honest answer to "what does this actually look like". */}
        <div className="site-hero-art" aria-hidden="true">
          <div className="mini-window">
            <div className="mini-bar">
              <span /> <span /> <span />
            </div>
            <div className="mini-body">
              <div className="mini-rail">
                <div className="mini-rail-item on">Acme Corp</div>
                <div className="mini-rail-item">Northwind</div>
                <div className="mini-rail-item">Riverside</div>
              </div>
              <div className="mini-main">
                <div className="mini-card live">
                  <div className="mini-card-head">
                    <strong>IT department</strong>
                    <span className="mini-pill live">live</span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-chip on">● Ravi</span>
                    <span className="mini-chip on">● Asha</span>
                    <span className="mini-chip">● Dev</span>
                  </div>
                  <div className="mini-meta">12:25 PM → 3:00 PM · Mon–Fri</div>
                </div>
                <div className="mini-card">
                  <div className="mini-card-head">
                    <strong>Evening class</strong>
                    <span className="mini-pill">idle</span>
                  </div>
                  <div className="mini-meta">5:55 PM → 8:00 PM · Mon, Wed</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="site-section" id="features">
        <h2>Everything it does</h2>
        <div className="site-grid">
          {FEATURES.map((f) => (
            <div className="site-feature" key={f.title}>
              <div className="site-feature-icon" aria-hidden="true">
                {f.icon}
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="site-section site-how" id="how">
        <h2>How it works</h2>
        <div className="site-steps">
          {STEPS.map((s) => (
            <div className="site-step" key={s.n}>
              <div className="site-step-n">{s.n}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="site-cta">
        <h2>Ready to stop joining things by hand?</h2>
        <p>Tell us what you'd use it for and we'll switch your account on.</p>
        <button className="primary big" onClick={() => navigate(signedIn ? "/dashboard" : PUBLIC_PATHS.signup)}>
          {signedIn ? "Open dashboard" : "Create an account"}
        </button>
      </section>

      <footer className="site-footer">
        <span>Browser Automation</span>
        <span>
          <a href={PUBLIC_PATHS.login} onClick={(e) => { e.preventDefault(); navigate(PUBLIC_PATHS.login); }}>
            Log in
          </a>
          {" · "}
          <a href={PUBLIC_PATHS.signup} onClick={(e) => { e.preventDefault(); navigate(PUBLIC_PATHS.signup); }}>
            Sign up
          </a>
        </span>
      </footer>
    </div>
  );
}
