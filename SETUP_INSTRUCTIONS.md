# Browser Automation Platform - Setup Instructions

## Prerequisites

### 1. Install Docker Desktop for Mac

Run this in your terminal:

```bash
# Install Docker via Homebrew (if not already installed)
brew install --cask docker

# Verify installation
docker --version

# Launch Docker Desktop
open -a Docker

# Wait for Docker to start (check by running):
docker ps
```

### 2. Configure the Project

```bash
cd /Users/abhinay/Documents/Abhi\ project/Nexa-Consu/Browser-automation-platform

# Create .env file with your settings
cp .env.example .env

# Edit .env and set:
# - POSTGRES_PASSWORD to a strong value (required!)
# - TZ to your timezone (e.g., America/New_York, Asia/Kolkata)
```

### 3. Start All Services

```bash
# Build and spin up all containers
docker compose up -d --build

# Verify containers are running
docker compose ps

# Check logs
docker compose logs -f api
```

### 4. Access the Dashboard

- **Dashboard**: http://localhost:8080
- **API**: http://localhost:4000
- **PostgreSQL**: localhost:5432 (not exposed in production)
- **Redis**: localhost:6379 (not exposed in production)

### 5. Health Checks

```bash
curl http://localhost:4000/health
docker compose ps
docker compose logs api | grep scheduler
```

## Development Mode (Without Docker for App Code)

```bash
# Start PostgreSQL and Redis only
docker compose up -d postgres redis

# Install dependencies
npm install

# Start worker in background
npm run dev:worker &

# Start API in background
npm run dev:api &

# Terminal 3 - Dashboard
npm run dev:dashboard
```

## Common Issues

### "Docker Desktop not running"

1. Open Application folder, click Docker icon
2. Check Activity Monitor for `docker-compose` process
3. Restart: `brew services stop docker; brew services start docker`

### Credential Errors

Delete these if they exist and recreate:
```bash
rm -rf ~/.config/docker*
rm -f ~/.docker-credential*
rm -rf /Users/*/Library/GroupContainers/com.docker.plist
```

Then restart Docker Desktop.

## Docker Compose Services

1. **postgres** - PostgreSQL database
2. **redis** - Redis (job queue + pub/sub)
3. **api** - Fastify REST API server
4. **worker** - Playwright runner workers (scale with `--scale worker=3`)
5. **dashboard** - React frontend

## Memory Requirements

- Base: ~2GB
- Per user session: 300-700MB
- Minimum recommended: 6GB RAM
- Scale workers for more throughput
