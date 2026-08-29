// Redis pub/sub channel names. Kept in one place so the API (publisher)
// and worker (subscriber/publisher) never drift out of sync on naming —
// this is also the seam a future second worker node scales through: any
// number of workers can subscribe to the same channels.

export const controlChannel = (sessionId: string) => `control:session:${sessionId}`;
export const eventsChannel = (jobId: string) => `events:job:${jobId}`;
export const screencastChannel = (sessionId: string) => `screencast:session:${sessionId}`;
