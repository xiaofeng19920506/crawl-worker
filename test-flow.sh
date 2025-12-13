#!/bin/bash
# Test Flow Script - 1 Manager, 1 General Worker, 1 Product Worker, 100 tabs per batch
# Run this script to test the complete flow

echo "=== Vine Crawler Test Flow ==="
echo ""
echo "Configuration:"
echo "  - 1 Manager Worker"
echo "  - 1 General Worker (ID: 1)"
echo "  - 1 Product Worker (ID: 1)"
echo "  - 100 tabs per batch"
echo ""

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "ERROR: .env file not found!"
    echo "Please copy env.template to .env and configure it."
    exit 1
fi

# Check if Redis is running
echo "Checking Redis connection..."
if command -v redis-cli &> /dev/null; then
    if redis-cli ping &> /dev/null; then
        echo "✓ Redis connection OK"
    else
        echo "WARNING: Redis might not be running"
        echo "Make sure Redis is started: docker compose up -d redis"
    fi
else
    echo "WARNING: redis-cli not found, skipping Redis check"
fi

echo ""
echo "Starting services in separate terminals..."
echo ""

# Detect terminal emulator
if command -v gnome-terminal &> /dev/null; then
    TERMINAL="gnome-terminal"
    TERM_FLAG="--"
elif command -v xterm &> /dev/null; then
    TERMINAL="xterm"
    TERM_FLAG="-e"
elif command -v konsole &> /dev/null; then
    TERMINAL="konsole"
    TERM_FLAG="-e"
else
    echo "No supported terminal found. Please run manually:"
    echo "  Terminal 1: TABS_PER_BATCH=100 npm run start:manager-worker"
    echo "  Terminal 2: GENERAL_WORKER_ID=1 TABS_PER_BATCH=100 npm run start:general-worker"
    echo "  Terminal 3: PRODUCT_WORKER_ID=1 npm run start:product-worker"
    exit 1
fi

# Terminal 1: Manager Worker
$TERMINAL $TERM_FLAG bash -c "cd $(pwd) && echo '=== Manager Worker ===' && TABS_PER_BATCH=100 npm run start:manager-worker; exec bash" &

sleep 2

# Terminal 2: General Worker
$TERMINAL $TERM_FLAG bash -c "cd $(pwd) && echo '=== General Worker (ID: 1) ===' && GENERAL_WORKER_ID=1 TABS_PER_BATCH=100 npm run start:general-worker; exec bash" &

sleep 2

# Terminal 3: Product Worker
$TERMINAL $TERM_FLAG bash -c "cd $(pwd) && echo '=== Product Worker (ID: 1) ===' && PRODUCT_WORKER_ID=1 npm run start:product-worker; exec bash" &

echo ""
echo "✓ All terminals opened!"
echo ""
echo "Monitor the terminals to see:"
echo "  1. Manager detects general worker"
echo "  2. Manager assigns page range to general worker"
echo "  3. General worker opens 100 tabs in batch"
echo "  4. Product worker crawls products from tabs"
echo ""
echo "To stop: Close the terminal windows or press Ctrl+C in each"

