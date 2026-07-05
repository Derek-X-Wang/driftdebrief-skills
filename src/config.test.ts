import { describe, expect, it } from 'vitest';

import { resolveEnv } from './config';

const PAIRS = {
  DRIFTDEBRIEF_API_URL_DEV: 'https://dev.convex.site',
  DRIFTDEBRIEF_TOKEN_DEV: 'dd_dev_token',
  DRIFTDEBRIEF_API_URL_PROD: 'https://prod.convex.site',
  DRIFTDEBRIEF_TOKEN_PROD: 'dd_prod_token',
};

describe('resolveEnv', () => {
  it('defaults to prod when DRIFTDEBRIEF_ENV is unset and both pairs exist', () => {
    const r = resolveEnv({ ...PAIRS });
    expect(r).toMatchObject({
      selected: 'prod',
      defaulted: true,
      apiUrl: 'https://prod.convex.site',
      token: 'dd_prod_token',
    });
    expect(r.error).toBeUndefined();
  });

  it('selects the dev pair when DRIFTDEBRIEF_ENV=dev', () => {
    const r = resolveEnv({ ...PAIRS, DRIFTDEBRIEF_ENV: 'dev' });
    expect(r).toMatchObject({
      selected: 'dev',
      defaulted: false,
      apiUrl: 'https://dev.convex.site',
      token: 'dd_dev_token',
    });
  });

  it('selects the prod pair when DRIFTDEBRIEF_ENV=prod (not defaulted)', () => {
    const r = resolveEnv({ ...PAIRS, DRIFTDEBRIEF_ENV: 'prod' });
    expect(r).toMatchObject({ selected: 'prod', defaulted: false });
  });

  it('bare DRIFTDEBRIEF_API_URL + TOKEN override the profiles as custom', () => {
    const r = resolveEnv({
      ...PAIRS,
      DRIFTDEBRIEF_ENV: 'dev',
      DRIFTDEBRIEF_API_URL: 'https://custom.convex.site',
      DRIFTDEBRIEF_TOKEN: 'dd_custom',
    });
    expect(r).toMatchObject({
      selected: 'custom',
      apiUrl: 'https://custom.convex.site',
      token: 'dd_custom',
    });
    expect(r.error).toBeUndefined();
  });

  it('errors when only one bare var is set (no silent half-profile mix)', () => {
    const r = resolveEnv({ ...PAIRS, DRIFTDEBRIEF_API_URL: 'https://custom.convex.site' });
    expect(r.selected).toBe('custom');
    expect(r.error).toContain('DRIFTDEBRIEF_TOKEN');
  });

  it('errors naming the exact missing vars for the selected profile', () => {
    const r = resolveEnv({ DRIFTDEBRIEF_ENV: 'dev' });
    expect(r.selected).toBe('dev');
    expect(r.error).toContain('DRIFTDEBRIEF_API_URL_DEV');
    expect(r.error).toContain('DRIFTDEBRIEF_TOKEN_DEV');
  });

  it('errors naming the prod vars when defaulting with nothing set', () => {
    const r = resolveEnv({});
    expect(r).toMatchObject({ selected: 'prod', defaulted: true });
    expect(r.error).toContain('DRIFTDEBRIEF_API_URL_PROD');
  });

  it('rejects an invalid DRIFTDEBRIEF_ENV value', () => {
    const r = resolveEnv({ ...PAIRS, DRIFTDEBRIEF_ENV: 'staging' });
    expect(r.error).toContain('"staging"');
    expect(r.error).toContain('"dev" or "prod"');
  });

  it('partial profile pair reports only the missing var', () => {
    const r = resolveEnv({ DRIFTDEBRIEF_ENV: 'prod', DRIFTDEBRIEF_API_URL_PROD: 'https://p.site' });
    expect(r.error).toContain('DRIFTDEBRIEF_TOKEN_PROD');
    expect(r.error).not.toContain('DRIFTDEBRIEF_API_URL_PROD and');
  });
});
