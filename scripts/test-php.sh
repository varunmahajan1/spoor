#!/usr/bin/env bash
# Runs the WordPress adapter's tests in a container, so contributing to the PHP
# side needs no PHP toolchain.
#
# The sources are staged into a temp directory rather than bind-mounting the
# repo, because Docker Desktop only shares a configured set of host paths and a
# checkout outside them mounts as empty — which presents as "Could not open
# input file" rather than as a mount error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${SPOOR_PHP_IMAGE:-php:8.3-cli-alpine}"

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — the WordPress tests need it (no PHP required on the host)" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/wordpress/test" "$STAGE/wordpress/spoor-data"
cp "$ROOT/wordpress/spoor.php"            "$STAGE/wordpress/"
cp "$ROOT/wordpress/spoor-data/"*.json    "$STAGE/wordpress/spoor-data/"
cp "$ROOT/wordpress/test/run.php"         "$STAGE/wordpress/test/"
cp "$ROOT/wordpress/test/golden.json"     "$STAGE/wordpress/test/"

echo "php adapter — $IMAGE"
docker run --rm -v "$STAGE:/w" -w /w "$IMAGE" php -l wordpress/spoor.php
docker run --rm -v "$STAGE:/w" -w /w "$IMAGE" php wordpress/test/run.php
