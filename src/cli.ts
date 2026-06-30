#!/usr/bin/env bun
import { isValidCardTypeSlug } from './contract';

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
import { runMcpServer } from './mcp';
import { runStopHook } from './reflect';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** Print the Claude Code install instructions (Stop-hook emit + manual /dd-sync). */
function installHelp(cliPath: string): string {
  const cmd = `bun ${cliPath}`;
  const settings = JSON.stringify(
    {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: `${cmd} stop-hook` }] }],
      },
    },
    null,
    2,
  );

  return `DriftDebrief — Claude Code setup

1) Set env (e.g. in your shell profile or .claude/settings.json "env"):
   export DRIFTDEBRIEF_API_URL="https://<your-deployment>.convex.site"
   export DRIFTDEBRIEF_TOKEN="dd_..."   # mint one in the app: Workspace > Ingest tokens

2) Register the MCP server (emit + retrieve + manage; works in Codex/Cursor too):
   claude mcp add driftdebrief -- ${cmd} mcp

3) Add the EMIT hook to .claude/settings.json (NOT a plugin — plugin hooks are
   unreliable, claude-code #16538). The Stop hook fires after each turn and lets
   the agent decide whether to emit / update / archive a card:
${settings}

4) SYNC on demand: run the /dd-sync slash command (installed via the plugin or
   .claude/commands/dd-sync.md) whenever you want to pull open + drifted cards
   and reconcile the agent's async decisions.

No SessionStart hook is used: its additionalContext is dropped on new sessions
(claude-code #10373). EMIT rides the reliable Stop hook; SYNC is manual.
`;
}

