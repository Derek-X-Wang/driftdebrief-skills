import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCredentialsFile, writeCredentialsFile } from './credentials';

describe('credentials file', () => {
  let directory: string;
  let credentialsPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'driftdebrief-credentials-'));
    credentialsPath = join(directory, 'nested', 'credentials.json');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('writes credentials with 0600 permissions', () => {
    writeCredentialsFile({ version: 1, credentials: {} }, credentialsPath);
    expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
  });

  it('tolerates a missing file', () => {
    expect(readCredentialsFile(credentialsPath)).toEqual({ version: 1, credentials: {} });
  });
});
