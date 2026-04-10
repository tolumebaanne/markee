#!/bin/bash

echo "Starting Markee Platforms... (Press Ctrl+C to stop all)"

npx concurrently --kill-others -n "GATE,AUTH,CAT" -c "bgBlue.bold,bgMagenta.bold,bgCyan.bold" \
  "cd api-gateway && node server.js" \
  "cd auth-service && node server.js" \
  "cd catalog-service && node app.js"