async function main() {
  const [, , command, ...rest] = process.argv;

  // Commands that must run WITHOUT API config (they don't touch the API):
  // the Stop hook fires on every turn and must never throw on a missing token.
  switch (command) {
    case 'stop-hook':
      await runStopHook();
      return;
    case 'install':
    case 'hooks':
      process.stdout.write(installHelp(process.argv[1]!));
      return;
  }

  const cfg = loadConfig();

  switch (command) {
    case 'mcp': {
      await runMcpServer();
      return;
    }

    case 'open': {
      const projectKey = resolveProjectKey(cfg.cwd, flag(rest, 'project'));
      const cards = await getOpenCards(cfg, projectKey);
      if (has(rest, 'json')) {
        process.stdout.write(JSON.stringify(cards, null, 2));
      } else if (has(rest, 'context')) {
        process.stdout.write(renderOpenCardsForContext(cards));
      } else {
        process.stdout.write(
          cards.length
            ? cards.map((c) => `• [${c.type}/${c.importance}/${c.state}] ${c.title}`).join('\n')
            : 'No unresolved cards.',
        );
      }
      process.stdout.write('\n');
      return;
    }

    case 'emit': {
      const type = flag(rest, 'type');
      const title = flag(rest, 'title');
      const body = has(rest, 'stdin') ? await readStdin() : flag(rest, 'body');
      // Tolerant (ADR-0007): accept any bounded slug, not just canonical CARD_TYPES,
      // so a separately-versioned producer can emit a type the server added later.
      if (!isValidCardTypeSlug(type) || !title || !body) {
        throw new Error('emit requires --type <bounded slug> --title <t> --body <b> (or --stdin)');
      }
      const filesRaw = flag(rest, 'files');
      const result = await emitCard(cfg, {
        projectKey: resolveProjectKey(cfg.cwd, flag(rest, 'project')),
        type,
        title,
        body,
        importance: flag(rest, 'importance'),
        files: filesRaw ? filesRaw.split(',').map((f) => f.trim()) : undefined,
        commitSha: flag(rest, 'commit'),
      });
      process.stdout.write(`Emitted ${result.id}\n`);
      return;
    }

    case 'mark-stale': {
      // Usage: driftdebrief mark-stale --card <id>[,<id>,...] [--from <sha>] [--to <sha>] [--files a,b]
      const cardIdsRaw = flag(rest, 'card');
      if (!cardIdsRaw) {
        throw new Error('mark-stale requires --card <id>[,<id>,...]');
      }
      const cardIds = cardIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
      const fromCommit = flag(rest, 'from');
      const toCommit = flag(rest, 'to');
      const changedFilesRaw = flag(rest, 'files');
      const changedFiles = changedFilesRaw
        ? changedFilesRaw.split(',').map((f) => f.trim()).filter(Boolean)
        : undefined;

      const result = await markStale(cfg, {
        cards: cardIds.map((cardId) => ({ cardId, fromCommit, toCommit, changedFiles })),
      });
      process.stdout.write(`Marked ${result.marked} stale, ${result.skipped} skipped.\n`);
      return;
    }

    case 'update-card': {
      // Usage: driftdebrief update-card --id <cardId> [--title X] [--body Y] [--type T] [--importance I]
      const cardId = flag(rest, 'id');
      if (!cardId) {
        throw new Error('update-card requires --id <cardId>');
      }
      const title = flag(rest, 'title');
      const body = has(rest, 'stdin') ? await readStdin() : flag(rest, 'body');
      const type = flag(rest, 'type');
      const importance = flag(rest, 'importance');

      if (!title && !body && !type && !importance) {
        throw new Error('update-card requires at least one of --title, --body, --type, --importance');
      }

      const result = await updateNewCard(cfg, {
        cardId,
        patch: { title, body, type, importance },
      });

      if (!result.found) {
        process.stderr.write(`Card ${cardId} not found.\n`);
        process.exit(1);
      }
      if (!result.updated) {
        process.stderr.write(`Card ${cardId} not updated: ${result.warnings.join('; ')}\n`);
        process.exit(1);
      }
      if (result.warnings.length) {
        process.stderr.write(`Warnings: ${result.warnings.join('; ')}\n`);
      }
      process.stdout.write(`Updated ${cardId}\n`);
      return;
    }

    case 'archive-card': {
      // Usage: driftdebrief archive-card --id <cardId> --reason <text>
      const cardId = flag(rest, 'id');
      const reason = flag(rest, 'reason');
      if (!cardId || !reason) {
        throw new Error('archive-card requires --id <cardId> --reason <text>');
      }

      const result = await archiveNewCard(cfg, { cardId, reason });

      if (!result.found) {
        process.stderr.write(`Card ${cardId} not found.\n`);
        process.exit(1);
      }
      if (!result.archived) {
        process.stderr.write(
          `Card ${cardId} not archived: ${result.warning ?? 'already reviewed — use propose-change'}\n`,
        );
        process.exit(1);
      }
      process.stdout.write(`Archived ${cardId}\n`);
      return;
    }

    case 'propose-change': {
      // Usage: driftdebrief propose-change --id <cardId> --proposal <text> [--evidence <text>|--stdin]
      const cardId = flag(rest, 'id');
      const proposal = flag(rest, 'proposal');
      const evidence = has(rest, 'stdin') ? await readStdin() : flag(rest, 'evidence');

      if (!cardId || !proposal) {
        throw new Error('propose-change requires --id <cardId> --proposal <text>');
      }

      const result = await proposeCardChange(cfg, { cardId, proposal, evidence });

      if (!result.found) {
        process.stderr.write(`Card ${cardId} not found.\n`);
        process.exit(1);
      }
      process.stdout.write(`Proposal recorded (event ${result.eventId})\n`);
      return;
    }

    default: {
      const self = process.argv[1]!;
      process.stdout.write(
        [
          'DriftDebrief agent CLI',
          '',
          'Usage:',
          `  bun ${self} mcp                       Run the MCP server (Claude Code / Codex / Cursor)`,
          `  bun ${self} stop-hook                 Stop-hook EMIT driver (wire into .claude/settings.json)`,
          `  bun ${self} install                   Print Claude Code setup (MCP + Stop hook)`,
          `  bun ${self} open [--context|--json]   Print unresolved cards for this repo`,
          `  bun ${self} emit --type T --title X --body Y [--stdin] [--files a,b] [--importance I]`,
          `  bun ${self} mark-stale --card <id>[,<id>,...] [--from <sha>] [--to <sha>] [--files a,b]`,
          `  bun ${self} update-card --id <id> [--title X] [--body Y] [--type T] [--importance I]`,
          `  bun ${self} archive-card --id <id> --reason <text>`,
          `  bun ${self} propose-change --id <id> --proposal <text> [--evidence <text>|--stdin]`,
          '',
          'Env: DRIFTDEBRIEF_API_URL (Convex .site URL), DRIFTDEBRIEF_TOKEN (Workspace ingest token)',
        ].join('\n') + '\n',
      );
      return;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
