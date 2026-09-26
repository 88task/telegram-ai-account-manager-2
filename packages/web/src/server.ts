import { panelAuth } from './panel-auth.js';
import { PendingLogins, disposeLoginClient } from './pending-logins.js';
import { startWorker, stopWorker, sendManagedReply } from '@telegram-ai/worker';
import express, { Request, Response } from 'express';
import path from 'path';
import crypto from 'crypto';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { computeCheck } from 'telegram/Password.js';
import { Api } from 'telegram';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { db, initDb, encryptSecret, encryptionKey, defaultOperatingMode, inArray, conversations, messages, approvalQueue, contacts, knowledgeItems, auditLogs, systemSettings, telegramSessions, eq, desc, and, sql } from '@telegram-ai/db';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(panelAuth);
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 1. Overview & Health KPI metrics
app.get('/api/stats', async (req: Request, res: Response) => {
  try {
    const [activeSession] = await db.select().from(telegramSessions).where(eq(telegramSessions.isActive, true)).limit(1);
    const allConvs = await db.select().from(conversations);
    const unansweredCount = allConvs.filter(c => c.unanswered).length;
    const humanReviewCount = allConvs.filter(c => c.requiresHumanReview).length;
    
    const pendingApprovals = await db.select().from(approvalQueue).where(inArray(approvalQueue.status, ['pending', 'sending', 'delivery_unknown']));
    const blockedContacts = await db.select().from(contacts).where(eq(contacts.isBlocked, true));
    
    // Read dynamic settings
    const [modeSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'operating_mode')).limit(1);
    const [killSwitchSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'emergency_kill_switch')).limit(1);
    const [allowedGroupsSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'allowed_group_ids')).limit(1);
    const [blockedUsersSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'blocked_user_ids')).limit(1);
    const [ignoredAdminsSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'ignored_admin_ids')).limit(1);
    const [taskAvailabilitySetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'task_availability')).limit(1);

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
          operatingMode: modeSetting?.value ?? defaultOperatingMode(),
          emergencyKillSwitch: killSwitchSetting?.value === 'true',
          allowedGroupIds: (allowedGroupsSetting?.value ?? process.env.ALLOWED_GROUP_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean),
          blockedUserIds: (blockedUsersSetting?.value ?? process.env.BLOCKED_USER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean),
          ignoredAdminIds: (ignoredAdminsSetting?.value ?? process.env.IGNORED_ADMIN_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean),
          taskAvailability: (taskAvailabilitySetting?.value || 'true') === 'true'
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
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(100);
    chatMessages.reverse();

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
      .where(inArray(approvalQueue.status, ['pending', 'sending', 'delivery_unknown']))
      .orderBy(desc(approvalQueue.createdAt));

    res.json({ success: true, data: pending });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Decisions claim a pending item atomically before making an external send.
