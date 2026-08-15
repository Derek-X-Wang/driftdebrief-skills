#!/usr/bin/env bun
import { isCardType, isValidCardTypeSlug } from '@driftdebrief/core';

import { authEnvironmentFromArgs, loginEnvironment, logoutEnvironment } from './auth';
import {
  archiveNewCard,
  emitCard,
  getOpenCards,
  markStale,
  proposeCardChange,
  renderOpenCardsForContext,
  updateNewCard,
} from './client';
import { allowUnknownTypes, loadConfig, resolveEnv, resolveProjectKey } from './config';
import {
  API_BASE_URLS,
  credentialForEnvironment,
  getCredentialsPath,
  maskToken,
  OAUTH_BASE_URLS,
} from './credentials';
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
  // Installed as a package bin (bunx/npm) → recommend the portable scoped form.
  // Running from a clone → print the absolute clone path so the commands work verbatim.
  const cmd = cliPath.includes('node_modules') ? 'bunx @driftdebrief/skills' : `bun ${cliPath}`;
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

1) Sign in through your browser (recommended; defaults to prod):
   ${cmd} auth login
   # For dev: ${cmd} auth login --env dev

   Existing DRIFTDEBRIEF_API_URL + DRIFTDEBRIEF_TOKEN env configuration is
   still supported and takes precedence over the saved login.

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
  // the Stop hook fires on every turn and must never throw on a missing token,
  // and help/usage must work before any env is set up.
  switch (command) {
    case 'stop-hook':
      await runStopHook();
      return;
    case 'install':
    case 'hooks':
      process.stdout.write(installHelp(process.argv[1]!));
      return;
    case 'auth': {
      const [action, ...authArgs] = rest;
      const environment = authEnvironmentFromArgs(authArgs);
      const credentialsPath = getCredentialsPath();

      if (action === 'login') {
        const result = await loginEnvironment(environment, {
          credentialsPath,
          onAuthorizationUrl: (url, browserOpened) => {
            process.stdout.write(
              `${browserOpened ? 'Opened your browser.' : 'Could not open a browser automatically.'}\n` +
                `Complete login at:\n${url}\n\nWaiting for authorization…\n`,
            );
          },
          onWarning: (message) => process.stderr.write(`Warning: ${message}\n`),
        });
        process.stdout.write(
          `Logged in to ${result.environment} (${result.oauthBaseUrl}).\nAPI: ${result.apiUrl}\nSaved ${maskToken(result.credential.dd_ingest_token)} to ${result.credentialsPath}\n`,
        );
        return;
      }

      if (action === 'status') {
        const credential = credentialForEnvironment(environment, credentialsPath);
        const active = resolveEnv(
          { ...process.env, DRIFTDEBRIEF_ENV: environment },
          credentialsPath,
        );
        process.stdout.write(
          [
            `saved env:    ${environment}`,
            `OAuth URL:    ${OAUTH_BASE_URLS[environment]}`,
            `saved API:    ${credential?.apiUrl ?? API_BASE_URLS[environment]}`,
            `saved token:  ${maskToken(credential?.dd_ingest_token)}`,
            `saved path:   ${credentialsPath}`,
            `saved status: ${credential ? 'present' : 'not present'}`,
            '',
            `active env:   ${active.selected}${active.defaulted ? ' (defaulted)' : ''}`,
            `active source: ${active.source}`,
            `active API:   ${active.apiUrl ?? '(not set)'}`,
            `active token: ${maskToken(active.token)}`,
            ...(active.error ? [`active error: ${active.error}`] : []),
          ].join('\n') + '\n',
        );
        if (active.error || !active.token || !active.apiUrl) process.exitCode = 1;
        return;
      }

      if (action === 'logout') {
        const result = await logoutEnvironment(environment, { credentialsPath });
        if (result.revokeWarning) process.stderr.write(`Warning: ${result.revokeWarning}\n`);
        process.stdout.write(
          result.removed
            ? `Logged out of ${environment}; removed its credential from ${credentialsPath}.\n`
            : `No saved ${environment} credential in ${credentialsPath}.\n`,
        );
        return;
      }

      throw new Error('auth requires login, status, or logout (optional: --env dev|prod)');
    }
    case 'env': {
      // Diagnostic: print what the config WOULD resolve to, without throwing —
      // this must work (and be useful) precisely when config is broken.
      const r = resolveEnv();
      process.stdout.write(
        [
          `selected:   ${r.selected}${r.defaulted ? ' (defaulted — set DRIFTDEBRIEF_ENV=dev|prod to pin)' : ''}`,
          `source:     ${r.source}`,
          `apiUrl:     ${r.apiUrl ?? '(not set)'}`,
          `token:      ${maskToken(r.token)}`,
          ...(r.credentialsPath ? [`credentials: ${r.credentialsPath}`] : []),
          `agent:      ${process.env.DRIFTDEBRIEF_AGENT ?? 'claude-code (default)'}`,
          `projectKey: ${resolveProjectKey(process.cwd())}${process.env.DRIFTDEBRIEF_PROJECT_KEY ? ' (from DRIFTDEBRIEF_PROJECT_KEY override)' : ''}`,
          ...(r.error ? ['', `⚠ ${r.error}`] : []),
        ].join('\n') + '\n',
      );
      if (r.error) process.exit(1);
      return;
    }
  }

  const CONFIG_COMMANDS = new Set([
    'mcp',
    'open',
    'emit',
    'mark-stale',
    'update-card',
    'archive-card',
    'propose-change',
  ]);
  if (command === undefined || !CONFIG_COMMANDS.has(command)) {
    printUsage();
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
      // Strict producer emit by default (typo guard, ADR-0007 D3). The escape hatch
      // (--allow-unknown-type / DRIFTDEBRIEF_ALLOW_UNKNOWN_TYPES=1) accepts any bounded
      // slug — for emitting a type the server added but this build doesn't yet vendor.
      const allowUnknown = has(rest, 'allow-unknown-type') || allowUnknownTypes();
      if (
        type === undefined ||
        !(allowUnknown ? isValidCardTypeSlug(type) : isCardType(type)) ||
        !title ||
        !body
      ) {
        throw new Error(
          allowUnknown
            ? 'emit requires --type <bounded slug> --title <t> --body <b> (or --stdin)'
            : 'emit requires --type <implementation|change|assumption|decision|constraint|watch_out> --title <t> --body <b> (or --stdin); pass --allow-unknown-type for a non-canonical type',
        );
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
      // Surface server warnings (unknown type/importance, created-new-project
      // diagnostic) — soft 2xx signals that must not be silently dropped.
      for (const w of result.warnings) process.stderr.write(`Warning: ${w}\n`);
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

  }
}

