import type { ToolHandler } from "@agent-skeleton/core";

const handler: ToolHandler<{ id: string }> = async (args, ctx) => {
  return { ok: true, tenant: ctx.tenantId, id: args.id };
};
export default handler;
