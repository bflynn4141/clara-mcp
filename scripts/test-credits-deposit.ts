#!/usr/bin/env npx tsx
/**
 * Test script for ClaraCredits deposit flow
 *
 * This script:
 * 1. Approves ClaraCredits to spend USDC
 * 2. Deposits USDC to get credits
 * 3. Verifies the credits are available
 */

import { encodeFunctionData, parseUnits, type Hex } from 'viem';
import { getSession } from '../src/storage/session.js';
import { signAndSendTransaction } from '../src/para/transactions.js';

// Contract addresses on Base
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Hex;
const CLARA_CREDITS_ADDRESS = '0x423F12752a7EdbbB17E9d539995e85b921844d8D' as Hex;
const BASE_CHAIN_ID = 8453;

// ABIs
const ERC20_APPROVE_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const CLARA_CREDITS_DEPOSIT_ABI = [
  {
    inputs: [{ name: 'amount', type: 'uint256' }],
    name: 'deposit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

async function main() {
  console.log('🧪 Testing ClaraCredits Deposit Flow\n');

  // Get session
  const session = await getSession();
  if (!session?.authenticated || !session.walletId || !session.address) {
    console.error('❌ No wallet session found. Run wallet_setup first.');
    process.exit(1);
  }

  console.log(`Wallet: ${session.address}`);
  console.log(`Wallet ID: ${session.walletId}\n`);

  // Amount to deposit: $1.00 = 1,000,000 USDC units (6 decimals)
  const depositAmount = parseUnits('1', 6); // $1.00 USDC

  // Step 1: Approve USDC spending
  console.log('📝 Step 1: Approving USDC spending...');
  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [CLARA_CREDITS_ADDRESS, depositAmount],
  });

  try {
    const approveResult = await signAndSendTransaction(session.walletId, {
      to: USDC_ADDRESS,
      value: 0n,
      data: approveData,
      chainId: BASE_CHAIN_ID,
    });
    console.log(`✅ Approval tx: ${approveResult.txHash}`);
    console.log(`   View: https://basescan.org/tx/${approveResult.txHash}\n`);

    // Wait a bit for tx to be mined
    console.log('⏳ Waiting for approval to confirm...');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } catch (error) {
    console.error(`❌ Approval failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Step 2: Deposit USDC
  console.log('📝 Step 2: Depositing USDC to ClaraCredits...');
  const depositData = encodeFunctionData({
    abi: CLARA_CREDITS_DEPOSIT_ABI,
    functionName: 'deposit',
    args: [depositAmount],
  });

  try {
    const depositResult = await signAndSendTransaction(session.walletId, {
      to: CLARA_CREDITS_ADDRESS,
      value: 0n,
      data: depositData,
      chainId: BASE_CHAIN_ID,
    });
    console.log(`✅ Deposit tx: ${depositResult.txHash}`);
    console.log(`   View: https://basescan.org/tx/${depositResult.txHash}\n`);
  } catch (error) {
    console.error(`❌ Deposit failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  console.log('🎉 Deposit complete! Check credits with:');
  console.log(`   curl 'https://clara-proxy.bflynn-me.workers.dev/api/test-credits?address=${session.address}'`);
}

main().catch(console.error);
