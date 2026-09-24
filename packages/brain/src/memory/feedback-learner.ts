import { db, knowledgeItems, auditLogs } from '@telegram-ai/db';
import { eq } from 'drizzle-orm';

export interface HumanCorrectionRecord {
  chatId: string;
  incomingMessage: string;
  aiSuggestedReply: string;
  humanEditedReply: string;
  editorUserId: string;
  reasonNotes?: string;
}

export class FeedbackLearner {
  /**
   * Records human corrections to AI drafts.
   * Ingests the before-and-after pair as a high-priority exemplar for future generations.
   */
  public async ingestCorrection(record: HumanCorrectionRecord): Promise<void> {
    console.log(`[FeedbackLearner] Ingesting correction for chat ${record.chatId}`);

    // 1. Save as high-priority exemplar in PostgreSQL knowledge_items
    try {
      await db.insert(knowledgeItems).values({
        category: 'approved_reply',
        questionOrTrigger: record.incomingMessage,
        content: JSON.stringify({
          originalAi: record.aiSuggestedReply,
          approvedVersion: record.humanEditedReply,
          notes: record.reasonNotes || 'Human editor refinement'
        }),
        tags: ['human_verified', 'few_shot_exemplar']
      });

      // 2. Record audit log
      await db.insert(auditLogs).values({
        eventType: 'human_feedback_ingested',
        chatId: record.chatId,
        actionTaken: 'learned_new_exemplar',
        details: {
          original: record.aiSuggestedReply,
          edited: record.humanEditedReply,
          editor: record.editorUserId
        }
      });

      console.log('[FeedbackLearner] Successfully persisted human correction to knowledge memory.');
    } catch (err) {
      console.error('[FeedbackLearner] Failed to persist correction:', err);
    }
  }

  /**
   * Retrieves dynamically learned few-shot examples for a given topic or query.
   */
  public async getDynamicExemplars(limit: number = 5): Promise<Array<{ userMessage: string; approvedReply: string }>> {
    try {
      const records = await db.select().from(knowledgeItems)
        .where(eq(knowledgeItems.category, 'approved_reply'))
        .limit(limit);

      return records.map(r => {
        try {
          const parsed = JSON.parse(r.content);
          return {
            userMessage: r.questionOrTrigger || '',
            approvedReply: parsed.approvedVersion || r.content
          };
        } catch {
          return {
            userMessage: r.questionOrTrigger || '',
            approvedReply: r.content
          };
        }
      });
    } catch {
      return [];
    }
  }
}
