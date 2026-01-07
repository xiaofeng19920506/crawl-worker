#!/bin/bash

# 启动所有服务
echo "🚀 启动所有服务..."
echo ""

cd "$(dirname "$0")"

# 使用 concurrently 同时启动所有服务
npx concurrently -n manager,general,product,api -c blue,green,magenta,yellow \
  "npm run start:manager-worker" \
  "npm run start:general-worker" \
  "npm run start:product-worker" \
  "npm run start:api"

