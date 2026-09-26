import { ScopeCheckResult, TelegramIncomingMessage } from '../types.js';

export class ScopeFilter {
  private allowedGroupIds: Set<string>;
  private blockedUserIds: Set<string>;
  private ignoredAdminIds: Set<string>;

  constructor(
    allowedGroupsConfig?: string | string[],
    blockedUsersConfig?: string | string[],
    ignoredAdminsConfig?: string | string[]
  ) {
    const rawGroups = Array.isArray(allowedGroupsConfig)
      ? allowedGroupsConfig.join(',')
      : (allowedGroupsConfig || process.env.ALLOWED_GROUP_IDS || '');
    const rawBlocked = Array.isArray(blockedUsersConfig)
      ? blockedUsersConfig.join(',')
      : (blockedUsersConfig || process.env.BLOCKED_USER_IDS || '');
    const rawIgnoredAdmins = Array.isArray(ignoredAdminsConfig)
      ? ignoredAdminsConfig.join(',')
      : (ignoredAdminsConfig || process.env.IGNORED_ADMIN_IDS || '');

    this.allowedGroupIds = new Set(
      rawGroups.split(',').map(s => s.trim()).filter(Boolean)
    );
    this.blockedUserIds = new Set(
      rawBlocked.split(',').map(s => s.trim()).filter(Boolean)
    );
    this.ignoredAdminIds = new Set(
      rawIgnoredAdmins.split(',').map(s => s.trim()).filter(Boolean)
    );
  }

  public updateIgnoredAdmins(adminIds: string[]): void {
    this.ignoredAdminIds = new Set(adminIds.map(s => s.trim()).filter(Boolean));
  }

  public updateBlockedUsers(userIds: string[]): void {
    this.blockedUserIds = new Set(userIds.map(s => s.trim()).filter(Boolean));
  }

  public updateAllowedGroups(groupIds: string[]): void {
    this.allowedGroupIds = new Set(groupIds.map(s => s.trim()).filter(Boolean));
  }

  public check(msg: TelegramIncomingMessage): ScopeCheckResult {
    const normalizedChatId = String(msg.chatId || '').trim();
    const normalizedAllowedGroups = new Set(
      Array.from(this.allowedGroupIds).map((value) => String(value || '').trim())
    );
    const isPrivateChat = normalizedChatId !== '' && Number(normalizedChatId) > 0;
    const isGroupChat = normalizedChatId !== '' && Number(normalizedChatId) < 0 && !msg.isChannel;
    const isChannelChat = !!msg.isChannel && !isPrivateChat && !isGroupChat;

    // 1. Blocked User Filter (Strict drop)
    if (this.blockedUserIds.has(msg.senderId)) {
      return {
        allowed: false,
        reason: 'User is explicitly on the BLOCKED_USER_IDS list.',
        chatType: isPrivateChat ? 'private' : 'group'
      };
    }

    // 2. Ignore admins in group chats (anonymous admin posts + explicitly configured admin IDs)
    if (!isPrivateChat && msg.isSenderAdmin) {
      return {
        allowed: false,
        reason: 'Sender is a group administrator.',
        chatType: 'group'
      };
    }

    // 3. Explicitly Allowed Groups / Supergroups in whitelist
    if (normalizedAllowedGroups.has(normalizedChatId)) {
      return {
        allowed: true,
        chatType: isPrivateChat ? 'private' : 'group'
      };
    }

    // 4. One-to-one Private Chats (Allowed by default unless blocked)
    if (isPrivateChat) {
      return { allowed: true, chatType: 'private' };
    }

    // 5. Pure Broadcast channels (Never process unless explicitly whitelisted)
    if (isChannelChat) {
      return {
        allowed: false,
        reason: 'Broadcast channels are ignored by default.',
        chatType: 'channel'
      };
    }

    // 6. Unapproved Groups & Supergroups
    if (isGroupChat || msg.isGroup || msg.isChannel) {
      return {
        allowed: false,
        reason: 'Group chat is not in ALLOWED_GROUP_IDS whitelist.',
        chatType: 'group'
      };
    }

    return { allowed: true, chatType: 'private' };
  }
}