/** Print CLI usage. Must not require API config — help works with no env set. */
function printUsage(): void {
  process.stdout.write(
    [
      'DriftDebrief agent CLI',
      '',
      'Usage:',
      '  driftdebrief mcp                       Run the MCP server (Claude Code / Codex / Cursor)',
      '  driftdebrief stop-hook                 Stop-hook EMIT driver (wire into .claude/settings.json)',
      '  driftdebrief install                   Print Claude Code setup (MCP + Stop hook)',
      '  driftdebrief auth login [--env dev|prod]   Sign in via browser + PKCE (defaults to prod)',
      '  driftdebrief auth status [--env dev|prod]  Show the saved login (token masked)',
      '  driftdebrief auth logout [--env dev|prod]  Attempt remote revoke, then remove the saved login',
      '  driftdebrief env                       Print the resolved environment, source, URL, and masked token',
      '  driftdebrief open [--context|--json]   Print unresolved cards for this repo',
      '  driftdebrief emit --type T --title X --body Y [--stdin] [--files a,b] [--importance I] [--allow-unknown-type]',
      '  driftdebrief mark-stale --card <id>[,<id>,...] [--from <sha>] [--to <sha>] [--files a,b]',
      '  driftdebrief update-card --id <id> [--title X] [--body Y] [--type T] [--importance I]',
      '  driftdebrief archive-card --id <id> --reason <text>',
      '  driftdebrief propose-change --id <id> --proposal <text> [--evidence <text>|--stdin]',
      '',
      '(Running from a clone? Substitute `bun src/cli.ts` for `driftdebrief`.)',
      'Recommended: driftdebrief auth login. Env vars remain supported and take precedence.',
    ].join('\n') + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
