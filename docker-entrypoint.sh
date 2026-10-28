#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  exec gosu node "$@"
fi

exec "$@"
