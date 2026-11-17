# Design: ops-onboarding-copilot

## Layout

```
examples/ops-onboarding-copilot/
  tenant.yaml
  knowledge/
    engineering-handbook.md
    hr-policies.md
    it-troubleshooting.md
    new-hire-checklist.pdf
  tools/
    create-it-ticket.ts      (handler for create_it_ticket)
```

The handler path in `tenant.yaml` is `./tools/create-it-ticket` (extensionless). File names in `tools/` use kebab-case. Tool names in config use snake_case.

## `tenant.yaml` outline

- `id: ops-onboarding-copilot`, `displayName: Ops Onboarding Copilot`.
- `systemPrompt`: friendly onboarding buddy; answer only from context; walk through documented troubleshooting first; when unresolved, summarize the issue into a title and priority, ask the user to confirm, then call `create_it_ticket`; never invent policies.
- `retrieval: { topK: 5, minScore: 0.6 }`, `chunking: { maxTokens: 400, overlap: 50 }`.
- `tools`: `create_it_ticket` with the JSON Schema from the requirements.

## Handler

```ts
import type { ToolHandler } from "@agent-skeleton/core";

type Args = { title: string; priority: "low" | "medium" | "high" };

const handler: ToolHandler<Args> = async (args, ctx) => {
  const count = (await ctx.data.find("tickets")).length;
  const ticketId = `IT-${1000 + count + 1}`;
  await ctx.data.insert("tickets", { ticketId, ...args, status: "open", createdAt: new Date().toISOString() });
  return { ticketId, status: "open", title: args.title, priority: args.priority };
};
export default handler;
```

The sequential id is derived inside the handler for demo purposes. Concurrent tickets could collide, which is acceptable for mock data and documented in a comment. A production handler would call a real ticketing API.

## Knowledge content guidelines

- Each Markdown file has an H1 and several H2 sections, each section self-contained (a section is a likely chunk).
- Troubleshooting entries follow the pattern: symptom, steps 1 to 4, "If this does not help, open an IT ticket".
- The PDF is generated from a Markdown source kept out of the repo's runtime path (or committed as a small static PDF), so the PDF parser is exercised.
