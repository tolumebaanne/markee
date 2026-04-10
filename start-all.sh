#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Markee — Unified Startup Script
#
# IMPORTANT: Use start-monolith.js (the default below) so all 13 services
# share ONE Node.js process and ONE EventBus singleton.
#
# Background: shared/eventBus.js is a Node EventEmitter singleton.
# When services run as separate OS processes (via concurrently), each gets its
# own module cache and its own EventEmitter — events emitted in one service
# never reach listeners in another. start-monolith.js fixes this.
#
# Usage:
#   ./start-all.sh              ← monolith mode (recommended, events work)
#   ./start-all.sh --legacy     ← separate processes (events BROKEN — debug only)
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ "$1" = "--legacy" ]; then
    echo ""
    echo "⚠️  WARNING: --legacy mode runs services as separate OS processes."
    echo "   The EventBus singleton is NOT shared — events (order.placed,"
    echo "   payment.captured, etc.) will NOT cross service boundaries."
    echo "   Use this mode only for debugging individual services."
    echo ""
    echo "Starting ALL Markee services with concurrently..."
    echo ""

    npx concurrently \
      -n "GATE,AUTH,CAT,INV,SELL,ORD,PAY,SHIP,REV,MSG,SRCH,NOTI,ANALY,ADMIN" \
      -c "bgBlue.bold,bgMagenta.bold,bgCyan.bold,bgGreen.bold,bgYellow.bold,bgRed.bold,bgWhite.black.bold,bgBlue,bgMagenta,bgCyan,bgGreen,bgYellow,bgRed,bgWhite.bold" \
      "cd api-gateway       && node server.js" \
      "cd auth-service      && node server.js" \
      "cd catalog-service   && node app.js" \
      "cd inventory-service && node app.js" \
      "cd seller-service    && node app.js" \
      "cd order-service     && node app.js" \
      "cd payment-service   && node app.js" \
      "cd shipping-service  && node app.js" \
      "cd review-service    && node app.js" \
      "cd messaging-service && node app.js" \
      "cd search-service    && node app.js" \
      "cd notification-service && node app.js" \
      "cd analytics-service && node app.js" \
      "cd admin-service     && node app.js"
else
    echo ""
    echo "Starting Markee in monolith mode (EventBus shared — all events work)..."
    echo "  All 13 services in one Node.js process."
    echo "  Press Ctrl+C to stop."
    echo ""
    node start-monolith.js
fi
