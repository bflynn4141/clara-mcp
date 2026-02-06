#!/usr/bin/env bash
set -euo pipefail

# Post-deployment smoke test for Base Sepolia
# Usage: ./scripts/smoke-test.sh <deployment-json>
#
# Reads addresses from contracts/deployments/base-sepolia.json

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS_DIR="$(dirname "$SCRIPT_DIR")"
DEPLOY_FILE="${1:-$CONTRACTS_DIR/deployments/base-sepolia.json}"
RPC_URL="${BASE_RPC_URL:-https://sepolia.base.org}"

if [[ ! -f "$DEPLOY_FILE" ]]; then
  echo "ERROR: Deployment file not found: $DEPLOY_FILE"
  echo "Create it after deployment with the deployed addresses."
  exit 1
fi

# Parse addresses (requires jq)
CLARA_TOKEN=$(jq -r '.claraToken' "$DEPLOY_FILE")
STAKING_PROXY=$(jq -r '.claraStaking' "$DEPLOY_FILE")
MERKLE_DROP=$(jq -r '.merkleDrop' "$DEPLOY_FILE")
TIMELOCK=$(jq -r '.timelockController' "$DEPLOY_FILE")

echo "=== Smoke Test: Base Sepolia ==="
echo "RPC: $RPC_URL"
echo ""

# ClaraToken checks
echo "── ClaraToken ($CLARA_TOKEN) ──"
NAME=$(cast call "$CLARA_TOKEN" "name()(string)" --rpc-url "$RPC_URL")
echo "  name(): $NAME"

SYMBOL=$(cast call "$CLARA_TOKEN" "symbol()(string)" --rpc-url "$RPC_URL")
echo "  symbol(): $SYMBOL"

SUPPLY=$(cast call "$CLARA_TOKEN" "totalSupply()(uint256)" --rpc-url "$RPC_URL")
echo "  totalSupply(): $SUPPLY"

echo ""

# ClaraStaking checks
echo "── ClaraStaking ($STAKING_PROXY) ──"
STAKING_TOKEN=$(cast call "$STAKING_PROXY" "claraToken()(address)" --rpc-url "$RPC_URL")
echo "  claraToken(): $STAKING_TOKEN"

OWNER=$(cast call "$STAKING_PROXY" "owner()(address)" --rpc-url "$RPC_URL")
echo "  owner(): $OWNER"
echo "  (should be timelock: $TIMELOCK)"

echo ""

# MerkleDrop checks
echo "── MerkleDrop ($MERKLE_DROP) ──"
ROOT=$(cast call "$MERKLE_DROP" "merkleRoot()(bytes32)" --rpc-url "$RPC_URL")
echo "  merkleRoot(): $ROOT"

DEADLINE=$(cast call "$MERKLE_DROP" "deadline()(uint256)" --rpc-url "$RPC_URL")
echo "  deadline(): $DEADLINE"

DROP_BAL=$(cast call "$CLARA_TOKEN" "balanceOf(address)(uint256)" "$MERKLE_DROP" --rpc-url "$RPC_URL")
echo "  CLARA balance: $DROP_BAL"

echo ""

# TimelockController
echo "── TimelockController ($TIMELOCK) ──"
MIN_DELAY=$(cast call "$TIMELOCK" "getMinDelay()(uint256)" --rpc-url "$RPC_URL")
echo "  minDelay(): $MIN_DELAY seconds"

echo ""
echo "=== All checks passed ==="
