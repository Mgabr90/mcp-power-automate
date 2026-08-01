import { statSync } from 'node:fs';
import type { TokenAudit } from './schemas.js';
import { tokenAuditSchema } from './schemas.js';
import { getDataFilePath } from './runtime-paths.js';
import { readVersionedStore, readVersionedStoreSync, writeVersionedStore } from './store-utils.js';

const STORE_NAME = 'token-audit';
const STORE_VERSION = 1;

let activeTokenAudit: TokenAudit | null = null;
let cachedFileMtimeMs: number = 0;

// Re-read from disk when the underlying file has been modified by another process
// (the extension POSTs to whichever process owns the bridge port; other MCP stdio
// processes only see the update via the file). statSync is cheap on modern OSes,
// so we pay the cost on every getter call but skip the JSON parse unless the file
// actually changed.
const refreshFromDiskIfChanged = () => {
  const filePath = getDataFilePath('token-audit.json');
  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    return;
  }
  if (mtimeMs <= cachedFileMtimeMs) return;

  const reloaded = readVersionedStoreSync({
    filePath,
    migrate: (value) => tokenAuditSchema.parse(value),
    name: STORE_NAME,
    parse: (value) => tokenAuditSchema.parse(value),
    version: STORE_VERSION,
  });
  if (reloaded) {
    activeTokenAudit = reloaded;
    cachedFileMtimeMs = mtimeMs;
  }
};

export const getTokenAudit = () => {
  refreshFromDiskIfChanged();
  return activeTokenAudit;
};

export const loadTokenAudit = async () => {
  activeTokenAudit = await readVersionedStore({
    filePath: getDataFilePath('token-audit.json'),
    migrate: (value) => tokenAuditSchema.parse(value),
    name: STORE_NAME,
    parse: (value) => tokenAuditSchema.parse(value),
    version: STORE_VERSION,
  });
  try {
    cachedFileMtimeMs = statSync(getDataFilePath('token-audit.json')).mtimeMs;
  } catch {
    cachedFileMtimeMs = 0;
  }
  return activeTokenAudit;
};

export const saveTokenAudit = async (audit: TokenAudit) => {
  const parsed = tokenAuditSchema.parse(audit);
  await writeVersionedStore({
    data: parsed,
    filePath: getDataFilePath('token-audit.json'),
    name: STORE_NAME,
    version: STORE_VERSION,
  });
  activeTokenAudit = parsed;
  try {
    cachedFileMtimeMs = statSync(getDataFilePath('token-audit.json')).mtimeMs;
  } catch {
    cachedFileMtimeMs = 0;
  }
  return parsed;
};
