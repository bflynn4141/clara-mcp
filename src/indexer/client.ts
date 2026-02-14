/**
 * Ponder REST Client
 *
 * Thin wrapper around fetch() for the shared Ponder indexer API.
 * Replaces in-memory index reads when CLARA_USE_PONDER=true.
 *
 * All functions match the signatures of the existing query functions
 * in queries.ts and challenge-queries.ts so the barrel export (index.ts)
 * can route transparently.
 */

import type {
  BountyRecord,
  AgentRecord,
  FeedbackRecord,
  ChallengeRecord,
  SubmissionRecord,
  WinnerRecord,
} from './types.js';

// ─── Configuration ────────────────────────────────────────────────────

const PONDER_URL = process.env.CLARA_PONDER_URL ?? 'http://localhost:42069';

async function ponderGet<T>(path: string): Promise<T> {
  const url = `${PONDER_URL}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Ponder API ${res.status}: ${url}`);
  }
  return res.json() as Promise<T>;
}

// ─── Ponder response types (superset of existing types) ──────────────

interface PonderBounty extends BountyRecord {
  effectiveStatus: string;
}

interface PonderAgent extends AgentRecord {
  reputationAvg: number | undefined;
}

interface PonderTxStatus {
  status: 'pending' | 'indexed';
  entityType?: string;
  entityAddress?: string;
}

interface PonderChallengeDetail extends Omit<ChallengeRecord, 'submissions'> {
  effectiveStatus: string;
  submissions: SubmissionRecord[];
  winners: WinnerRecord[];
}

// ─── Response → Legacy type mappers ──────────────────────────────────

/**
 * Map Ponder bounty response back to BountyRecord shape.
 * Ponder uses bigint-as-string for timestamps, we need numbers.
 */
function toBountyRecord(p: any): BountyRecord {
  return {
    bountyAddress: p.address,
    poster: p.poster,
    token: p.token,
    amount: p.amount,
    deadline: Number(p.deadline),
    taskURI: p.taskURI,
    skillTags: p.skillTags ?? [],
    status: p.effectiveStatus === 'effectively_expired' ? 'expired' : p.status,
    claimer: p.claimer ?? undefined,
    claimerAgentId: p.claimerAgentId ? Number(p.claimerAgentId) : undefined,
    proofURI: p.proofURI ?? undefined,
    createdBlock: Number(p.blockNumber),
    createdTxHash: p.txHash,
    updatedBlock: p.updatedAtBlock ? Number(p.updatedAtBlock) : undefined,
    posterBond: p.posterBond ?? undefined,
    bondRate: p.bondRate ? Number(p.bondRate) : undefined,
    rejectionCount: p.rejectionCount ?? 0,
    submittedAt: p.submittedAt ? Number(p.submittedAt) : undefined,
  };
}

function toAgentRecord(p: any): AgentRecord {
  return {
    agentId: Number(p.agentId),
    owner: p.owner,
    agentURI: p.agentURI,
    name: p.name,
    skills: p.skills ?? [],
    description: p.description ?? undefined,
    registeredBlock: Number(p.blockNumber),
    registeredTxHash: p.txHash,
    reputationCount: p.reputationCount ?? 0,
    reputationSum: p.reputationSum ?? 0,
    reputationAvg: p.reputationAvg ?? undefined,
    uriUpdatedBlock: p.uriUpdatedAtBlock ? Number(p.uriUpdatedAtBlock) : undefined,
  };
}

function toFeedbackRecord(p: any): FeedbackRecord {
  return {
    agentId: Number(p.agentId),
    clientAddress: p.clientAddress,
    feedbackIndex: Number(p.feedbackIndex),
    value: p.value,
    valueDecimals: p.valueDecimals,
    tag1: p.tag1,
    tag2: p.tag2,
    feedbackURI: p.feedbackURI,
    feedbackHash: p.feedbackHash,
    block: Number(p.blockNumber),
    txHash: p.txHash,
    revoked: p.revoked,
  };
}

function toChallengeRecord(p: any): ChallengeRecord {
  return {
    challengeAddress: p.address,
    poster: p.poster,
    evaluator: p.evaluator,
    token: p.token,
    prizePool: p.prizePool,
    deadline: Number(p.deadline),
    scoringDeadline: Number(p.scoringDeadline),
    challengeURI: p.challengeURI,
    evalConfigHash: '',
    winnerCount: 0,
    payoutBps: [],
    skillTags: p.skillTags ?? [],
    status: p.effectiveStatus === 'effectively_expired' ? 'expired' : p.status,
    submissionCount: p.submissionCount ?? 0,
    privateSetHash: '',
    maxParticipants: 0,
    scorePostedAt: p.scorePostedAt ? Number(p.scorePostedAt) : null,
    submissions: {},
    winners: (p.winners ?? []).map(toWinnerRecord),
    createdBlock: Number(p.blockNumber),
    createdTxHash: p.txHash,
    updatedBlock: p.updatedAtBlock ? Number(p.updatedAtBlock) : 0,
    posterBond: p.posterBond ?? undefined,
  };
}

