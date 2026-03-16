#!/usr/bin/env bash
# =============================================================================
# OpenHive dev-start — initialize runtime dirs, build image, start compose.
# Usage: ./scripts/dev-start.sh [--no-build]
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

NO_BUILD=false
if [[ "${1:-}" == "--no-build" ]]; then
  NO_BUILD=true
fi

# 1. Create runtime directories
echo "--- Creating runtime directories ---"
mkdir -p .run/workspace/.claude/agents
mkdir -p .run/workspace/.claude/skills
mkdir -p .run/workspace/memory
mkdir -p .run/workspace/teams
mkdir -p .run/workspace/integrations
mkdir -p .run/workspace/plugins/sinks
mkdir -p .run/workspace/work/tasks

# 2. Copy example configs if not present
if [[ ! -f data/openhive.yaml ]]; then
  echo "--- Copying example openhive.yaml ---"
  cp data/openhive.yaml.example data/openhive.yaml
fi

if [[ ! -f data/providers.yaml ]]; then
  echo "--- Copying example providers.yaml ---"
  cp data/providers.yaml.example data/providers.yaml
fi

# 3. Create .env if not present
if [[ ! -f .env ]]; then
  echo "--- Generating .env with random master key ---"
  MASTER_KEY=$(openssl rand -hex 32)
  cat > .env <<EOF
OPENHIVE_IS_ROOT=true
OPENHIVE_MASTER_KEY=${MASTER_KEY}
# DISCORD_BOT_TOKEN=your-token-here
EOF
  echo "Generated .env with OPENHIVE_MASTER_KEY"
fi

# 4. Build Docker image
if [[ "$NO_BUILD" == "false" ]]; then
  echo "--- Building Docker image ---"
  docker build -t openhive:latest -f deployments/Dockerfile .
fi

# 5. Start via compose
echo "--- Starting OpenHive ---"
cd deployments
docker compose up
