#!/bin/sh
set -eu

workspace_root="${WORKSPACE_ROOT:-/workspaces}"
mkdir -p "$workspace_root"

if [ "$(id -u)" = "0" ]; then
  chown -R threadcord:threadcord "$workspace_root"
  exec gosu threadcord "$@"
fi

exec "$@"
