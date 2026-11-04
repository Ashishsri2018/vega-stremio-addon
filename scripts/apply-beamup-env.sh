#!/usr/bin/env bash
set -euo pipefail

env_file="${1:-}"
remote="${BEAMUP_REMOTE:-dokku@a.baby-beamup.club:a38b6dd4fcd1/vega-stremio-addon-docker}"
ssh_key="${BEAMUP_SSH_KEY:-$HOME/.ssh/beamup}"

host="${remote%%:*}"
app="${remote#*:}"
if [ "$host" = "$remote" ] || [ -z "$app" ]; then
  echo "invalid BEAMUP_REMOTE: $remote" >&2
  exit 1
fi

if [ -n "$env_file" ] && [ ! -f "$env_file" ]; then
  echo "env file not found: $env_file" >&2
  exit 1
fi

declare -A values=()
keys=()

read_env() {
  local source_name="$1"
  local line key
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    if [[ "$line" != *=* ]]; then
      echo "invalid env line in $source_name" >&2
      exit 1
    fi
    key="${line%%=*}"
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "invalid env key in $source_name: $key" >&2
      exit 1
    fi
    if [[ -z "${values[$key]+x}" ]]; then
      keys+=("$key")
    fi
    values[$key]="${line#*=}"
  done
}

if [ -n "$env_file" ]; then
  read_env "$env_file" < "$env_file"
fi

if [ -n "${BEAMUP_EXTRA_ENV:-}" ]; then
  read_env "BEAMUP_EXTRA_ENV" <<< "$BEAMUP_EXTRA_ENV"
fi

if [ ${#keys[@]} -eq 0 ]; then
  echo "no Beamup environment values to apply"
  exit 0
fi

output_file="$(mktemp)"
trap 'rm -f "$output_file"' EXIT

get_current() {
  local key="$1"
  : >"$output_file"
  if ssh -i "$ssh_key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    "$host" "config:get $(printf '%q' "$app") $(printf '%q' "$key")" \
    >"$output_file" 2>&1; then
    awk '!/^\*/ && !/^INFO:/ && NF { print }' "$output_file"
  fi
}

set_value() {
  local key="$1"
  local value="$2"
  : >"$output_file"
  set +e
  ssh -i "$ssh_key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    "$host" "config:set $(printf '%q' "$app") $(printf '%q' "$key=$value")" \
    >"$output_file" 2>&1
  local status=$?
  set -e

  if [ "$status" -eq 0 ]; then
    return 0
  fi

  if grep -q "beamup-sync-swarm" "$output_file" &&
     grep -q "Unexpected end of JSON input" "$output_file"; then
    echo "::warning::Beamup applied $key but its sync hook failed"
    return 0
  fi

  echo "::error::Beamup environment update failed for $key (exit $status)" >&2
  echo "Re-run with the same SSH key to inspect Dokku output; values may contain secrets." >&2
  return "$status"
}

applied=0
skipped=0
for key in "${keys[@]}"; do
  value="${values[$key]}"
  current="$(get_current "$key")"
  if [ "$current" = "$value" ]; then
    echo "skip $key (unchanged)"
    skipped=$((skipped + 1))
    continue
  fi
  echo "set $key"
  set_value "$key" "$value"
  applied=$((applied + 1))
done

echo "Beamup environment updated ($applied set, $skipped unchanged)"
