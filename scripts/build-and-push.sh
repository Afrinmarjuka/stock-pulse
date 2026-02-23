#!/bin/bash
# ──────────────────────────────────────────────────────────────
# Stock Pulse — Build & Push Docker Images to ECR
# ──────────────────────────────────────────────────────────────
set -euo pipefail

export AWS_PAGER=""

# Load config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

source "${PROJECT_DIR}/.env" 2>/dev/null || true

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "╔══════════════════════════════════════════╗"
echo "║   Stock Pulse — Build & Push Images      ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  AWS Account:  ${AWS_ACCOUNT_ID}"
echo "  Region:       ${AWS_REGION}"
echo "  ECR Base:     ${ECR_BASE}"
echo ""

# ── Step 1: Authenticate Docker with ECR ──────────────────
echo "🔐 Authenticating Docker with ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
    | docker login --username AWS --password-stdin "${ECR_BASE}"
echo ""

# ── Step 2: Build & Push Ingestion Lambda ─────────────────
INGESTION_REPO="stock-pulse-ingestion"
INGESTION_URI="${ECR_BASE}/${INGESTION_REPO}:latest"

echo "🔨 Building ingestion Lambda..."
docker build --platform linux/amd64 --provenance=false -t "${INGESTION_REPO}:latest" "${PROJECT_DIR}/lambdas/ingestion/"

echo "🏷️  Tagging: ${INGESTION_URI}"
docker tag "${INGESTION_REPO}:latest" "${INGESTION_URI}"

echo "📤 Pushing ingestion image..."
docker push "${INGESTION_URI}"
echo "✅ Ingestion image pushed"
echo ""

# ── Step 3: Build & Push API Lambda ───────────────────────
API_REPO="stock-pulse-api"
API_URI="${ECR_BASE}/${API_REPO}:latest"

echo "🔨 Building API Lambda..."
docker build --platform linux/amd64 --provenance=false -t "${API_REPO}:latest" "${PROJECT_DIR}/lambdas/api/"

echo "🏷️  Tagging: ${API_URI}"
docker tag "${API_REPO}:latest" "${API_URI}"

echo "📤 Pushing API image..."
docker push "${API_URI}"
echo "✅ API image pushed"
echo ""

echo "════════════════════════════════════════════"
echo "  ✅ All images built and pushed!"
echo ""
echo "  Ingestion: ${INGESTION_URI}"
echo "  API:       ${API_URI}"
echo "════════════════════════════════════════════"
