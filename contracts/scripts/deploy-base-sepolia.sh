#!/usr/bin/env bash
set -euo pipefail

# Deploy $CLARA contracts to Base Sepolia
# Usage: ./scripts/deploy-base-sepolia.sh
#
# Prerequisites:
#   1. Copy .env.example to .env and fill in DEPLOYER_PK + BASESCAN_API_KEY
#   2. Set MERKLE_ROOT from: npx tsx scripts/generate-merkle.ts
#   3. Ensure deployer has Base Sepolia ETH (faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS_DIR="$(dirname "$SCRIPT_DIR")"

cd "$CONTRACTS_DIR"

# Load .env
if [[ ! -f .env ]]; then
  echo "ERROR: contracts/.env not found. Copy .env.example to .env and fill in values."
  exit 1
fi
source .env

# Validate required vars
for var in DEPLOYER_PK BASESCAN_API_KEY MERKLE_ROOT CLAIM_DURATION FEE_SOURCE GUARDIAN TREASURY; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is not set in .env"
    exit 1
  fi
done

echo "=== Deploying to Base Sepolia ==="
echo "RPC:       ${BASE_RPC_URL:-https://sepolia.base.org}"
echo "FEE_SOURCE: $FEE_SOURCE"
echo "GUARDIAN:   $GUARDIAN"
echo "TREASURY:   $TREASURY"
echo "MERKLE_ROOT: $MERKLE_ROOT"
echo "CLAIM_DURATION: $CLAIM_DURATION seconds"
echo ""

forge script script/Deploy.s.sol:DeployCLARA \
  --rpc-url "${BASE_RPC_URL:-https://sepolia.base.org}" \
  --private-key "$DEPLOYER_PK" \
  --broadcast \
  --verify \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  --verifier-url "https://api-sepolia.basescan.org/api" \
  -vvvv

echo ""
echo "=== Deployment Complete ==="
echo "Check broadcast/ directory for deployed addresses."
echo "Verify contracts at: https://sepolia.basescan.org"
