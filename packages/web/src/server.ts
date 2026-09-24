import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { db, initDb, conversations, messages, approvalQueue, contacts, knowledgeItems, auditLogs, systemSettings, telegramSessions, eq, desc, and, sql } from '@telegram-ai/db';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Overview & Health KPI metrics
app.get('/api/stats', async (req: Request, res: Response) => {
  try {
    const [activeSession] = await db.select().from(telegramSessions).where(eq(telegramSessions.isActive, true)).limit(1);
    const allConvs = await db.select().from(conversations);
    const unansweredCount = allConvs.filter(c => c.unanswered).length;
    const humanReviewCount = allConvs.filter(c => c.requiresHumanReview).length;
    
    const pendingApprovals = await db.select().from(approvalQueue).where(eq(approvalQueue.status, 'pending'));
    const blockedContacts = await db.select().from(contacts).where(eq(contacts.isBlocked, true));
    
    // Read dynamic settings
    const [modeSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'operating_mode')).limit(1);
    const [killSwitchSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'emergency_kill_switch')).limit(1);
    const [allowedGroupsSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'allowed_group_ids')).limit(1);
    const [blockedUsersSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'blocked_user_ids')).limit(1);

    res.json({
      success: true,
      data: {
        session: {
          connected: !!activeSession,
          phone: activeSession?.phone || null,
          lastSync: activeSession?.updatedAt || null
        },
        counts: {
          totalConversations: allConvs.length,
          unansweredConversations: unansweredCount,
          requiresHumanReview: humanReviewCount,
          pendingApprovals: pendingApprovals.length,
          blockedContacts: blockedContacts.length
        },
        settings: {
          operatingMode: modeSetting?.value || process.env.DEFAULT_OPERATING_MODE || 'auto_pilot',
          emergencyKillSwitch: killSwitchSetting?.value === 'true',
          allowedGroupIds: (allowedGroupsSetting?.value || process.env.ALLOWED_GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
          blockedUserIds: (blockedUsersSetting?.value || process.env.BLOCKED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
        }
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Conversations List & Filter
app.get('/api/conversations', async (req: Request, res: Response) => {
  try {
    const { filter } = req.query; // 'unanswered', 'review', 'group', 'private', 'all'
    let query = db.select().from(conversations).orderBy(desc(conversations.lastMessageAt));
    const all = await query;

    let filtered = all;
    if (filter === 'unanswered') {
      filtered = all.filter(c => c.unanswered);
    } else if (filter === 'review') {
      filtered = all.filter(c => c.requiresHumanReview);
    } else if (filter === 'group') {
      filtered = all.filter(c => c.chatType === 'group');
    } else if (filter === 'private') {
      filtered = all.filter(c => c.chatType === 'private');
    }

    res.json({ success: true, data: filtered });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Conversation Thread Messages
app.get('/api/conversations/:chatId/messages', async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const chatMessages = await db.select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(messages.createdAt)
      .limit(100);

    const [contact] = await db.select().from(contacts).where(eq(contacts.telegramUserId, chatId)).limit(1);

    res.json({ success: true, data: { messages: chatMessages, contact } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Approval Queue (Human In The Loop)
app.get('/api/approvals', async (req: Request, res: Response) => {
  try {
    const pending = await db.select()
      .from(approvalQueue)
      .where(eq(approvalQueue.status, 'pending'))
      .orderBy(desc(approvalQueue.createdAt));

    res.json({ success: true, data: pending });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Approve, Edit, or Reject an AI Draft
app.post('/api/approvals/:id/decide', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { action, editedReply } = req.body; // 'approve', 'edit', 'reject'

    const [item] = await db.select().from(approvalQueue).where(eq(approvalQueue.id, id)).limit(1);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Approval item not found' });
    }

    if (action === 'approve') {
      await db.update(approvalQueue).set({
        status: 'approved',
        reviewedAt: new Date()
      }).where(eq(approvalQueue.id, id));

      await db.insert(auditLogs).values({
        eventType: 'human_approved',
        chatId: item.chatId,
        actionTaken: 'Approved suggested reply for dispatch',
        details: { reply: item.suggestedReply, confidence: item.aiConfidence }
      });
    } else if (action === 'edit') {
      await db.update(approvalQueue).set({
        status: 'edited',
        editedReply: editedReply || item.suggestedReply,
        reviewedAt: new Date()
      }).where(eq(approvalQueue.id, id));

      // Save edited reply into feedback exemplar memory!
      if (editedReply && editedReply !== item.suggestedReply) {
        await db.insert(knowledgeItems).values({
          category: 'approved_reply',
          questionOrTrigger: `User input requiring edit for chat ${item.chatId}`,
          content: `AI Suggested: ${item.suggestedReply} | Human Corrected: ${editedReply}`,
          tags: ['feedback_exemplar', 'human_edited']
        });
      }

      await db.insert(auditLogs).values({
        eventType: 'human_edited',
        chatId: item.chatId,
        actionTaken: 'Edited suggested reply for dispatch and saved feedback exemplar',
        details: { original: item.suggestedReply, edited: editedReply }
      });
    } else if (action === 'reject') {
      await db.update(approvalQueue).set({
        status: 'rejected',
        reviewedAt: new Date()
      }).where(eq(approvalQueue.id, id));

      await db.insert(auditLogs).values({
        eventType: 'human_rejected',
        chatId: item.chatId,
        actionTaken: 'Rejected AI suggested reply',
        details: { suggested: item.suggestedReply }
      });
    }

    res.json({ success: true, message: `Approval ${id} resolved as ${action}` });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Dynamic System Settings (Mode, Kill Switch, Groups, Blocked Users)
app.post('/api/settings', async (req: Request, res: Response) => {
  try {
    const { operatingMode, emergencyKillSwitch, allowedGroupIds, blockedUserIds } = req.body;

    const upsertSetting = async (key: string, value: string) => {
      const [existing] = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
      if (existing) {
        await db.update(systemSettings).set({ value, updatedAt: new Date() }).where(eq(systemSettings.key, key));
      } else {
        await db.insert(systemSettings).values({ key, value });
      }
    };

    if (operatingMode) await upsertSetting('operating_mode', operatingMode);
    if (emergencyKillSwitch !== undefined) await upsertSetting('emergency_kill_switch', String(emergencyKillSwitch));
    if (allowedGroupIds !== undefined) await upsertSetting('allowed_group_ids', Array.isArray(allowedGroupIds) ? allowedGroupIds.join(',') : allowedGroupIds);
    if (blockedUserIds !== undefined) await upsertSetting('blocked_user_ids', Array.isArray(blockedUserIds) ? blockedUserIds.join(',') : blockedUserIds);

    await db.insert(auditLogs).values({
      eventType: 'settings_updated',
      chatId: 'system',
      actionTaken: 'Updated panel operating mode, kill switch, or whitelist/blacklist settings',
      details: req.body
    });

    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. LUMO Knowledge & Safety Tips Management
app.get('/api/knowledge', async (req: Request, res: Response) => {
  try {
    const items = await db.select().from(knowledgeItems).orderBy(desc(knowledgeItems.createdAt));
    res.json({ success: true, data: items });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/knowledge', async (req: Request, res: Response) => {
  try {
    const { category, questionOrTrigger, content, tags } = req.body;
    await db.insert(knowledgeItems).values({
      category: category || 'rule',
      questionOrTrigger,
      content,
      tags: tags || []
    });
    res.json({ success: true, message: 'Knowledge item added' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. Audit Logs Stream
app.get('/api/audit-logs', async (req: Request, res: Response) => {
  try {
    const logs = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(100);
    res.json({ success: true, data: logs });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9. Session Disconnect / Logout
app.post('/api/auth/disconnect', async (req: Request, res: Response) => {
  try {
    await db.update(telegramSessions).set({ isActive: false, updatedAt: new Date() }).where(eq(telegramSessions.isActive, true));
    await db.insert(auditLogs).values({
      eventType: 'session_disconnected',
      chatId: 'system',
      actionTaken: 'Emergency disconnect triggered from Management Panel',
      details: {}
    });
    res.json({ success: true, message: 'Telegram session deactivated' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Initialize database schema tables before opening server
initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`Telegram AI Management Panel listening at http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database tables:', err);
    app.listen(port, () => {
      console.log(`Telegram AI Management Panel listening at http://localhost:${port} (db init failed)`);
    });
  });
