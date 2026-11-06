#!/bin/sh
set -eu

# VEGA_ENV_FILE can point at another env file (or an empty value) to opt out of
# the committed deploy defaults, e.g. for local runs and CI smoke tests.
env_file="${VEGA_ENV_FILE-/app/deploy/beamup.env}"
if [ -n "$env_file" ] && [ -f "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

provider_source="${PROVIDER_SOURCE:-Zenda-Cross/vega-providers}"
provider_owner="${provider_source%%/*}"
[ -n "$provider_owner" ] || provider_owner="Zenda-Cross"
baseline_dir="/app/providers-baseline/$provider_owner"
target_dir="$DATA_DIR/providers/$provider_owner"
if [ -d "$baseline_dir" ] && [ ! -f "$target_dir/state.json" ]; then
  mkdir -p "$target_dir"
  cp -a "$baseline_dir/." "$target_dir/"
fi

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  exec gosu node "$@"
fi

exec "$@"
