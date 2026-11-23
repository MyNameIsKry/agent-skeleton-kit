import type { Message } from "../../domain/conversation.js";
import type { Clock, ConversationRepository } from "../../domain/ports.js";
import type { TenantContext } from "../../domain/tenant.js";
import { conversationsOf, type MongoStore } from "./collections.js";

/** Older messages are dropped beyond this many, so one session cannot grow without bound. */
export const MAX_STORED_MESSAGES = 200;

/** Conversations are keyed by `{ tenantId, sessionId }` (tenant-isolation rule 8). */
export class MongoConversationRepository implements ConversationRepository {
  constructor(
    private readonly store: MongoStore,
    private readonly clock: Clock,
  ) {}

  async append(ctx: TenantContext, sessionId: string, messages: readonly Message[]): Promise<void> {
    if (messages.length === 0) return;
    await conversationsOf(this.store).updateOne(
      { tenantId: ctx.tenantId, sessionId },
      {
        $push: { messages: { $each: [...messages], $slice: -MAX_STORED_MESSAGES } },
        $set: { updatedAt: this.clock.now() },
      },
      { upsert: true },
    );
  }

  async recent(ctx: TenantContext, sessionId: string, limit: number): Promise<Message[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    const doc = await conversationsOf(this.store).findOne(
      { tenantId: ctx.tenantId, sessionId },
      { projection: { messages: { $slice: -limit } } },
    );
    return doc?.messages ?? [];
  }
}
