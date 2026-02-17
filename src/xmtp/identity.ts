/**
 * Clara Identity Cache
 *
 * Maps between claraid.eth names, EVM addresses, and XMTP inbox IDs.
 * Seeded from the Clara proxy's ENS directory, cached in memory.
 *
 * Adapted from Glorp's IdentityCache (GitHub usernames → claraid.eth names).
 */

export interface ClaraIdentityEntry {
  /** claraid.eth subname (e.g., "brian") */
  claraName: string | null;
  /** EVM wallet address */
  walletAddress: string;
  /** XMTP inbox ID (set after XMTP identity registration) */
  inboxId?: string;
}

export class ClaraIdentityCache {
  private byName = new Map<string, ClaraIdentityEntry>();
  private byWallet = new Map<string, ClaraIdentityEntry>();
  private byInboxId = new Map<string, ClaraIdentityEntry>();

  /**
   * Seed the cache from Clara's ENS directory.
   * Calls GET /ens/list on the proxy, which returns all registered
   * claraid.eth names with their wallet addresses.
   */
  async seedFromDirectory(proxyUrl: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${proxyUrl}/ens/list`, { signal: controller.signal });
      if (!response.ok) return;

      const data = await response.json() as { names: Array<{ name: string; address: string }> };
      for (const entry of data.names || []) {
        this.add({
          claraName: entry.name,
          walletAddress: entry.address,
        });
      }
    } catch {
      // Non-fatal — cache starts empty, gets populated as we encounter users
    } finally {
      clearTimeout(timeout);
    }
  }

  add(entry: ClaraIdentityEntry): void {
    const normalized = {
      ...entry,
      claraName: entry.claraName?.toLowerCase() ?? null,
      walletAddress: entry.walletAddress.toLowerCase(),
    };

    if (normalized.claraName) {
      this.byName.set(normalized.claraName, normalized);
    }
    this.byWallet.set(normalized.walletAddress, normalized);
    if (normalized.inboxId) {
      this.byInboxId.set(normalized.inboxId, normalized);
    }
  }

  setInboxId(walletAddress: string, inboxId: string): void {
    const entry = this.byWallet.get(walletAddress.toLowerCase());
    if (entry) {
      entry.inboxId = inboxId;
      this.byInboxId.set(inboxId, entry);
    }
  }

  /**
   * Resolve a claraid.eth name to an identity entry.
   * Strips common suffixes: "brian.claraid.eth" -> "brian"
   */
  resolveName(name: string): ClaraIdentityEntry | undefined {
    const key = name.toLowerCase().replace(/\.claraid\.eth$/, '').replace(/^@/, '');
    return this.byName.get(key);
  }

  resolveWallet(address: string): ClaraIdentityEntry | undefined {
    return this.byWallet.get(address.toLowerCase());
  }

  resolveInboxId(inboxId: string): ClaraIdentityEntry | undefined {
    return this.byInboxId.get(inboxId);
  }

  /**
   * Get display name for a sender's inbox ID.
   * Falls back to truncated inboxId if unknown.
   */
  getSenderName(inboxId: string): string {
    const entry = this.byInboxId.get(inboxId);
    if (entry?.claraName) return entry.claraName;
    return inboxId.length > 12
      ? `${inboxId.slice(0, 6)}...${inboxId.slice(-4)}`
      : inboxId;
  }

  all(): ClaraIdentityEntry[] {
    return Array.from(this.byWallet.values());
  }

  get size(): number {
    return this.byWallet.size;
  }

  clear(): void {
    this.byName.clear();
    this.byWallet.clear();
    this.byInboxId.clear();
  }
}
