import type { AlertConfig, WatchdogConfig } from './storage.js';
import type { WatchdogLogEntry } from './watchdog.js';

type WatchdogStatusSummary = {
  enabled: boolean;
  dryRun: boolean;
  hasPrivateKey: boolean;
  triggerHF: number;
  targetHF: number;
  recentActions: number;
};

export function shouldRunMonitor(config: AlertConfig): boolean {
  return config.wallets.some((wallet) => wallet.enabled);
}

export function validateWatchdogThresholds(
  current: WatchdogConfig,
  partial: Partial<WatchdogConfig> | undefined,
): string | null {
  if (!partial) return null;

  const merged = { ...current, ...partial };
  if (merged.targetHF <= merged.triggerHF) {
    return 'watchdog.targetHF must be greater than watchdog.triggerHF';
  }

  return null;
}

export function formatWatchdogStatusMessage(
  summary: WatchdogStatusSummary,
  log: WatchdogLogEntry[],
): string {
  const recent = log.slice(0, 5);
  const lines = [
    '<b>Watchdog Status</b>',
    '',
    `Enabled: <b>${summary.enabled ? 'Yes' : 'No'}</b>`,
    `Mode: <b>${summary.dryRun ? 'Dry Run' : 'Live'}</b>`,
    `Private Key: <b>${summary.hasPrivateKey ? 'Configured' : 'Not set'}</b>`,
    `Trigger HF: <b>${summary.triggerHF}</b>`,
    `Target HF: <b>${summary.targetHF}</b>`,
    `Total actions logged: ${summary.recentActions}`,
  ];

  if (recent.length > 0) {
    lines.push('', '<b>Recent Actions</b>');
    for (const entry of recent) {
      const time = new Date(entry.timestamp).toLocaleString();
      lines.push(
        `${escapeTelegramHtml(time)} · <b>${escapeTelegramHtml(entry.action)}</b> · ${escapeTelegramHtml(entry.reason)}`,
      );
    }
  }

  return lines.join('\n');
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