app.post('/api/approvals/:id/decide', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { action, editedReply } = req.body;
  if (!Number.isInteger(id) || !['approve', 'edit', 'reject'].includes(action) || (action === 'edit' && (typeof editedReply !== 'string' || !editedReply.trim() || editedReply.length > 4096))) {
    return res.status(400).json({ success: false, error: 'Invalid decision or reply' });
  }
  let claimed = false;
  let sent = false;
  try {
    const [item] = await db.update(approvalQueue).set({ status: action === 'reject' ? 'rejected' : 'sending', reviewedAt: new Date() })
      .where(and(eq(approvalQueue.id, id), inArray(approvalQueue.status, action === 'reject' ? ['pending', 'delivery_unknown'] : ['pending'])))
      .returning();
    if (!item) return res.status(409).json({ success: false, error: 'Item is missing or already being processed. Check delivery status before retrying.' });
    claimed = true;
    if (action !== 'reject') {
      const text = action === 'edit' ? editedReply.trim() : item.suggestedReply;
      if (!text.trim() || text.length > 4096) throw new Error('Compose a reply before approving this item');
      await sendManagedReply(item.chatId, text, item.incomingMessageId);
      sent = true;
      await db.transaction(async tx => {
        await tx.update(approvalQueue).set({ status: action === 'edit' ? 'edited' : 'approved', editedReply: action === 'edit' ? text : null }).where(eq(approvalQueue.id, id));
        const pending = await tx.select({ id: approvalQueue.id }).from(approvalQueue).where(and(eq(approvalQueue.chatId, item.chatId), inArray(approvalQueue.status, ['pending', 'sending', 'delivery_unknown']))).limit(1);
        await tx.update(conversations).set({ requiresHumanReview: pending.length > 0 }).where(eq(conversations.chatId, item.chatId));
        if (action === 'edit' && text !== item.suggestedReply) {
          const [incoming] = await tx.select().from(messages).where(and(eq(messages.chatId, item.chatId), eq(messages.telegramMessageId, item.incomingMessageId))).limit(1);
          await tx.insert(knowledgeItems).values({ category: 'approved_reply', questionOrTrigger: incoming?.text || '', content: JSON.stringify({ originalAi: item.suggestedReply, approvedVersion: text }), tags: ['human_verified', 'few_shot_exemplar'] });
        }
      });
    }
    await db.insert(auditLogs).values({ eventType: `human_${action}`, chatId: item.chatId, actionTaken: action === 'reject' ? 'Reply rejected' : 'Reply delivered', details: { approvalId: id } })
      .catch(() => console.warn('[Web] Decision completed, but audit write failed.'));
    res.json({ success: true });
  } catch (error: any) {
    if (claimed && action !== 'reject') {
      await db.update(approvalQueue).set({ status: sent || error.deliveryUnknown ? 'delivery_unknown' : 'pending' }).where(eq(approvalQueue.id, id)).catch(() => {});
    }
    res.status(502).json({ success: false, error: error.message });
  }
});

app.post('/api/conversations/:chatId/send', async (req: Request, res: Response) => {
  const { text } = req.body;
  if (!/^-?\d+$/.test(req.params.chatId) || typeof text !== 'string' || !text.trim() || text.length > 4096) {
    return res.status(400).json({ success: false, error: 'A valid chat and reply (up to 4096 characters) are required' });
  }
  let claimedIds: number[] = [];
  let delivered = false;
  try {
    // Reserve existing drafts before sending so an approval click cannot race this reply.
    claimedIds = await db.transaction(async tx => {
      const open = await tx.select().from(approvalQueue).where(and(eq(approvalQueue.chatId, req.params.chatId), inArray(approvalQueue.status, ['pending', 'sending', 'delivery_unknown']))).for('update');
      if (open.some(item => item.status !== 'pending')) throw new Error('A reply is in progress or unconfirmed. Check Telegram before sending again.');
      const ids = open.map(item => item.id);
      if (ids.length) await tx.update(approvalQueue).set({ status: 'sending' }).where(inArray(approvalQueue.id, ids));
      return ids;
    });
    const id = await sendManagedReply(req.params.chatId, text.trim());
    delivered = true;
    await db.transaction(async tx => {
      if (claimedIds.length) await tx.update(approvalQueue).set({ status: 'superseded', reviewedAt: new Date() }).where(inArray(approvalQueue.id, claimedIds));
      const open = await tx.select({ id: approvalQueue.id }).from(approvalQueue).where(and(eq(approvalQueue.chatId, req.params.chatId), inArray(approvalQueue.status, ['pending', 'sending', 'delivery_unknown']))).limit(1);
      await tx.update(conversations).set({ requiresHumanReview: open.length > 0 }).where(eq(conversations.chatId, req.params.chatId));
    });
    res.json({ success: true, messageId: id });
  } catch (error: any) {
    if (claimedIds.length) await db.update(approvalQueue).set({ status: delivered || error.deliveryUnknown ? 'delivery_unknown' : 'pending' }).where(inArray(approvalQueue.id, claimedIds)).catch(() => {});
    res.status(502).json({ success: false, error: delivered ? 'Reply delivered but queue update failed. Check Telegram before retrying.' : error.message });
  }
});

