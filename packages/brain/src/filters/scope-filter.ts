import { ScopeCheckResult, TelegramIncomingMessage } from '../types.js';

export class ScopeFilter {
  private allowedGroupIds: Set<string>;
  private blockedUserIds: Set<string>;

  constructor(allowedGroupsConfig?: string | string[], blockedUsersConfig?: string | string[]) {
    const rawGroups = Array.isArray(allowedGroupsConfig)
      ? allowedGroupsConfig.join(',')
      : (allowedGroupsConfig || process.env.ALLOWED_GROUP_IDS || '');
    const rawBlocked = Array.isArray(blockedUsersConfig)
      ? blockedUsersConfig.join(',')
      : (blockedUsersConfig || process.env.BLOCKED_USER_IDS || '');

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

    // 2. Ignore group administrators in group chats
    if (!msg.isPrivateChat && msg.isSenderAdmin) {
      return {
        allowed: false,
        reason: 'Sender is a group administrator.',
        chatType: 'group'
      };
    }

    // 3. Explicitly Allowed Groups / Supergroups in whitelist
    if (this.allowedGroupIds.has(msg.chatId)) {
      return {
        allowed: true,
        chatType: msg.isPrivateChat ? 'private' : 'group'
      };
    }

    // 4. One-to-one Private Chats (Allowed by default unless blocked)
    if (msg.isPrivateChat) {
      return { allowed: true, chatType: 'private' };
    }

    // 5. Pure Broadcast channels (Never process unless explicitly whitelisted)
    if (msg.isChannel && !msg.isGroup) {
      return {
        allowed: false,
        reason: 'Broadcast channels are ignored by default.',
        chatType: 'channel'
      };
    }

    // 6. Unapproved Groups & Supergroups
    if (msg.isGroup || msg.isChannel) {
      return {
        allowed: false,
        reason: 'Group chat is not in ALLOWED_GROUP_IDS whitelist.',
        chatType: 'group'
      };
    }

    return { allowed: true, chatType: 'private' };
  }
}
