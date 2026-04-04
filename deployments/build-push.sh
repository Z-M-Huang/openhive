#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE="zhironghuang/openhive"

VERSION=$(node -p "require('$REPO_ROOT/package.json').version")

if [ -z "$VERSION" ]; then
  echo "ERROR: Could not read version from package.json" >&2
  exit 1
fi

echo "Building $IMAGE:$VERSION ..."

docker build \
  --build-arg VERSION="$VERSION" \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:latest" \
  -f "$SCRIPT_DIR/Dockerfile" \
  "$REPO_ROOT"

echo ""
echo "Built:"
echo "  $IMAGE:$VERSION"
echo "  $IMAGE:latest"
echo ""

if [ "${1:-}" = "--push" ]; then
  echo "Pushing to Docker Hub ..."
  docker push "$IMAGE:$VERSION"
  docker push "$IMAGE:latest"
  echo "Done."
else
  echo "Run with --push to push to Docker Hub."
fi
