import { useState } from "react";

/**
 * A password field with a reveal toggle.
 *
 * Starts hidden, always — revealing is a deliberate act, and a field that
 * remembered "shown" across visits would eventually show a password to
 * whoever is standing behind you. The eye is a plain two-path outline
 * rather than an emoji or a filled glyph: at 16px an emoji renders
 * differently on every platform, and this has to sit flush inside a text
 * field on all of them.
 */
export function PasswordInput({
  id,
  value,
  onChange,
  required,
  autoFocus,
  autoComplete,
  placeholder,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  placeholder?: string;
}) {
  const [shown, setShown] = useState(false);

  return (
    <div className="password-field">
      <input
        id={id}
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        placeholder={placeholder}
      />
      <button
        type="button"
        className="password-reveal"
        // tabIndex -1: tabbing from the password box should reach the submit
        // button, not a decoration in between.
        tabIndex={-1}
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        title={shown ? "Hide password" : "Show password"}
      >
        <EyeIcon off={shown} />
      </button>
    </div>
  );
}

/** Open eye when hidden ("click to show"), struck through when shown
 * ("click to hide") — the icon shows what the click will do. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.7" />
      {off && <path d="M4 20 20 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />}
    </svg>
  );
}
