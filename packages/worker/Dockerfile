# Playwright's own image ships Chromium + all OS deps prebaked, pinned to
# the same version as the "playwright" npm dependency below — keep both in
# sync (packages/worker/package.json) or the browser binaries won't match.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json

RUN npm install --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
CMD ["npm", "run", "start", "-w", "@automation/worker"]
