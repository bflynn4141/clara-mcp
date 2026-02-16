/**
 * Clara Group Manager
 *
 * Manages XMTP DM conversations and (future) bounty team groups.
 * Phase 1 scope: DMs only. Group messaging deferred.
 *
 * Adapted from Glorp's GroupManager (scope groups → bounty groups).
 */

import type { Client, Dm, Group } from '@xmtp/node-sdk';

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

  /**
   * [FUTURE] Create a group for a bounty's participants.
   * Not wired to tools in Phase 1.
   */
  async findOrCreateBountyGroup(
    bountyId: number,
    memberInboxIds: string[],
    description?: string,
  ): Promise<Group> {
    await this.client.conversations.sync();
    const groups = this.client.conversations.listGroups();
    for (const group of groups) {
      if (group.name === `clara:bounty:${bountyId}`) {
        return group;
      }
    }
    return this.client.conversations.createGroup(memberInboxIds, {
      groupName: `clara:bounty:${bountyId}`,
      groupDescription: description ?? `Bounty #${bountyId} team`,
    });
  }
}
