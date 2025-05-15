#! /bin/sh

set -xe

CURRENT_DIRECTORY="${0%/*}"

export PATH="${CURRENT_DIRECTORY}/development:$PATH"

export VOLODYSLAV_LOG_LEVEL=debug
export VOLODYSLAV_LOG_FILE=/tmp/volodyslav.log
export VOLODYSLAV_SERVER_PORT=3000

termux-notification \
  --title "Volodyslav" \
  --content "Starting development server..." \
  --priority high

npx nodemon backend/src/index.js start
