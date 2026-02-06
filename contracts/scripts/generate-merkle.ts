/**
 * Merkle Tree Generator for MerkleDrop.sol
 *
 * Generates a Merkle root and per-recipient proofs that are compatible
 * with the on-chain leaf encoding:
 *   keccak256(abi.encodePacked(index, account, amount))
 *
 * This is a NON-STANDARD leaf format (tightly packed, not ABI-encoded),
 * so we cannot use OZ's StandardMerkleTree. Instead we build the tree
 * manually using ethers v6's solidityPackedKeccak256 and sorted pair hashing
 * to match OpenZeppelin's MerkleProof.verify().
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { solidityPackedKeccak256, keccak256, AbiCoder } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ──────────────────────────────────────────

interface Recipient {
  index: number;
  account: string;
  amount: string; // wei string
}

interface MerkleOutput {
  root: string;
  totalAmount: string;
  recipients: Array<Recipient & { proof: string[] }>;
}

// ── Leaf hashing (matches Solidity) ────────────────

function computeLeaf(index: number, account: string, amount: string): string {
  return solidityPackedKeccak256(
    ["uint256", "address", "uint256"],
    [index, account, amount]
  );
}

// ── Sorted pair hash (matches OZ MerkleProof) ──────

function hashPair(a: string, b: string): string {
  // OZ MerkleProof sorts the pair before hashing
  const [left, right] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  const coder = new AbiCoder();
  // OZ uses keccak256(abi.encodePacked(a, b)) for pair hashing
  return keccak256(coder.encode(["bytes32", "bytes32"], [left, right]).slice(0, 2 + 128));
}

// Actually OZ uses commutativeHash which is:
// keccak256(abi.encodePacked(min, max)) — tightly packed bytes32 pair
function hashPairPacked(a: string, b: string): string {
  const [left, right] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return solidityPackedKeccak256(["bytes32", "bytes32"], [left, right]);
}

// ── Build Merkle tree ──────────────────────────────

function buildMerkleTree(leaves: string[]): string[][] {
  // Pad to power of 2 with zero hashes
  let padded = [...leaves];
  while (padded.length & (padded.length - 1)) {
    padded.push(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
  }

  const layers: string[][] = [padded];

  while (layers[layers.length - 1].length > 1) {
    const current = layers[layers.length - 1];
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashPairPacked(current[i], current[i + 1]));
    }
    layers.push(next);
  }

  return layers;
}

// ── Generate proof for a leaf ──────────────────────

function getProof(layers: string[][], leafIndex: number): string[] {
  const proof: string[] = [];
  let idx = leafIndex;

  for (let i = 0; i < layers.length - 1; i++) {
    const layer = layers[i];
    // Sibling is the other element in the pair
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (siblingIdx < layer.length) {
      proof.push(layer[siblingIdx]);
    }
    // Move up to parent
    idx = Math.floor(idx / 2);
  }

  return proof;
}

// ── Main ───────────────────────────────────────────

function main() {
  const inputPath =
    process.argv[2] || resolve(__dirname, "../data/airdrop-testnet.json");
  const outputPath =
    process.argv[3] || resolve(__dirname, "../data/merkle-output-testnet.json");

  console.log(`Reading recipients from: ${inputPath}`);
  const recipients: Recipient[] = JSON.parse(
    readFileSync(inputPath, "utf-8")
  );

  // Compute leaves
  const leaves = recipients.map((r) =>
    computeLeaf(r.index, r.account, r.amount)
  );

  console.log("\nLeaves:");
  leaves.forEach((leaf, i) => {
    console.log(`  [${i}] ${leaf}`);
  });

  // Build tree
  const layers = buildMerkleTree(leaves);
  const root = layers[layers.length - 1][0];

  console.log(`\nMerkle Root: ${root}`);

  // Compute total amount
  const totalAmount = recipients
    .reduce((sum, r) => sum + BigInt(r.amount), 0n)
    .toString();

  // Generate proofs
  const output: MerkleOutput = {
    root,
    totalAmount,
    recipients: recipients.map((r, i) => ({
      ...r,
      proof: getProof(layers, i),
    })),
  };

  // Verify each proof (self-test)
  console.log("\nVerifying proofs...");
  for (const r of output.recipients) {
    let hash = computeLeaf(r.index, r.account, r.amount);
    for (const proofElement of r.proof) {
      hash = hashPairPacked(hash, proofElement);
    }
    const valid = hash === root;
    console.log(
      `  [${r.index}] ${r.account.slice(0, 10)}... → ${valid ? "VALID" : "INVALID"}`
    );
    if (!valid) {
      console.error(`  ERROR: Proof verification failed for index ${r.index}`);
      process.exit(1);
    }
  }

  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nOutput written to: ${outputPath}`);
  console.log(`Total amount: ${totalAmount} wei`);
  console.log(
    `\nSet MERKLE_ROOT=${root} in your .env before deploying.`
  );
}

main();
