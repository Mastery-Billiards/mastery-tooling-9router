#!/bin/sh
set -eu
TASK_REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$TASK_REPO/scripts/sync-upstream.mjs"
