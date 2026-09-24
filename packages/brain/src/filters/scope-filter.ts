import { ScopeCheckResult, TelegramIncomingMessage } from '../types.js';

export class ScopeFilter {
  private allowedGroupIds: Set<string>;
  private blockedUserIds: Set<string>;

  constructor(allowedGroupsConfig?: string, blockedUsersConfig?: string) {
    const rawGroups = allowedGroupsConfig || process.env.ALLOWED_GROUP_IDS || '';
    const rawBlocked = blockedUsersConfig || process.env.BLOCKED_USER_IDS || '';

    this.allowedGroupIds = new Set(
      rawGroups.split(',').map(s => s.trim()).filter(Boolean)
    );
    this.blockedUserIds = new Set(
      rawBlocked.split(',').map(s => s.trim()).filter(Boolean)
    );
  }

  public updateBlockedUsers(userIds: string[]): void {
    this.blockedUserIds = new Set(userIds.map(s => s.trim()).filter(Boolean));
  }

  public updateAllowedGroups(groupIds: string[]): void {
    this.allowedGroupIds = new Set(groupIds.map(s => s.trim()).filter(Boolean));
  }

  public check(msg: TelegramIncomingMessage): ScopeCheckResult {
    // 1. Blocked User Filter (Strict drop)
    if (this.blockedUserIds.has(msg.senderId)) {
      return {
        allowed: false,
        reason: 'User is explicitly on the BLOCKED_USER_IDS list.',
        chatType: msg.isPrivateChat ? 'private' : 'group'
      };
    }

    // 2. Channels & Broadcasts (Never process)
    if (msg.isChannel) {
      return {
        allowed: false,
        reason: 'Broadcast channels are ignored by default.',
        chatType: 'channel'
      };
    }

    // 3. Groups (Ignored unless explicitly whitelisted)
    if (msg.isGroup) {
      if (!this.allowedGroupIds.has(msg.chatId)) {
        return {
          allowed: false,
          reason: 'Group chat is not in ALLOWED_GROUP_IDS whitelist.',
          chatType: 'group'
        };
      }
      return { allowed: true, chatType: 'group' };
    }

    // 4. Allowed Private 1-to-1 chats
    return { allowed: true, chatType: 'private' };
  }
}
