#!/bin/bash
# ──────────────────────────────────────────────────────────────
# Stock Pulse — Full Deployment Script
# ──────────────────────────────────────────────────────────────
# Usage: ./scripts/deploy.sh
#
# Prerequisites:
#   - AWS CLI configured with appropriate permissions
#   - Docker installed and running
#   - .env file with FINNHUB_API_KEY
# ──────────────────────────────────────────────────────────────
set -euo pipefail

export AWS_PAGER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load environment
if [ -f "${PROJECT_DIR}/.env" ]; then
    source "${PROJECT_DIR}/.env"
else
    echo "❌ .env file not found! Copy .env.example to .env and fill in values."
    exit 1
fi

# Validate required vars
if [ -z "${FINNHUB_API_KEY:-}" ]; then
    echo "❌ FINNHUB_API_KEY is not set in .env"
    exit 1
fi

AWS_REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-stock-pulse}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

INGESTION_REPO="stock-pulse-ingestion"
API_REPO="stock-pulse-api"
INGESTION_URI="${ECR_BASE}/${INGESTION_REPO}:latest"
API_URI="${ECR_BASE}/${API_REPO}:latest"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Stock Pulse — Full Deployment        ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Stack:    ${STACK_NAME}"
echo "  Region:   ${AWS_REGION}"
echo "  Account:  ${AWS_ACCOUNT_ID}"
echo ""

# ── Step 1: Create ECR repos if they don't exist ─────────
echo "📦 Step 1/6: Ensuring ECR repositories exist..."

for REPO in "${INGESTION_REPO}" "${API_REPO}"; do
    if aws ecr describe-repositories --repository-names "${REPO}" --region "${AWS_REGION}" > /dev/null 2>&1; then
        echo "  ✓ ${REPO} exists"
    else
        echo "  Creating ${REPO}..."
        aws ecr create-repository \
            --repository-name "${REPO}" \
            --region "${AWS_REGION}" \
            --image-scanning-configuration scanOnPush=true > /dev/null
        echo "  ✓ ${REPO} created"
    fi
done
echo ""

# ── Step 2: Build & Push Docker Images ────────────────────
echo "🐳 Step 2/6: Building and pushing Docker images..."
bash "${SCRIPT_DIR}/build-and-push.sh"
echo ""

# ── Step 3: Deploy CloudFormation Stack ───────────────────
echo "☁️  Step 3/6: Deploying CloudFormation stack..."

TEMPLATE_FILE="${PROJECT_DIR}/infrastructure/template.yaml"

# Check if stack exists and is in a usable state
STACK_STATUS=$(aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${AWS_REGION}" \
    --query "Stacks[0].StackStatus" \
    --output text 2>/dev/null || echo "DOES_NOT_EXIST")

# Clean up failed stacks
if [ "${STACK_STATUS}" = "ROLLBACK_COMPLETE" ] || [ "${STACK_STATUS}" = "DELETE_FAILED" ]; then
    echo "  Cleaning up failed stack..."
    aws cloudformation delete-stack --stack-name "${STACK_NAME}" --region "${AWS_REGION}"
    aws cloudformation wait stack-delete-complete --stack-name "${STACK_NAME}" --region "${AWS_REGION}"
    STACK_STATUS="DOES_NOT_EXIST"
fi

if [ "${STACK_STATUS}" = "DOES_NOT_EXIST" ]; then
    echo "  Creating new stack..."
    aws cloudformation create-stack \
        --stack-name "${STACK_NAME}" \
        --template-body "file://${TEMPLATE_FILE}" \
        --capabilities CAPABILITY_NAMED_IAM \
        --region "${AWS_REGION}" \
        --parameters \
            ParameterKey=FinnhubApiKey,ParameterValue="${FINNHUB_API_KEY}" \
            ParameterKey=IngestionImageUri,ParameterValue="${INGESTION_URI}" \
            ParameterKey=ApiImageUri,ParameterValue="${API_URI}" > /dev/null

    echo "  Waiting for stack creation (this takes 2-3 minutes)..."
    aws cloudformation wait stack-create-complete \
        --stack-name "${STACK_NAME}" \
        --region "${AWS_REGION}"
    echo "  ✅ Stack created"
else
    echo "  Updating existing stack..."
    if aws cloudformation update-stack \
        --stack-name "${STACK_NAME}" \
        --template-body "file://${TEMPLATE_FILE}" \
        --capabilities CAPABILITY_NAMED_IAM \
        --region "${AWS_REGION}" \
        --parameters \
            ParameterKey=FinnhubApiKey,ParameterValue="${FINNHUB_API_KEY}" \
            ParameterKey=IngestionImageUri,ParameterValue="${INGESTION_URI}" \
            ParameterKey=ApiImageUri,ParameterValue="${API_URI}" > /dev/null 2>&1; then
        echo "  Waiting for stack update..."
        aws cloudformation wait stack-update-complete \
            --stack-name "${STACK_NAME}" \
            --region "${AWS_REGION}"
        echo "  ✅ Stack updated"
    else
        echo "  ℹ️  No stack changes needed"
    fi
fi
echo ""

# ── Step 4: Get Stack Outputs ─────────────────────────────
echo "📋 Step 4/6: Retrieving stack outputs..."

API_URL=$(aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${AWS_REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
    --output text)

DASHBOARD_URL=$(aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${AWS_REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" \
    --output text)

BUCKET_NAME=$(aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${AWS_REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" \
    --output text)

echo "  API URL:       ${API_URL}"
echo "  Dashboard URL: ${DASHBOARD_URL}"
echo "  S3 Bucket:     ${BUCKET_NAME}"
echo ""

# ── Step 5: Inject API URL into Frontend ──────────────────
echo "🔧 Step 5/6: Configuring frontend with API URL..."

cat > "${PROJECT_DIR}/frontend/config.js" << EOF
// Auto-generated by deploy.sh — do not edit
window.STOCK_PULSE_API_URL = '${API_URL}';
EOF

# Add config.js to index.html before app.js (if not already there)
if ! grep -q "config.js" "${PROJECT_DIR}/frontend/index.html"; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' 's|<script src="app.js"></script>|<script src="config.js"></script>\
    <script src="app.js"></script>|' "${PROJECT_DIR}/frontend/index.html"
    else
        sed -i 's|<script src="app.js"></script>|<script src="config.js"></script>\n    <script src="app.js"></script>|' "${PROJECT_DIR}/frontend/index.html"
    fi
fi
echo "  ✅ Frontend configured"
echo ""

# ── Step 6: Upload Frontend to S3 ────────────────────────
echo "📤 Step 6/6: Uploading frontend to S3..."

aws s3 sync "${PROJECT_DIR}/frontend/" "s3://${BUCKET_NAME}/" \
    --region "${AWS_REGION}" \
    --delete \
    --cache-control "max-age=300" > /dev/null

echo "  ✅ Frontend uploaded"
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║           ✅  Deployment Complete!                   ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║                                                      ║"
echo "  🌐 Dashboard:  ${DASHBOARD_URL}"
echo "  🔌 API:        ${API_URL}/stocks"
echo "║                                                      ║"
echo "║  Data ingestion starts in ~5 min via EventBridge.    ║"
echo "╚══════════════════════════════════════════════════════╝"
