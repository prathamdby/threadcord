#!/bin/sh
set -eu

workspace_root="${WORKSPACE_ROOT:-/workspaces}"
mkdir -p "$workspace_root"

if [ "$(id -u)" = "0" ]; then
  # Fix mount-point ownership only; recursive chown on /workspaces scales with cloned repos.
  chown threadcord:threadcord "$workspace_root"
  exec gosu threadcord "$@"
fi

exec "$@"
