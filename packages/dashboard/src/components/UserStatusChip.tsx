/**
 * A user's connection state, in the one place it is decided.
 *
 * There are only two states worth showing and they are opposites, so they
 * get opposite signal colors: green ONLINE means the saved Teams session is
 * on disk and the next run joins as them; red OFFLINE means it isn't, and
 * the next run would land on a login page. Offline is a real problem to fix
 * — the sign-in never finished, or the file holding the session is missing
 * or empty — so it reads as an alarm rather than as a neutral "no".
 *
 * The server decides which it is (see userLoginExists in
 * packages/api/src/services/users.ts); this only draws it.
 */
export function UserStatusChip({
  signedIn,
  name,
  subject,
  showLabel = true,
}: {
  signedIn: boolean;
  /** Rendered inside the chip when given — a name and its status read as
   * one thing rather than as two adjacent pills. */
  name?: string;
  /** Who the tooltip is about, when the name is already shown alongside and
   * repeating it inside the chip would just be noise. */
  subject?: string;
  showLabel?: boolean;
}) {
  const who = name ?? subject ?? "This user";
  return (
    <span
      className={`user-status ${signedIn ? "online" : "offline"}`}
      title={
        signedIn
          ? `${who} is signed in — their saved Teams session is on disk, so the next run joins as them.`
          : `${who} is not signed in. The saved session is missing or empty, so the next run would land on a login page. Use "Re-sign in" to capture it again.`
      }
    >
      <span className="dot" />
      {name}
      {showLabel && <span className="user-status-label">{signedIn ? "online" : "offline"}</span>}
    </span>
  );
}
