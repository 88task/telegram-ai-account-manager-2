import { startWorker, stopWorker } from '@telegram-ai/worker';
import express, { Request, Response } from 'express';
import path from 'path';
import crypto from 'crypto';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { computeCheck } from 'telegram/Password.js';
import { Api } from 'telegram';
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
    const [ignoredAdminsSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'ignored_admin_ids')).limit(1);

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
          blockedUserIds: (blockedUsersSetting?.value || process.env.BLOCKED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
          ignoredAdminIds: (ignoredAdminsSetting?.value || process.env.IGNORED_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
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
    const { operatingMode, emergencyKillSwitch, allowedGroupIds, blockedUserIds, ignoredAdminIds } = req.body;

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
    if (ignoredAdminIds !== undefined) await upsertSetting('ignored_admin_ids', Array.isArray(ignoredAdminIds) ? ignoredAdminIds.join(',') : ignoredAdminIds);

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


// 6b. Secure Multi-Key Gemini Settings & Test
function encryptGeminiKeys(plainJson: string): string {
  const keyHex = (process.env.SESSION_ENCRYPTION_KEY || '').trim();
  if (!keyHex) throw new Error('SESSION_ENCRYPTION_KEY is required to encrypt keys');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(plainJson, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptGeminiKeys(stored: string): any[] {
  if (!stored) return [];
  if (!stored.startsWith('enc:')) {
    try { return JSON.parse(stored); } catch { return []; }
  }
  const [, ivHex, tagHex, dataHex] = stored.split(':');
  const keyHex = (process.env.SESSION_ENCRYPTION_KEY || '').trim();
  if (!keyHex) return [];
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  try { return JSON.parse(dec); } catch { return []; }
}

app.get('/api/gemini/settings', async (req: Request, res: Response) => {
  try {
    const rows = await db.select().from(systemSettings);
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.key, r.value);

    const providerMode = map.get('ai_provider_mode') || 'auto';
    const model = map.get('gemini_model') || 'gemini-2.5-flash';
    const rawKeys = decryptGeminiKeys(map.get('gemini_keys_encrypted') || '');

    const maskedKeys = rawKeys.map((k, idx) => ({
      id: k.id || `key_${idx}`,
      label: k.label || `Key ${idx + 1}`,
      maskedKey: k.key ? `${k.key.slice(0, 6)}...${k.key.slice(-4)}` : 'Invalid',
      createdAt: k.createdAt || new Date().toISOString(),
    }));

    res.json({ success: true, data: { providerMode, model, keys: maskedKeys } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/gemini/settings', async (req: Request, res: Response) => {
  try {
    const { providerMode, model } = req.body;
    const upsertSetting = async (key: string, value: string) => {
      const [existing] = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
      if (existing) {
        await db.update(systemSettings).set({ value, updatedAt: new Date() }).where(eq(systemSettings.key, key));
      } else {
        await db.insert(systemSettings).values({ key, value });
      }
    };

    if (providerMode) await upsertSetting('ai_provider_mode', providerMode);
    if (model) await upsertSetting('gemini_model', model);

    res.json({ success: true, message: 'Gemini settings updated' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/gemini/keys', async (req: Request, res: Response) => {
  try {
    const { key, label } = req.body;
    if (!key || !key.trim()) {
      return res.status(400).json({ success: false, error: 'API key is required' });
    }

    const [existing] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'gemini_keys_encrypted')).limit(1);
    const keysList = existing ? decryptGeminiKeys(existing.value) : [];

    const newKeyObj = {
      id: `gem_${Date.now()}`,
      key: key.trim(),
      label: label?.trim() || `Key ${keysList.length + 1}`,
      createdAt: new Date().toISOString()
    };
    keysList.push(newKeyObj);

    const enc = encryptGeminiKeys(JSON.stringify(keysList));
    if (existing) {
      await db.update(systemSettings).set({ value: enc, updatedAt: new Date() }).where(eq(systemSettings.key, 'gemini_keys_encrypted'));
    } else {
      await db.insert(systemSettings).values({ key: 'gemini_keys_encrypted', value: enc });
    }

    res.json({ success: true, message: 'Gemini API key securely added to pool' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/gemini/keys/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [existing] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'gemini_keys_encrypted')).limit(1);
    if (!existing) return res.json({ success: true });

    let keysList = decryptGeminiKeys(existing.value);
    keysList = keysList.filter((k: any) => k.id !== id);

    const enc = encryptGeminiKeys(JSON.stringify(keysList));
    await db.update(systemSettings).set({ value: enc, updatedAt: new Date() }).where(eq(systemSettings.key, 'gemini_keys_encrypted'));
    res.json({ success: true, message: 'Gemini API key removed from pool' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/gemini/test', async (req: Request, res: Response) => {
  try {
    const { key, model } = req.body;
    const testKey = key;
    if (!testKey) return res.status(400).json({ success: false, error: 'Key is required' });

    const targetModel = model || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${testKey}`;
    const testRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Respond with OK' }] }]
      })
    });

    if (!testRes.ok) {
      const errText = await testRes.text();
      return res.status(testRes.status).json({ success: false, error: `Gemini API error (${testRes.status}): ${errText}` });
    }

    const data: any = await testRes.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'OK';
    res.json({ success: true, message: 'Key verified successfully!', reply });
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

app.delete('/api/knowledge/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid knowledge ID' });
    await db.delete(knowledgeItems).where(eq(knowledgeItems.id, id));
    res.json({ success: true, message: 'Knowledge item deleted' });
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


// ---------- In-panel Telegram MTProto login ----------
const pendingLogins = new Map<string, { client: TelegramClient; phone: string; phoneCodeHash: string }>();

function getEncryptionKey(): Buffer | null {
  const keyHex = (process.env.SESSION_ENCRYPTION_KEY || '').trim();
  if (!keyHex) return null;
  return Buffer.from(keyHex, 'hex');
}

function encryptSessionString(plain: string): string {
  const key = getEncryptionKey();
  if (!key) return plain; // stored unencrypted when SESSION_ENCRYPTION_KEY is not set
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['enc', iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

async function saveActiveSession(phone: string, sessionString: string) {
  const encrypted = encryptSessionString(sessionString);
  await stopWorker();
    await db.update(telegramSessions).set({ isActive: false, updatedAt: new Date() }).where(eq(telegramSessions.isActive, true));
  await db.insert(telegramSessions).values({
    userId: phone, phone, encryptedSessionString: encrypted, isActive: true,
  }).onConflictDoUpdate({
    target: telegramSessions.userId,
    set: { phone, encryptedSessionString: encrypted, isActive: true, updatedAt: new Date() },
  });
}

// Send login code to a Telegram phone number
app.post('/api/auth/send-code', async (req: Request, res: Response) => {
  const phone = (req.body?.phone || '').trim();
  try {
    if (!phone) return res.status(400).json({ success: false, error: 'phone is required' });
    const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    if (!apiId || !apiHash) {
      return res.status(500).json({ success: false, error: 'TELEGRAM_API_ID / TELEGRAM_API_HASH are not configured on the web task' });
    }
    // Drop any previous pending login for this phone
    const previous = pendingLogins.get(phone);
    if (previous) { try { await previous.client.disconnect(); } catch {} pendingLogins.delete(phone); }

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
    await client.connect();
    const result = await client.sendCode({ apiId, apiHash }, phone);
    pendingLogins.set(phone, { client, phone, phoneCodeHash: (result as any).phoneCodeHash });
    res.json({ success: true, message: 'Login code sent to your Telegram app' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.errorMessage || error.message });
  }
});

// Verify the login code; responds requiresPassword:true when 2FA is enabled
app.post('/api/auth/verify-code', async (req: Request, res: Response) => {
  const phone = (req.body?.phone || '').trim();
  const code = (req.body?.code || '').trim();
  const pending = pendingLogins.get(phone);
  try {
    if (!pending) return res.status(400).json({ success: false, error: 'No login in progress for this phone. Request a new code.' });
    await pending.client.invoke(new Api.auth.SignIn({
      phoneNumber: phone,
      phoneCodeHash: pending.phoneCodeHash,
      phoneCode: code,
    }));
    const sessionString = (pending.client.session as StringSession).save() as unknown as string;
    await saveActiveSession(phone, sessionString);
    try {
      await pending.client.disconnect();
      await pending.client.destroy();
    } catch {}
    pendingLogins.delete(phone);
    setTimeout(() => {
      startWorker(sessionString).catch((err) => console.error('[Web] Failed to start co-located worker:', err));
    }, 1500);
    res.json({ success: true, requiresPassword: false, message: 'Telegram connected' });
  } catch (error: any) {
    if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      return res.json({ success: true, requiresPassword: true });
    }
    res.status(400).json({ success: false, error: error.errorMessage || error.message });
  }
});

// Submit the 2FA cloud password (only needed when verify-code asked for it)
app.post('/api/auth/submit-password', async (req: Request, res: Response) => {
  const phone = (req.body?.phone || '').trim();
  const password = req.body?.password || '';
  const pending = pendingLogins.get(phone);
  try {
    if (!pending) return res.status(400).json({ success: false, error: 'No login in progress for this phone. Request a new code.' });
    const pwdInfo = await pending.client.invoke(new Api.account.GetPassword());
    const srp = await computeCheck(pwdInfo, password);
    await pending.client.invoke(new Api.auth.CheckPassword({ password: srp }));
    const sessionString = (pending.client.session as StringSession).save() as unknown as string;
    await saveActiveSession(phone, sessionString);
    try {
      await pending.client.disconnect();
      await pending.client.destroy();
    } catch {}
    pendingLogins.delete(phone);
    setTimeout(() => {
      startWorker(sessionString).catch((err) => console.error('[Web] Failed to start co-located worker:', err));
    }, 1500);
    res.json({ success: true, message: 'Telegram connected with 2FA' });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.errorMessage || error.message });
  }
});

// 9. Session Disconnect / Logout

app.post('/api/auth/disconnect', async (req: Request, res: Response) => {
  try {
    await stopWorker();
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
      // Boot co-located worker inside web process
      startWorker().catch((err) => console.error('[Web] Error booting worker:', err));
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database tables:', err);
    app.listen(port, () => {
      console.log(`Telegram AI Management Panel listening at http://localhost:${port} (db init failed)`);
    });
  });