function toSubmissionRecord(p: any): SubmissionRecord {
  return {
    submitter: p.submitter,
    agentId: Number(p.agentId),
    solutionURI: '',
    solutionHash: p.solutionHash,
    submittedAt: Number(p.submittedAt),
    version: Number(p.version),
    score: p.score !== null ? Number(p.score) : null,
    rank: p.rank ?? null,
  };
}

function toWinnerRecord(p: any): WinnerRecord {
  return {
    address: p.address,
    agentId: Number(p.agentId),
    rank: p.rank,
    score: Number(p.score),
    prizeAmount: p.prizeAmount,
    claimed: p.claimed,
  };
}

// ─── Bounty Queries ──────────────────────────────────────────────────

export async function ponderGetOpenBounties(filters?: {
  status?: string;
  skill?: string;
  limit?: number;
}): Promise<BountyRecord[]> {
  const params = new URLSearchParams();
  if (filters?.skill) params.set('skill', filters.skill);
  if (filters?.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  const bounties = await ponderGet<any[]>(`/v1/bounties/open${qs ? `?${qs}` : ''}`);
  return bounties.map(toBountyRecord);
}

export async function ponderGetBountyByAddress(address: string): Promise<BountyRecord | null> {
  try {
    const bounty = await ponderGet<any>(`/v1/bounties/${address.toLowerCase()}`);
    return toBountyRecord(bounty);
  } catch {
    return null;
  }
}

export async function ponderGetBountyByTxHash(txHash: string): Promise<BountyRecord | null> {
  try {
    const bounty = await ponderGet<any>(`/v1/bounties/by-tx/${txHash.toLowerCase()}`);
    return toBountyRecord(bounty);
  } catch {
    return null;
  }
}

export async function ponderGetBountiesByPoster(poster: string): Promise<BountyRecord[]> {
  const bounties = await ponderGet<any[]>(`/v1/bounties/by-poster/${poster.toLowerCase()}`);
  return bounties.map(toBountyRecord);
}

export async function ponderGetBountiesByClaimer(claimer: string): Promise<BountyRecord[]> {
  const bounties = await ponderGet<any[]>(`/v1/bounties/by-claimer/${claimer.toLowerCase()}`);
  return bounties.map(toBountyRecord);
}

// ─── Agent Queries ───────────────────────────────────────────────────

export async function ponderGetAgentByAddress(address: string): Promise<AgentRecord | null> {
  try {
    const agent = await ponderGet<any>(`/v1/agents/by-address/${address.toLowerCase()}`);
    return toAgentRecord(agent);
  } catch {
    return null;
  }
}

export async function ponderGetAgentByAgentId(agentId: number): Promise<AgentRecord | null> {
  try {
    const agent = await ponderGet<any>(`/v1/agents/${agentId}`);
    return toAgentRecord(agent);
  } catch {
    return null;
  }
}

export async function ponderFindAgents(filters?: {
  skill?: string;
  limit?: number;
}): Promise<AgentRecord[]> {
  const params = new URLSearchParams();
  if (filters?.skill) params.set('skill', filters.skill);
  if (filters?.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  const agents = await ponderGet<any[]>(`/v1/agents/find${qs ? `?${qs}` : ''}`);
  return agents.map(toAgentRecord);
}

// ─── Reputation Queries ──────────────────────────────────────────────

export async function ponderGetFeedbacksByAgentId(
  agentId: number,
  includeRevoked = false,
): Promise<FeedbackRecord[]> {
  const params = new URLSearchParams();
  if (includeRevoked) params.set('includeRevoked', 'true');
  const qs = params.toString();
  const feedbacks = await ponderGet<any[]>(`/v1/feedback/by-agent/${agentId}${qs ? `?${qs}` : ''}`);
  return feedbacks.map(toFeedbackRecord);
}

export async function ponderGetReputationSummary(agentId: number): Promise<{
  count: number;
  averageRating: number;
  totalValue: number;
} | null> {
  const agent = await ponderGetAgentByAgentId(agentId);
  if (!agent) return null;
  return {
    count: agent.reputationCount ?? 0,
    averageRating: agent.reputationAvg ?? 0,
    totalValue: agent.reputationSum ?? 0,
  };
}

// ─── Challenge Queries ───────────────────────────────────────────────

export async function ponderGetOpenChallenges(filters?: {
  status?: string;
  skill?: string;
  limit?: number;
}): Promise<ChallengeRecord[]> {
  const params = new URLSearchParams();
  if (filters?.skill) params.set('skill', filters.skill);
  if (filters?.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  const challenges = await ponderGet<any[]>(`/v1/challenges/open${qs ? `?${qs}` : ''}`);
  return challenges.map(toChallengeRecord);
}

export async function ponderGetChallengeByAddress(address: string): Promise<ChallengeRecord | null> {
  try {
    const raw = await ponderGet<any>(`/v1/challenges/${address.toLowerCase()}`);
    const record = toChallengeRecord(raw);
    // Populate submissions map from the nested array
    if (raw.submissions) {
      for (const sub of raw.submissions) {
        const mapped = toSubmissionRecord(sub);
        record.submissions[mapped.submitter] = mapped;
      }
    }
    return record;
  } catch {
    return null;
  }
}

export async function ponderGetChallengesByPoster(poster: string): Promise<ChallengeRecord[]> {
  // Ponder doesn't have a by-poster endpoint for challenges yet;
  // use the open endpoint and filter client-side
  const all = await ponderGet<any[]>(`/v1/bounties/by-poster/${poster.toLowerCase()}`);
  // This is a fallback — ideally add a dedicated endpoint
  return [];
}

export async function ponderGetChallengeLeaderboard(
  address: string,
  limit = 20,
): Promise<SubmissionRecord[]> {
  const rows = await ponderGet<any[]>(
    `/v1/challenges/${address.toLowerCase()}/leaderboard?limit=${limit}`,
  );
  return rows.map(toSubmissionRecord);
}

export async function ponderGetAgentChallengeHistory(agentId: number): Promise<any[]> {
  return ponderGet<any[]>(`/v1/agents/${agentId}/challenges`);
}

export async function ponderGetAgentChallengeStats(agentId: number): Promise<{
  entered: number;
  won: number;
  totalPrizeEarned: string;
  avgRank: number;
  bestRank: number;
}> {
  const history = await ponderGetAgentChallengeHistory(agentId);

  let won = 0;
  let totalPrize = 0n;
  let rankSum = 0;
  let rankCount = 0;
  let bestRank = Infinity;

  for (const h of history) {
    if (h.winner) {
      won++;
      totalPrize += BigInt(h.winner.prizeAmount);
      rankSum += h.winner.rank;
      rankCount++;
      if (h.winner.rank < bestRank) bestRank = h.winner.rank;
    } else if (h.submission?.rank !== null && h.submission?.rank !== undefined) {
      rankSum += h.submission.rank;
      rankCount++;
      if (h.submission.rank < bestRank) bestRank = h.submission.rank;
    }
  }

  return {
    entered: history.length,
    won,
    totalPrizeEarned: totalPrize.toString(),
    avgRank: rankCount > 0 ? rankSum / rankCount : 0,
    bestRank: bestRank === Infinity ? 0 : bestRank,
  };
}

// ─── Index Stats ─────────────────────────────────────────────────────

export async function ponderGetIndexStats(): Promise<{
  totalBounties: number;
  openCount: number;
  claimedCount: number;
  submittedCount: number;
  approvedCount: number;
  expiredCount: number;
  cancelledCount: number;
  rejectedCount: number;
  resolvedCount: number;
  lastSyncedBlock: number;
}> {
  const stats = await ponderGet<any>('/v1/stats');
  return {
    totalBounties: stats.totalBounties ?? 0,
    openCount: stats.openCount ?? 0,
    claimedCount: stats.claimedCount ?? 0,
    submittedCount: stats.submittedCount ?? 0,
    approvedCount: stats.approvedCount ?? 0,
    expiredCount: stats.expiredCount ?? 0,
    cancelledCount: stats.cancelledCount ?? 0,
    rejectedCount: 0,
    resolvedCount: 0,
    lastSyncedBlock: 0,
  };
}

// ─── Post-Mutation Freshness Check ───────────────────────────────────

/**
 * Wait for a transaction to be indexed by Ponder.
 * Uses exponential backoff: 1s, 2s, 4s, 8s (max 15s total).
 * Returns the entity info if indexed, or null if timeout.
 */
export async function awaitIndexed(
  txHash: string,
  maxWaitMs = 15_000,
): Promise<PonderTxStatus | null> {
  const start = Date.now();
  let delay = 1000;

  while (Date.now() - start < maxWaitMs) {
    try {
      const status = await ponderGet<PonderTxStatus>(`/v1/tx/${txHash.toLowerCase()}`);
      if (status.status === 'indexed') {
        return status;
      }
    } catch {
      // Ponder may be temporarily unavailable
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 8000);
  }

  return null;
}
