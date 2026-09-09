#!/bin/sh
set -eu

if [ -d /data ]; then
  chown -R node:node /data
fi
exec su-exec node "$@"
