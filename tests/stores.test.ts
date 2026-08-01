import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const validSession = {
  apiToken: 'Bearer token',
  apiUrl: 'https://example.api.powerplatform.com/',
  capturedAt: '2026-04-01T00:00:00.000Z',
  envId: 'Default-123',
  flowId: '123e4567-e89b-12d3-a456-426614174000',
};

let tempDir = '';

beforeEach(async () => {
  vi.resetModules();
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-pa-'));
  process.env.POWER_AUTOMATE_DATA_DIR = tempDir;
});

afterEach(async () => {
  delete process.env.POWER_AUTOMATE_DATA_DIR;
  await rm(tempDir, { force: true, recursive: true });
});

describe('stores', () => {
  it('persists sessions in the configured data directory', async () => {
    const sessionStore = await import('../server/session-store.js');

    await sessionStore.saveSession(validSession);

    const savedFile = await readFile(path.join(tempDir, 'session.json'), 'utf8');
    const capturedSessionsFile = await readFile(path.join(tempDir, 'captured-sessions.json'), 'utf8');
    const selectedWorkTabFile = await readFile(path.join(tempDir, 'selected-work-tab.json'), 'utf8');
    expect(JSON.parse(savedFile)).toMatchObject({
      data: validSession,
      version: 1,
    });
    expect(JSON.parse(capturedSessionsFile)).toMatchObject({
      data: {
        records: {
          '0': expect.objectContaining({
            envId: validSession.envId,
            flowId: validSession.flowId,
            tabId: 0,
          }),
        },
      },
      version: 1,
    });
    expect(JSON.parse(selectedWorkTabFile)).toMatchObject({
      data: {
        tabId: 0,
      },
      version: 1,
    });
    expect(sessionStore.getSessionFilePath()).toBe(path.join(tempDir, 'session.json'));
  });

  it('loads legacy single-record snapshot files into the new keyed shape', async () => {
    await writeFile(
      path.join(tempDir, 'flow-snapshot.json'),
      JSON.stringify(
        {
          capturedAt: '2026-04-01T00:00:00.000Z',
          envId: 'env-1',
          flow: {
            connectionReferences: {},
            definition: {
              actions: {},
              triggers: {},
            },
          },
          flowId: 'flow-1',
          source: 'test',
        },
        null,
        2,
      ),
      'utf8',
    );

    const snapshotStore = await import('../server/flow-snapshot-store.js');
    const loaded = await snapshotStore.loadFlowSnapshot();

    expect(loaded).toMatchObject({
      activeKey: 'env-1:flow-1',
    });
    expect(snapshotStore.getFlowSnapshotForFlow({ envId: 'env-1', flowId: 'flow-1' })).toMatchObject({
      source: 'test',
    });
  });

  it('loads legacy last-run files and rewrites them as keyed records on save', async () => {
    await writeFile(
      path.join(tempDir, 'last-run.json'),
      JSON.stringify(
        {
          capturedAt: '2026-04-01T00:00:00.000Z',
          envId: 'env-1',
          flowId: 'flow-1',
          run: {
            flowId: 'flow-1',
            runId: 'run-1',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const runStore = await import('../server/last-run-store.js');
    await runStore.loadLastRun();
    await runStore.saveLastRun({
      capturedAt: '2026-04-02T00:00:00.000Z',
      envId: 'env-1',
      flowId: 'flow-1',
      run: {
        flowId: 'flow-1',
        runId: 'run-2',
      },
    });

    const persisted = JSON.parse(await readFile(path.join(tempDir, 'last-run.json'), 'utf8'));

    expect(persisted.version).toBe(1);
    expect(persisted.data.activeKey).toBe('env-1:flow-1');
    expect(Object.keys(persisted.data.records)).toContain('env-1:flow-1');
    expect(persisted.data.records['env-1:flow-1'].run.runId).toBe('run-2');
  });

  it('marks corrupted stores in diagnostics instead of silently treating them as healthy', async () => {
    await writeFile(path.join(tempDir, 'session.json'), '{not-json', 'utf8');

    const sessionStore = await import('../server/session-store.js');
    const diagnostics = await import('../server/store-utils.js');
    const loaded = await sessionStore.loadSession();

    expect(loaded).toBeNull();
    expect(diagnostics.getStoreDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'session',
          state: 'corrupted',
        }),
      ]),
    );
  });

  it('keeps captured sessions per tab and switches the selected work tab explicitly', async () => {
    const sessionStore = await import('../server/session-store.js');
    const capturedSessionsStore = await import('../server/captured-sessions-store.js');
    const selectedWorkTabStore = await import('../server/selected-work-tab-store.js');

    await sessionStore.saveSession({
      ...validSession,
      flowId: 'flow-a',
      tabId: 101,
    });
    await capturedSessionsStore.upsertCapturedSession({
      ...validSession,
      capturedAt: '2026-04-01T00:05:00.000Z',
      envId: 'Default-999',
      flowId: 'flow-b',
      lastSeenAt: '2026-04-01T00:05:00.000Z',
      tabId: 202,
    });

    await selectedWorkTabStore.saveSelectedWorkTab({
      selectedAt: '2026-04-01T00:06:00.000Z',
      tabId: 202,
    });

    expect(sessionStore.getSession()).toMatchObject({
      envId: 'Default-999',
      flowId: 'flow-b',
    });
    expect(capturedSessionsStore.listCapturedSessions().map((session) => session.tabId)).toEqual([202, 101]);
  });

  it('falls back to the freshest capture when the selected work tab is gone', async () => {
    const sessionStore = await import('../server/session-store.js');
    const capturedSessionsStore = await import('../server/captured-sessions-store.js');
    const selectedWorkTabStore = await import('../server/selected-work-tab-store.js');

    await sessionStore.saveSession({ ...validSession, flowId: 'flow-a', tabId: 101 });
    await capturedSessionsStore.upsertCapturedSession({
      ...validSession,
      capturedAt: '2026-04-01T00:05:00.000Z',
      flowId: 'flow-b',
      lastSeenAt: '2026-04-01T00:05:00.000Z',
      tabId: 202,
    });
    await selectedWorkTabStore.saveSelectedWorkTab({ selectedAt: '2026-04-01T00:06:00.000Z', tabId: 202 });

    // Closing tab 202 drops its capture and clears the stored selection.
    await capturedSessionsStore.removeCapturedSession(202);
    await selectedWorkTabStore.clearSelectedWorkTab();

    expect(selectedWorkTabStore.getSelectedWorkTab()).toMatchObject({ tabId: 101 });
    expect(sessionStore.getSession()).toMatchObject({ flowId: 'flow-a' });
  });

  it('prefers a capture that still carries legacy access', async () => {
    const capturedSessionsStore = await import('../server/captured-sessions-store.js');
    const selectedWorkTabStore = await import('../server/selected-work-tab-store.js');

    await capturedSessionsStore.upsertCapturedSession({
      ...validSession,
      lastSeenAt: '2026-04-01T00:01:00.000Z',
      legacyApiUrl: 'https://example.api.flow.microsoft.com/',
      legacyToken: 'Bearer legacy',
      tabId: 301,
    });
    // Newer, but no legacy token - it cannot mint callback URLs.
    await capturedSessionsStore.upsertCapturedSession({
      ...validSession,
      lastSeenAt: '2026-04-01T00:09:00.000Z',
      tabId: 302,
    });

    expect(selectedWorkTabStore.getSelectedWorkTab()).toMatchObject({ tabId: 301 });
  });

  it('reports no selection when nothing has been captured', async () => {
    const selectedWorkTabStore = await import('../server/selected-work-tab-store.js');

    expect(selectedWorkTabStore.getSelectedWorkTab()).toBeNull();
  });

  it('rejects web-page origins and allows the extension and local callers', async () => {
    const { isAllowedOrigin } = await import('../server/index.js');

    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop')).toBe(true);
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    expect(isAllowedOrigin('https://make.powerautomate.com')).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:17373')).toBe(false);
  });

  it('only accepts application/json on POST so text/plain cannot skip preflight', async () => {
    const { isAllowedPostContentType } = await import('../server/index.js');

    expect(isAllowedPostContentType('application/json')).toBe(true);
    expect(isAllowedPostContentType('application/json; charset=utf-8')).toBe(true);
    expect(isAllowedPostContentType('APPLICATION/JSON')).toBe(true);
    expect(isAllowedPostContentType('text/plain')).toBe(false);
    expect(isAllowedPostContentType('multipart/form-data')).toBe(false);
    expect(isAllowedPostContentType(undefined)).toBe(false);
  });

  it('distinguishes the environment Power Platform host from the tenant one', async () => {
    const { isEnvironmentApiUrl } = await import('../server/dataverse-solutions.js');

    expect(isEnvironmentApiUrl('https://default8cb1.84.environment.api.powerplatform.com/')).toBe(true);
    // The Connections page calls this one; it answers EndpointInvalid for flow APIs.
    expect(isEnvironmentApiUrl('https://8cb1.84.tenant.api.powerplatform.com/')).toBe(false);
    expect(isEnvironmentApiUrl('https://api.flow.microsoft.com/')).toBe(false);
    expect(isEnvironmentApiUrl(null)).toBe(false);
    expect(isEnvironmentApiUrl(undefined)).toBe(false);
  });
});
