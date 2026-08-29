FROM node:20-slim AS build
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
RUN npm run build -w @automation/dashboard

FROM nginx:1.27-alpine
COPY packages/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/dashboard/dist /usr/share/nginx/html
EXPOSE 80
