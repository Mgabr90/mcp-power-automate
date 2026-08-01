export const POWER_AUTOMATE_URL_PATTERN = /make\.powerautomate\.com|make\.powerapps\.com|flow\.microsoft\.com/i;

export const POWER_AUTOMATE_TAB_URLS = [
  '*://*.make.powerautomate.com/*',
  '*://*.make.powerapps.com/*',
  '*://*.flow.microsoft.com/*',
];

/** Messages that carry captured credentials or flow contents. They are only
 * trustworthy from a content script on a Power Automate page — the popup and side
 * panel never send them. */
export const PAGE_SOURCED_MESSAGE_TYPES = new Set([
  'flow-snapshot',
  'token-audit',
  'token-from-storage',
  'token-from-msal',
]);

export const isPowerAutomateUrl = (url: string | null | undefined) => POWER_AUTOMATE_URL_PATTERN.test(url || '');

export const isPowerAutomateTab = (tab: { id?: number; url?: string } | null | undefined) =>
  typeof tab?.id === 'number' && isPowerAutomateUrl(tab.url);

export const isTrustedPageSender = (sender: { tab?: { id?: number; url?: string } } | null | undefined) =>
  isPowerAutomateTab(sender?.tab);

/** Keeps a long-lived Set from growing without bound in a page or service worker
 * that stays alive for hours. Drops the oldest entries once the cap is passed —
 * insertion order is preserved by Set. */
export const addBounded = <T>(set: Set<T>, value: T, maxSize: number) => {
  set.add(value);

  if (set.size <= maxSize) return set;

  for (const entry of set) {
    if (set.size <= maxSize) break;
    set.delete(entry);
  }

  return set;
};
