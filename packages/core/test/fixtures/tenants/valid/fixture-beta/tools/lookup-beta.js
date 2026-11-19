/** @type {import("@agent-skeleton/core").ToolHandler<{ id: string }>} */
export default async function lookupBeta(args, ctx) {
  return { ok: true, tenant: ctx.tenantId, id: args.id };
}
