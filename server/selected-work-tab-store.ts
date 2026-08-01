import { promises as fs } from 'node:fs';

import type { SelectedWorkTab } from './schemas.js';
import { selectedWorkTabSchema } from './schemas.js';
import { getCapturedSession, listCapturedSessions } from './captured-sessions-store.js';
import { getDataFilePath } from './runtime-paths.js';
import { markStoreMissing, readVersionedStore, readVersionedStoreSync, writeVersionedStore } from './store-utils.js';

const STORE_NAME = 'selected-work-tab';
const STORE_VERSION = 1;

let selectedWorkTab: SelectedWorkTab | null = null;

const getStoreFilePath = () => getDataFilePath('selected-work-tab.json');

const readStoredWorkTab = () =>
  readVersionedStoreSync({
    filePath: getStoreFilePath(),
    migrate: (value) => selectedWorkTabSchema.parse(value),
    name: STORE_NAME,
    parse: (value) => selectedWorkTabSchema.parse(value),
    version: STORE_VERSION,
  }) || null;

// Closing the selected browser tab removes its capture and clears the stored
// selection, which used to leave every captured session unreachable — the bridge
// reported "no session" while perfectly good captures sat in the store. Fall back
// to the freshest capture instead, preferring one that still carries legacy
// access since that is what unlocks callback URLs and saves.
const pickFallbackWorkTab = (): SelectedWorkTab | null => {
  const sessions = listCapturedSessions();

  if (sessions.length === 0) return null;

  const preferred = sessions.find((session) => Boolean(session.legacyApiUrl && session.legacyToken)) || sessions[0];

  if (!preferred) return null;

  return selectedWorkTabSchema.parse({
    selectedAt: preferred.lastSeenAt,
    tabId: preferred.tabId,
  });
};

const refreshSelectedWorkTab = () => {
  const stored = readStoredWorkTab();

  // An explicit selection stays sticky, but only while its capture still exists.
  if (stored && getCapturedSession(stored.tabId)) {
    selectedWorkTab = stored;
    return selectedWorkTab;
  }

  selectedWorkTab = pickFallbackWorkTab();
  return selectedWorkTab;
};

export const loadSelectedWorkTab = async () => {
  const stored =
    (await readVersionedStore({
      filePath: getStoreFilePath(),
      migrate: (value) => selectedWorkTabSchema.parse(value),
      name: STORE_NAME,
      parse: (value) => selectedWorkTabSchema.parse(value),
      version: STORE_VERSION,
    })) || null;

  selectedWorkTab = stored && getCapturedSession(stored.tabId) ? stored : pickFallbackWorkTab();
  return selectedWorkTab;
};

export const getSelectedWorkTab = () => refreshSelectedWorkTab();

export const saveSelectedWorkTab = async (value: SelectedWorkTab) => {
  const parsed = selectedWorkTabSchema.parse(value);
  await writeVersionedStore({
    data: parsed,
    filePath: getStoreFilePath(),
    name: STORE_NAME,
    version: STORE_VERSION,
  });
  selectedWorkTab = parsed;
  return parsed;
};

export const clearSelectedWorkTab = async () => {
  selectedWorkTab = null;
  await fs.rm(getStoreFilePath(), { force: true });
  markStoreMissing(STORE_NAME, getStoreFilePath());
};
