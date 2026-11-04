#!/bin/sh
set -eu

if [ -f /app/deploy/beamup.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /app/deploy/beamup.env
  set +a
fi

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  exec gosu node "$@"
fi

exec "$@"