// 6. Dynamic System Settings (Mode, Kill Switch, Groups, Blocked Users)
app.post('/api/settings', async (req: Request, res: Response) => {
  try {
    const { operatingMode, emergencyKillSwitch, taskAvailability, allowedGroupIds, blockedUserIds, ignoredAdminIds } = req.body;

    const upsertSetting = async (key: string, value: string) => {
      const [existing] = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
      if (existing) {
        await db.update(systemSettings).set({ value, updatedAt: new Date() }).where(eq(systemSettings.key, key));
      } else {
        await db.insert(systemSettings).values({ key, value });
      }
    };

    if (operatingMode !== undefined && !['manual', 'draft', 'auto_pilot'].includes(operatingMode)) return res.status(400).json({ success: false, error: 'Invalid operating mode' });
    if (emergencyKillSwitch !== undefined && typeof emergencyKillSwitch !== 'boolean') return res.status(400).json({ success: false, error: 'Kill switch must be boolean' });
    if (operatingMode) await upsertSetting('operating_mode', operatingMode);
    if (emergencyKillSwitch !== undefined) await upsertSetting('emergency_kill_switch', String(emergencyKillSwitch));
    if (allowedGroupIds !== undefined) await upsertSetting('allowed_group_ids', Array.isArray(allowedGroupIds) ? allowedGroupIds.join(',') : allowedGroupIds);
    if (blockedUserIds !== undefined) await upsertSetting('blocked_user_ids', Array.isArray(blockedUserIds) ? blockedUserIds.join(',') : blockedUserIds);
    if (ignoredAdminIds !== undefined) await upsertSetting('ignored_admin_ids', Array.isArray(ignoredAdminIds) ? ignoredAdminIds.join(',') : ignoredAdminIds);
    if (taskAvailability !== undefined) await upsertSetting('task_availability', String(taskAvailability));

    await db.insert(auditLogs).values({
      eventType: 'settings_updated',
      chatId: 'system',
      actionTaken: 'Updated panel operating mode, kill switch, or whitelist/blacklist settings',
      details: { changed: Object.keys(req.body) }
    });

    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// 6b. Secure Multi-Key Gemini Settings & Test
const encryptGeminiKeys = encryptSecret;

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

    if (providerMode !== undefined && !['auto', 'gemini', 'bedrock'].includes(providerMode)) return res.status(400).json({ success: false, error: 'Invalid provider mode' });
    if (model !== undefined && (typeof model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(model))) return res.status(400).json({ success: false, error: 'Invalid model' });
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent`;
    const testRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': testKey },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Respond with OK' }] }]
      })
    });

    if (!testRes.ok) {
      return res.status(testRes.status).json({ success: false, error: `Gemini API error (${testRes.status})` });
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
const pendingLogins = new PendingLogins();

let sessionEpoch = 0;
let sessionChanges: Promise<unknown> = Promise.resolve();
function changeSession<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionChanges.then(operation);
  sessionChanges = result.catch(() => {});
  return result;
}

async function saveActiveSession(phone: string, sessionString: string, epoch: number, userId: string) {
  const encrypted = encryptSecret(sessionString);
  return changeSession(async () => {
    if (epoch !== sessionEpoch) throw new Error('Login cancelled by disconnect');
    const [existingBinding] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'managed_account_id'));
    if (existingBinding && existingBinding.value !== userId) throw new Error('This database belongs to a different Telegram account');
    await stopWorker();
    await db.transaction(async tx => {
      await tx.insert(systemSettings).values({ key: 'managed_account_id', value: userId }).onConflictDoNothing({ target: systemSettings.key });
      const [binding] = await tx.select().from(systemSettings).where(eq(systemSettings.key, 'managed_account_id'));
      if (binding.value !== userId) throw new Error('This database belongs to a different Telegram account');
      await tx.update(telegramSessions).set({ isActive: false, updatedAt: new Date() }).where(eq(telegramSessions.isActive, true));
      await tx.insert(telegramSessions).values({ userId: phone, phone, encryptedSessionString: encrypted, isActive: true })
        .onConflictDoUpdate({ target: telegramSessions.userId, set: { phone, encryptedSessionString: encrypted, isActive: true, updatedAt: new Date() } });
    });
    if (epoch !== sessionEpoch) throw new Error('Login cancelled by disconnect');
    await startWorker(sessionString);
  });
}

// Send login code to a Telegram phone number
app.post('/api/auth/send-code', async (req: Request, res: Response) => {
  const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
  if (!phone) return res.status(400).json({ success: false, error: 'phone is required' });
  const epoch = sessionEpoch;
  const release = pendingLogins.acquire(phone);
  if (!release) return res.status(409).json({ success: false, error: 'A login request is already in progress for this phone.' });
  let client: TelegramClient | undefined;
  try {
    encryptionKey();
    const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    if (!apiId || !apiHash) {
      return res.status(500).json({ success: false, error: 'TELEGRAM_API_ID / TELEGRAM_API_HASH are not configured on the web task' });
    }
    // Drop any previous pending login for this phone
    await pendingLogins.cleanup(phone);

    client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
    await client.connect();
    const result = await client.sendCode({ apiId, apiHash }, phone);
    if (epoch !== sessionEpoch) throw new Error('Login cancelled by disconnect');
    pendingLogins.set(phone, { client, phone, phoneCodeHash: (result as any).phoneCodeHash, createdAt: Date.now() });
    client = undefined; // Ownership transferred to the pending login store.
    res.json({ success: true, message: 'Login code sent to your Telegram app' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.errorMessage || error.message });
  } finally {
    if (client) await disposeLoginClient(client);
    release();
  }
});

// Verify the login code; responds requiresPassword:true when 2FA is enabled
app.post('/api/auth/verify-code', async (req: Request, res: Response) => {
  const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!phone) return res.status(400).json({ success: false, error: 'phone is required' });
  const epoch = sessionEpoch;
  const release = pendingLogins.acquire(phone);
  if (!release) return res.status(409).json({ success: false, error: 'A login request is already in progress for this phone.' });
  try {
    const pending = await pendingLogins.get(phone);
    if (!pending) return res.status(400).json({ success: false, error: 'No login in progress for this phone. Request a new code.' });
    await pending.client.invoke(new Api.auth.SignIn({
      phoneNumber: phone,
      phoneCodeHash: pending.phoneCodeHash,
      phoneCode: code,
    }));
    const sessionString = (pending.client.session as StringSession).save() as unknown as string;
    await saveActiveSession(phone, sessionString, epoch, (await pending.client.getMe()).id.toString());
    await pendingLogins.cleanup(phone);

    res.json({ success: true, requiresPassword: false, message: 'Telegram connected' });
  } catch (error: any) {
    if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      return res.json({ success: true, requiresPassword: true });
    }
    res.status(400).json({ success: false, error: error.errorMessage || error.message });
  } finally {
    release();
  }
});

// Submit the 2FA cloud password (only needed when verify-code asked for it)
app.post('/api/auth/submit-password', async (req: Request, res: Response) => {
  const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
  const password = req.body?.password || '';
  if (!phone) return res.status(400).json({ success: false, error: 'phone is required' });
  const epoch = sessionEpoch;
  const release = pendingLogins.acquire(phone);
  if (!release) return res.status(409).json({ success: false, error: 'A login request is already in progress for this phone.' });
  try {
    const pending = await pendingLogins.get(phone);
    if (!pending) return res.status(400).json({ success: false, error: 'No login in progress for this phone. Request a new code.' });
    const pwdInfo = await pending.client.invoke(new Api.account.GetPassword());
    const srp = await computeCheck(pwdInfo, password);
    await pending.client.invoke(new Api.auth.CheckPassword({ password: srp }));
    const sessionString = (pending.client.session as StringSession).save() as unknown as string;
    await saveActiveSession(phone, sessionString, epoch, (await pending.client.getMe()).id.toString());
    await pendingLogins.cleanup(phone);

    res.json({ success: true, message: 'Telegram connected with 2FA' });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.errorMessage || error.message });
  } finally {
    release();
  }
});

// 9. Session Disconnect / Logout

app.post('/api/auth/disconnect', async (req: Request, res: Response) => {
  sessionEpoch++;
  try {
    await changeSession(async () => {
      await stopWorker();
      await db.update(telegramSessions).set({ isActive: false, updatedAt: new Date() }).where(eq(telegramSessions.isActive, true));
    });
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
      setInterval(() => {
        void pendingLogins.cleanupExpired().catch(() => console.warn('[Web] Login cleanup failed.'));
      }, 60_000).unref();
      // Boot co-located worker inside web process
      startWorker().catch((err) => console.error('[Web] Error booting worker:', err));
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database tables:', err);
    process.exit(1);
  });
