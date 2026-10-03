#!/usr/bin/env bash
# Starts the live server + the mock storefront for local development.
set -e
export STORE_URL=${STORE_URL:-http://localhost:3001}
export PUBLIC_URL=${PUBLIC_URL:-http://localhost:8080}
export ADMIN_EMAIL=${ADMIN_EMAIL:-admin@finafransar.test}
export ADMIN_PASSWORD=${ADMIN_PASSWORD:-utveckling-losen-123}
node --disable-warning=ExperimentalWarning src/server.js &
APP=$!
node --disable-warning=ExperimentalWarning dev/storefront-mock.js &
STORE=$!
trap "kill $APP $STORE" EXIT
echo "Studio:  $PUBLIC_URL/admin  ($ADMIN_EMAIL / $ADMIN_PASSWORD)"
echo "Tittare: $STORE_URL/live"
wait
