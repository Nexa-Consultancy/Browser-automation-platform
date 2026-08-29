// Redis pub/sub channel names. Kept in one place so the API (publisher)
// and worker (subscriber/publisher) never drift out of sync on naming —
// this is also the seam a future second worker node scales through: any
// number of workers can subscribe to the same channels.

export const controlChannel = (sessionId: string) => `control:session:${sessionId}`;
export const eventsChannel = (jobId: string) => `events:job:${jobId}`;
export const screencastChannel = (sessionId: string) => `screencast:session:${sessionId}`;

// CDP only pushes a screencast frame on repaint — a session sitting on a
// static page may never send another one after its first few. Without
// caching the latest frame, a dashboard tab that (re)subscribes after that
// point sees "waiting for stream…" forever even though the session is
// perfectly healthy. The worker refreshes this key on every frame; the API
// reads it once up front when a client subscribes.
export const screencastLastFrameKey = (sessionId: string) => `screencast:last:${sessionId}`;
