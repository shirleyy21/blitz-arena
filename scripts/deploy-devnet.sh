#!/usr/bin/env bash
set -euo pipefail

echo "=== Blitz Arena: Build & Deploy to Solana Devnet ==="
solana config set --url https://api.devnet.solana.com
echo "Deployer: $(solana address)"
echo "Balance:  $(solana balance)"

anchor build --ignore-keys
anchor deploy --provider.cluster devnet

PROGRAM_ID=$(solana address -k target/deploy/blitz_arena-keypair.json)
echo ""
echo "✅ Deployed blitz_arena to Devnet!"
echo "   Program ID: $PROGRAM_ID"
echo "   Explorer:   https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
echo ""
echo "Next: set VITE_BLITZ_PROGRAM_ID=$PROGRAM_ID in app/.env and deploy app/ to Vercel."
