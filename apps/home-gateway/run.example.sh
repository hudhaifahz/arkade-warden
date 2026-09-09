#!/bin/sh
set -eu

: "${OWNER_CONSOLE_TOKEN:?Set an owner token of at least 32 characters}"
: "${ESCROW_DIRECTORY:?Set the absolute escrow package directory}"
export PORT="${PORT:-3270}"
exec node "$(dirname "$0")/server.mjs"
