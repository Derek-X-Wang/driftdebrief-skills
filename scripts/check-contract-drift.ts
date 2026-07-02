#!/usr/bin/env bun
/**
 * Contract drift check — compares the pinned `@driftdebrief/core` dependency
 * against the backend's canonical `GET /api/contract` discovery endpoint.
 *
 * Per ADR-0009 D6, this covers the runtime axis the shared package cannot:
 * the DEPLOYED backend and the PUBLISHED core we pin can still skew (deploy
 * without publish, publish without bump). Drift is SAFE (the backend's
 * tolerant ingest boundary is the actual safety mechanism, ADR-0007); this
 * check just makes it LOUD — when it goes red, bump the core dependency.
 *
 * Run: bun scripts/check-contract-drift.ts
 * Override the endpoint with DRIFTDEBRIEF_CONTRACT_URL (defaults to prod).
 */
import {
  AGENT_SOURCE_MAX_LEN,
  AGENT_SOURCE_SLUG_RE,
  AGENT_SOURCES,
  CARD_TYPE_MAX_LEN,
  CARD_TYPE_SLUG_RE,
  CARD_TYPES,
  IMPORTANCE_LEVELS,
} from '@driftdebrief/core';

const URL =
  process.env.DRIFTDEBRIEF_CONTRACT_URL ??
  'https://dynamic-antelope-631.convex.site/api/contract';

interface ServerContract {
  version: string;
  cardTypes: string[];
  importanceLevels: string[];
  agentSources: string[];
  fieldLimits: Record<string, { maxLength: number }>;
  slugPatterns: { type: string; agent: string };
}

function diffList(name: string, server: string[], vendored: readonly string[]): string[] {
  const problems: string[] = [];
  const missing = server.filter((v) => !vendored.includes(v));
  const extra = vendored.filter((v) => !server.includes(v));
  if (missing.length) {
    problems.push(`${name}: server has values our pinned @driftdebrief/core lacks: ${missing.join(', ')} — bump the dependency`);
  }
  if (extra.length) {
    problems.push(`${name}: vendored copy has values the server lacks: ${extra.join(', ')} — backend-first rule violated?`);
  }
  return problems;
}

const res = await fetch(URL);
if (!res.ok) {
  console.error(`GET ${URL} failed: ${res.status} — cannot verify contract`);
  process.exit(2);
}
const server = (await res.json()) as ServerContract;

const problems: string[] = [
  ...diffList('cardTypes', server.cardTypes, CARD_TYPES),
  ...diffList('importanceLevels', server.importanceLevels, IMPORTANCE_LEVELS),
  ...diffList('agentSources', server.agentSources, AGENT_SOURCES),
];
if (server.fieldLimits.type?.maxLength !== CARD_TYPE_MAX_LEN) {
  problems.push(`fieldLimits.type.maxLength: server=${server.fieldLimits.type?.maxLength} vendored=${CARD_TYPE_MAX_LEN}`);
}
if (server.fieldLimits.agent?.maxLength !== AGENT_SOURCE_MAX_LEN) {
  problems.push(`fieldLimits.agent.maxLength: server=${server.fieldLimits.agent?.maxLength} vendored=${AGENT_SOURCE_MAX_LEN}`);
}
if (server.slugPatterns.type !== CARD_TYPE_SLUG_RE.source) {
  problems.push(`slugPatterns.type: server=${server.slugPatterns.type} vendored=${CARD_TYPE_SLUG_RE.source}`);
}
if (server.slugPatterns.agent !== AGENT_SOURCE_SLUG_RE.source) {
  problems.push(`slugPatterns.agent: server=${server.slugPatterns.agent} vendored=${AGENT_SOURCE_SLUG_RE.source}`);
}

if (problems.length) {
  console.error(`Contract drift vs ${URL} (server contract version ${server.version}):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`Pinned @driftdebrief/core matches server contract v${server.version} (${URL}).`);
