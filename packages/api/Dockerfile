# Build context is the repo root (see docker-compose.yml) because this
# service depends on the local @automation/shared, @automation/db and
# @automation/queue workspace packages.
FROM node:20-slim
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
EXPOSE 4000
CMD ["npm", "run", "start", "-w", "@automation/api"]
