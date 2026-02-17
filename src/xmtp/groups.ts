/**
 * Clara Group Manager
 *
 * Manages XMTP DM conversations.
 * Phase 1 scope: DMs only. Group messaging deferred.
 */

import type { Client, Dm } from '@xmtp/node-sdk';

export class ClaraGroupManager {
  constructor(private client: Client) {}

  /**
   * Find or create a DM conversation with another user.
   * This is the primary messaging pattern for Clara.
   */
  async findOrCreateDm(peerInboxId: string): Promise<Dm> {
    await this.client.conversations.sync();
    const dms = this.client.conversations.listDms();
    for (const dm of dms) {
      if (dm.peerInboxId === peerInboxId) {
        return dm;
      }
    }
    return this.client.conversations.createDm(peerInboxId);
  }
}
