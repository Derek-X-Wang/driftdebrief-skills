import { CARD_TYPES, IMPORTANCE_LEVELS } from './contract';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  archiveNewCard,
  emitCard,
  getOpenCards,
  markStale,
  proposeCardChange,
  renderOpenCardsForContext,
  updateNewCard,
} from './client';
import { loadConfig, resolveProjectKey } from './config';

/**
 * DriftDebrief MCP server — the common integration layer (Claude Code, Codex,
 * Cursor) over the Convex HTTP API (ADR-0004). Run via `driftdebrief mcp`.
 */
export async function runMcpServer(): Promise<void> {
  const cfg = loadConfig();
  const server = new McpServer({ name: 'driftdebrief', version: '0.1.0' });

  server.registerTool(
    'driftdebrief_emit_card',
    {
      description:
        'Emit a DriftDebrief debrief card: one durable thing the human should later understand about what you did, changed, or assumed. Use after meaningful work, especially for assumptions, decisions, hidden constraints, and things likely to be misunderstood later.',
      inputSchema: {
        type: z
          .string()
          .describe(
            `${CARD_TYPES.join(' | ')} (canonical). Any bounded slug is accepted and stored; unknown types render with an UNKNOWN badge (ADR-0007 tolerant).`,
          ),
        title: z.string().min(1).max(200).describe('Short, scannable headline'),
        body: z.string().min(1).max(8000).describe('The explanation, in markdown'),
        importance: z
          .string()
          .max(50)
          .optional()
          .describe(
            `${IMPORTANCE_LEVELS.join(' | ')}. Defaults to normal. Unknown values are accepted and stored as normal.`,
          ),
        files: z.array(z.string()).optional().describe('Files/paths this card concerns (provenance + staleness)'),
        commitSha: z.string().optional(),
        projectKey: z.string().optional().describe('Defaults to this repo (git remote or cwd)'),
      },
    },
    async (args) => {
      const projectKey = resolveProjectKey(cfg.cwd, args.projectKey);
      const result = await emitCard(cfg, {
        projectKey,
        type: args.type,
        title: args.title,
        body: args.body,
        importance: args.importance,
        files: args.files,
        commitSha: args.commitSha,
      });
      return {
        content: [{ type: 'text', text: `Emitted card ${result.id} to project ${projectKey}.` }],
      };
    },
  );

  server.registerTool(
    'driftdebrief_get_open_cards',
    {
      description:
        'Fetch unresolved / drifted debrief cards for this project. Call at the start of work to resync your shared mental model with the human; pay attention to cards marked wrong (drift signals).',
      inputSchema: {
        projectKey: z.string().optional().describe('Defaults to this repo (git remote or cwd)'),
      },
    },
    async (args) => {
      const projectKey = resolveProjectKey(cfg.cwd, args.projectKey);
      const cards = await getOpenCards(cfg, projectKey);
      const text = cards.length
        ? renderOpenCardsForContext(cards)
        : 'No unresolved DriftDebrief cards for this project.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'driftdebrief_mark_stale',
    {
      description:
        'Mark one or more debrief cards as stale after detecting that the files they describe have changed. ' +
        'Run `git diff --name-only <card.commitSha>..HEAD -- <card.files>` and call this for cards whose area changed. ' +
        'Staleness surfaces the card to the human for re-review — it does NOT resolve or close the card.',
      inputSchema: {
        cards: z
          .array(
            z.object({
              cardId: z.string().describe('The card ID to mark stale'),
              changedFiles: z.array(z.string()).optional().describe('Files that changed (for telemetry)'),
              fromCommit: z.string().optional().describe('Commit SHA the card was written against'),
              toCommit: z.string().optional().describe('Current HEAD commit'),
            }),
          )
          .min(1)
          .max(50)
          .describe('Cards to mark stale (batch, 1–50)'),
      },
    },
    async (args) => {
      const result = await markStale(cfg, { cards: args.cards });
      return {
        content: [
          {
            type: 'text',
            text: `Marked ${result.marked} card(s) stale, ${result.skipped} skipped (not found or wrong workspace).`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'driftdebrief_update_new_card',
    {
      description:
        'Update content fields (title, body, type, importance) on a debrief card that is still new and unreviewed. ' +
        'Use this to correct a card you just emitted — for example to clarify the body or adjust the type. ' +
        'If the human has already reviewed the card, use driftdebrief_propose_card_change instead (the server enforces this). ' +
        'Unknown type/importance values are accepted and stored with a soft warning (ADR-0007 tolerant).',
      inputSchema: {
        cardId: z.string().describe('The card ID to update'),
        patch: z.object({
          title: z.string().min(1).max(200).optional().describe('New title'),
          body: z.string().min(1).max(8000).optional().describe('New body (markdown)'),
          type: z
            .string()
            .optional()
            .describe(`New card type (${CARD_TYPES.join(' | ')}). Unknown values stored as-is with warning.`),
          importance: z
            .string()
            .optional()
            .describe(
              `New importance (${IMPORTANCE_LEVELS.join(' | ')}). Unknown values fall back to 'normal'.`,
            ),
        }).describe('Fields to update (at least one required)'),
      },
    },
    async (args) => {
      const result = await updateNewCard(cfg, { cardId: args.cardId, patch: args.patch });
      if (!result.found) {
        return { content: [{ type: 'text', text: `Card ${args.cardId} not found.` }] };
      }
      if (!result.updated) {
        return {
          content: [
            {
              type: 'text',
              text: `Card ${args.cardId} was not updated: ${result.warnings.join('; ')}`,
            },
          ],
        };
      }
      const warnText = result.warnings.length ? ` Warnings: ${result.warnings.join('; ')}` : '';
      return {
        content: [{ type: 'text', text: `Updated card ${args.cardId}.${warnText}` }],
      };
    },
  );

  server.registerTool(
    'driftdebrief_archive_new_card',
    {
      description:
        'Soft-archive a debrief card that is still new and unreviewed — for example a duplicate or a card that turned out to be irrelevant. ' +
        'There is no hard delete: the row and its history are preserved for the durable-memory record, but the card is hidden from all active surfaces. ' +
        'If the human has already reviewed the card, use driftdebrief_propose_card_change instead (the server enforces this).',
      inputSchema: {
        cardId: z.string().describe('The card ID to archive'),
        reason: z.string().min(1).max(2000).describe('Why this card is being archived'),
      },
    },
    async (args) => {
      const result = await archiveNewCard(cfg, { cardId: args.cardId, reason: args.reason });
      if (!result.found) {
        return { content: [{ type: 'text', text: `Card ${args.cardId} not found.` }] };
      }
      if (!result.archived) {
        return {
          content: [
            {
              type: 'text',
              text: `Card ${args.cardId} was not archived: ${result.warning ?? 'already reviewed — use propose_card_change'}`,
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: `Archived card ${args.cardId}.` }] };
    },
  );

  server.registerTool(
    'driftdebrief_propose_card_change',
    {
      description:
        'Propose a change to a debrief card that the human has already reviewed. ' +
        'The proposal is stored as an append-only event and surfaced to the human during their next Review session; it does NOT mutate the card directly. ' +
        'Use this for reviewed cards when you believe the card is outdated, wrong, or should be archived. ' +
        'For new/unreviewed cards use driftdebrief_update_new_card or driftdebrief_archive_new_card to apply changes directly.',
      inputSchema: {
        cardId: z.string().describe('The card ID to propose a change for'),
        proposal: z
          .string()
          .min(1)
          .max(4000)
          .describe('The proposed change in plain language (e.g. "update body to reflect new auth flow" or "archive — no longer relevant after the refactor")'),
        evidence: z
          .string()
          .max(8000)
          .optional()
          .describe('Supporting context: diff, file list, explanation of why the change is needed'),
      },
    },
    async (args) => {
      const result = await proposeCardChange(cfg, {
        cardId: args.cardId,
        proposal: args.proposal,
        evidence: args.evidence,
      });
      if (!result.found) {
        return { content: [{ type: 'text', text: `Card ${args.cardId} not found.` }] };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Proposal recorded for card ${args.cardId} (event ${result.eventId}). The human will see it during their next Review session.`,
          },
        ],
      };
    },
  );

  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  runMcpServer().catch((err) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
