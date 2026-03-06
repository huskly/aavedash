import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Send, Settings, Trash2, X } from 'lucide-react';
import {
  DEFAULT_POLLING_CONFIG,
  DEFAULT_WATCHDOG_CONFIG,
  DEFAULT_ZONES,
  type PollingConfig,
  type WatchdogConfig,
  type Zone,
} from '@aave-monitor/core';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, CardContent, CardHeader } from './ui/card';
import { Separator } from './ui/separator';

type WalletConfig = {
  address: string;
  label?: string;
  enabled: boolean;
};

type ZoneConfig = {
  name: Zone['name'];
  minHF: number;
  maxHF: number;
};

type AlertConfig = {
  wallets: WalletConfig[];
  telegram: { chatId: string; enabled: boolean };
  polling: PollingConfig;
  zones: ZoneConfig[];
  watchdog: WatchdogConfig;
};

const DEFAULT_ZONE_CONFIG: ZoneConfig[] = DEFAULT_ZONES.map(({ name, minHF, maxHF }) => ({
  name,
  minHF,
  maxHF,
}));

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validateConfig(config: AlertConfig): string | null {
  const { watchdog } = config;

  if (!isPositiveFinite(watchdog.triggerHF)) {
    return 'Watchdog trigger HF must be a positive number.';
  }

  if (!isPositiveFinite(watchdog.targetHF)) {
    return 'Watchdog target HF must be a positive number.';
  }

  if (watchdog.targetHF <= watchdog.triggerHF) {
    return 'Watchdog target HF must be greater than trigger HF.';
  }

  if (!isPositiveFinite(watchdog.cooldownMs)) {
    return 'Watchdog cooldown must be a positive number.';
  }

  if (!isPositiveFinite(watchdog.maxRepayUsd)) {
    return 'Watchdog max repay must be a positive number.';
  }

  if (!isPositiveFinite(watchdog.maxGasGwei)) {
    return 'Watchdog max gas must be a positive number.';
  }

  return null;
}

function normalizeConfig(config: Partial<AlertConfig> | null | undefined): AlertConfig {
  const zones = (config?.zones ?? DEFAULT_ZONE_CONFIG).map((zone) => ({
    ...zone,
    maxHF: Number.isFinite(zone.maxHF) ? zone.maxHF : Infinity,
  }));

  return {
    wallets: config?.wallets ?? [],
    telegram: {
      chatId: config?.telegram?.chatId ?? '',
      enabled: config?.telegram?.enabled ?? false,
    },
    polling: {
      ...DEFAULT_POLLING_CONFIG,
      ...(config?.polling ?? {}),
    },
    zones,
    watchdog: {
      ...DEFAULT_WATCHDOG_CONFIG,
      ...(config?.watchdog ?? {}),
    },
  };
}

export function ServerSettings() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Server settings"
      >
        <Settings size={16} />
      </Button>
      {open ? <ServerSettingsPanel onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ServerSettingsPanel({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<AlertConfig | null>(null);
  const [backendAvailable, setBackendAvailable] = useState(true);
  const [error, setError] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [showZones, setShowZones] = useState(false);
  const [showPolling, setShowPolling] = useState(false);
  const [showWatchdog, setShowWatchdog] = useState(false);
  const [showNotificationSettings, setShowNotificationSettings] = useState(false);
  const [newWalletAddress, setNewWalletAddress] = useState('');
  const [newWalletLabel, setNewWalletLabel] = useState('');

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch(`/api/config`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!contentType.includes('application/json')) {
        throw new Error('Config API returned non-JSON response');
      }
      const data = (await response.json()) as Partial<AlertConfig>;
      setConfig(normalizeConfig(data));
      setBackendAvailable(true);
      setError('');
    } catch {
      setConfig(normalizeConfig(null));
      setBackendAvailable(false);
      setError(
        'Monitor server is not running. Start `yarn dev:all` (or `yarn dev:server`) for live config.',
      );
    }
  }, []);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  const saveConfig = async (updated: AlertConfig) => {
    if (!backendAvailable) {
      setError(
        'Monitor server is offline. Start `yarn dev:all` (or `yarn dev:server`) to save settings.',
      );
      return;
    }

    const validationError = validateConfig(updated);
    if (validationError) {
      setError(validationError);
      return;
    }

    try {
      const response = await fetch(`/api/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) message = payload.error;
        } catch {
          // Ignore parse failures and fallback to HTTP status.
        }
        throw new Error(message);
      }
      const data = (await response.json()) as AlertConfig;
      setConfig(normalizeConfig(data));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config');
    }
  };

  const sendTest = async () => {
    if (!backendAvailable) {
      setTestStatus('error');
      setError('Monitor server is offline. Telegram test requires the backend.');
      return;
    }

    setTestStatus('sending');
    try {
      const response = await fetch(`/api/telegram/test`, { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setTestStatus('success');
      setTimeout(() => setTestStatus('idle'), 3000);
    } catch {
      setTestStatus('error');
      setTimeout(() => setTestStatus('idle'), 3000);
    }
  };

  const addWallet = () => {
    if (!config || !newWalletAddress.trim()) return;
    const updated: AlertConfig = {
      ...config,
      wallets: [
        ...config.wallets,
        {
          address: newWalletAddress.trim(),
          label: newWalletLabel.trim() || undefined,
          enabled: true,
        },
      ],
    };
    setNewWalletAddress('');
    setNewWalletLabel('');
    void saveConfig(updated);
  };

  const removeWallet = (index: number) => {
    if (!config) return;
    const updated: AlertConfig = {
      ...config,
      wallets: config.wallets.filter((_, i) => i !== index),
    };
    void saveConfig(updated);
  };

  const toggleWallet = (index: number) => {
    if (!config) return;
    const updated: AlertConfig = {
      ...config,
      wallets: config.wallets.map((w, i) => (i === index ? { ...w, enabled: !w.enabled } : w)),
    };
    void saveConfig(updated);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-16">
      <Card className="relative w-full max-w-[540px] max-h-[80vh] overflow-y-auto">
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="inline-flex items-center gap-2 text-base">
              <Settings size={18} /> Server Settings
            </h2>
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>
              <X size={16} />
            </Button>
          </div>
        </CardHeader>

        <CardContent>
          {error ? <p className="mb-3 text-[0.85rem] text-red-300">{error}</p> : null}

          {config ? (
            <div className="grid gap-4">
              {/* Notification Settings (collapsible) */}
              <section>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-[0.9rem] font-semibold"
                  onClick={() => setShowNotificationSettings(!showNotificationSettings)}
                >
                  {showNotificationSettings ? (
                    <ChevronDown size={16} />
                  ) : (
                    <ChevronRight size={16} />
                  )}
                  Notification Settings
                </button>
                {showNotificationSettings ? (
                  <div className="mt-2 grid gap-4">
                    <section className="grid gap-3">
                      <h3 className="text-[0.9rem] font-semibold">Telegram</h3>

                      <label className="grid gap-1 text-[0.84rem]">
                        <span className="text-[#afc0d5]">Chat ID</span>
                        <Input
                          value={config.telegram.chatId}
                          onChange={(e) => {
                            const updated = {
                              ...config,
                              telegram: { ...config.telegram, chatId: e.target.value },
                            };
                            setConfig(updated);
                          }}
                          onBlur={(e) => {
                            const updated = {
                              ...config,
                              telegram: { ...config.telegram, chatId: e.target.value },
                            };
                            setConfig(updated);
                            void saveConfig(updated);
                          }}
                          placeholder="e.g. 123456789"
                        />
                      </label>

                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-2 text-[0.84rem]">
                          <input
                            type="checkbox"
                            checked={config.telegram.enabled}
                            onChange={() => {
                              const updated = {
                                ...config,
                                telegram: { ...config.telegram, enabled: !config.telegram.enabled },
                              };
                              void saveConfig(updated);
                            }}
                            className="accent-blue-500"
                          />
                          Enable notifications
                        </label>

                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => void sendTest()}
                        >
                          <Send size={14} />
                          {testStatus === 'sending'
                            ? 'Sending...'
                            : testStatus === 'success'
                              ? 'Sent!'
                              : testStatus === 'error'
                                ? 'Failed'
                                : 'Test'}
                        </Button>
                      </div>
                    </section>

                    <Separator />

                    <section className="grid gap-3">
                      <h3 className="text-[0.9rem] font-semibold">Wallets</h3>

                      {config.wallets.length > 0 ? (
                        <ul className="grid gap-2">
                          {config.wallets.map((w, i) => (
                            <li
                              key={`${w.address}-${i}`}
                              className="flex items-center gap-2 rounded-[10px] border border-[rgba(168,191,217,0.2)] bg-[rgba(12,24,38,0.6)] px-3 py-2 text-[0.84rem]"
                            >
                              <input
                                type="checkbox"
                                checked={w.enabled}
                                onChange={() => toggleWallet(i)}
                                className="accent-blue-500"
                              />
                              <div className="min-w-0 flex-1">
                                {w.label ? <span className="font-semibold">{w.label} </span> : null}
                                <span className="break-all font-mono text-[0.78rem] text-[#9fb1c7]">
                                  {w.address}
                                </span>
                              </div>
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={() => removeWallet(i)}
                              >
                                <Trash2 size={14} />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[0.84rem] text-[#9fb1c7]">No wallets configured.</p>
                      )}

                      <div className="flex flex-wrap gap-2">
                        <Input
                          value={newWalletAddress}
                          onChange={(e) => setNewWalletAddress(e.target.value)}
                          placeholder="0x..."
                          className="min-w-[200px] flex-1"
                        />
                        <Input
                          value={newWalletLabel}
                          onChange={(e) => setNewWalletLabel(e.target.value)}
                          placeholder="Label (optional)"
                          className="w-[140px]"
                        />
                        <Button type="button" variant="secondary" size="sm" onClick={addWallet}>
                          <Plus size={14} /> Add
                        </Button>
                      </div>
                    </section>
                  </div>
                ) : null}
              </section>

              <Separator />

              {/* Watchdog Settings (collapsible) */}
              <section>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-[0.9rem] font-semibold"
                  onClick={() => setShowWatchdog(!showWatchdog)}
                >
                  {showWatchdog ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  Watchdog
                </button>
                {showWatchdog ? (
                  <div className="mt-2 grid gap-3">
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-[0.84rem]">
                        <input
                          type="checkbox"
                          checked={config.watchdog.enabled}
                          onChange={() => {
                            const updated = {
                              ...config,
                              watchdog: {
                                ...config.watchdog,
                                enabled: !config.watchdog.enabled,
                              },
                            };
                            void saveConfig(updated);
                          }}
                          className="accent-blue-500"
                        />
                        Enable watchdog
                      </label>
                      <label className="flex items-center gap-2 text-[0.84rem]">
                        <input
                          type="checkbox"
                          checked={config.watchdog.dryRun}
                          onChange={() => {
                            const updated = {
                              ...config,
                              watchdog: {
                                ...config.watchdog,
                                dryRun: !config.watchdog.dryRun,
                              },
                            };
                            void saveConfig(updated);
                          }}
                          className="accent-blue-500"
                        />
                        Dry run mode
                      </label>
                    </div>

                    {!config.watchdog.dryRun ? (
                      <p className="text-[0.79rem] text-[#f3d194]">
                        Live mode requires WATCHDOG_PRIVATE_KEY on the server.
                      </p>
                    ) : null}

                    <label className="grid gap-1 text-[0.84rem]">
                      <span className="text-[#afc0d5]">Trigger HF</span>
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={config.watchdog.triggerHF}
                        onChange={(e) => {
                          const updated = {
                            ...config,
                            watchdog: {
                              ...config.watchdog,
                              triggerHF: Number(e.target.value),
                            },
                          };
                          setConfig(updated);
                        }}
                        onBlur={(e) => {
                          const updated = {
                            ...config,
                            watchdog: {
                              ...config.watchdog,
                              triggerHF: Number(e.target.value),
                            },
                          };
                          void saveConfig(updated);
                        }}
                        className="w-[120px]"
                      />
                    </label>

                    <label className="grid gap-1 text-[0.84rem]">
                      <span className="text-[#afc0d5]">Target HF</span>
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={config.watchdog.targetHF}
                        onChange={(e) => {
                          const updated = {
                            ...config,
                            watchdog: {
                              ...config.watchdog,
                              targetHF: Number(e.target.value),
                            },
                          };
                          setConfig(updated);
                        }}
                        onBlur={(e) => {
                          const updated = {
                            ...config,
                            watchdog: {
                              ...config.watchdog,
                              targetHF: Number(e.target.value),
                            },
                          };
                          void saveConfig(updated);
                        }}
                        className="w-[120px]"
                      />
                    </label>

                    <label className="grid gap-1 text-[0.84rem]">
                      <span className="text-[#afc0d5]">Action cooldown (minutes)</span>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={Math.round(config.watchdog.cooldownMs / 60_000)}
                        onChange={(e) => {
                          const updated = {
                            ...config,
                            watchdog: {
                              ...config.watchdog,
                              cooldownMs: Number(e.target.value) * 60_000,
                            },
                          };
                          setConfig(updated);
                        }}
                        onBlur={(e) => {
                          const updated = {
                            ...config,
                            watchdog: {
                              ...config.watchdog,
                              cooldownMs: Number(e.target.value) * 60_000,
                            },
                          };
                          void saveConfig(updated);
                        }}
                        className="w-[120px]"
                      />
                    </label>

                    <label className="grid gap-1 text-[0.84rem]">
                      <span className="text-[#afc0d5]">Max repay per action (USD)</span>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={Math.round(config.watchdog.maxRepayUsd)}
                        onChange={(e) => {
                          const updated = {
                            ...config,
                            watchdog: {
                              ...config.watchdog,
                              maxRepayUsd: Number(e.target.value),
                            },
                          };
                          setConfig(updated);
                        }}
                        onBlur={(e) => {
                          const updated = {
                            ...config,
                            watchdog: {
                              ...config.watchdog,
                              maxRepayUsd: Number(e.target.value),
                            },
                          };
                          void saveConfig(updated);
                        }}
                        className="w-[120px]"
                      />
                    </label>

                    <label className="grid gap-1 text-[0.84rem]">
                      <span className="text-[#afc0d5]">Max gas (gwei)</span>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={Math.round(config.watchdog.maxGasGwei)}
                        onChange={(e) => {
                          const updated = {
                            ...config,
                            watchdog: {
                              ...config.watchdog,
                              maxGasGwei: Number(e.target.value),
                            },
                          };
                          setConfig(updated);
                        }}
                        onBlur={(e) => {
                          const updated = {
                            ...config,
                            watchdog: {
                              ...config.watchdog,
                              maxGasGwei: Number(e.target.value),
                            },
                          };
                          void saveConfig(updated);
                        }}
                        className="w-[120px]"
                      />
                    </label>
                  </div>
                ) : null}
              </section>

              <Separator />

              {/* Zone Thresholds (collapsible) */}
              <section>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-[0.9rem] font-semibold"
                  onClick={() => setShowZones(!showZones)}
                >
                  {showZones ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  Zone Thresholds
                </button>
                {showZones ? (
                  <div className="mt-2 grid gap-2">
                    {config.zones.map((zone, i) => (
                      <div key={zone.name} className="flex items-center gap-2 text-[0.84rem]">
                        <span className="w-[70px] font-semibold capitalize">{zone.name}</span>
                        <Input
                          type="number"
                          step="0.05"
                          value={zone.minHF}
                          onChange={(e) => {
                            const value = Number(e.target.value);
                            const zones = [...config.zones];
                            zones[i] = { ...zone, minHF: value };
                            setConfig({ ...config, zones });
                          }}
                          onBlur={(e) => {
                            const value = Number(e.target.value);
                            const zones = [...config.zones];
                            zones[i] = { ...zone, minHF: value };
                            void saveConfig({ ...config, zones });
                          }}
                          className="w-[80px]"
                        />
                        <span className="text-[#9fb1c7]">to</span>
                        <span className="text-[#9fb1c7]">
                          {Number.isFinite(zone.maxHF) ? zone.maxHF : '∞'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>

              <Separator />

              {/* Polling Settings (collapsible) */}
              <section>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-[0.9rem] font-semibold"
                  onClick={() => setShowPolling(!showPolling)}
                >
                  {showPolling ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  Polling Settings
                </button>
                {showPolling ? (
                  <div className="mt-2 grid gap-3">
                    <label className="grid gap-1 text-[0.84rem]">
                      <span className="text-[#afc0d5]">Polling interval (minutes)</span>
                      <Input
                        type="number"
                        min="1"
                        value={Math.round(config.polling.intervalMs / 60_000)}
                        onChange={(e) => {
                          const updated = {
                            ...config,
                            polling: {
                              ...config.polling,
                              intervalMs: Number(e.target.value) * 60_000,
                            },
                          };
                          setConfig(updated);
                        }}
                        onBlur={() => void saveConfig(config)}
                        className="w-[100px]"
                      />
                    </label>
                    <label className="grid gap-1 text-[0.84rem]">
                      <span className="text-[#afc0d5]">Debounce checks</span>
                      <Input
                        type="number"
                        min="1"
                        value={config.polling.debounceChecks}
                        onChange={(e) => {
                          const updated = {
                            ...config,
                            polling: {
                              ...config.polling,
                              debounceChecks: Number(e.target.value),
                            },
                          };
                          setConfig(updated);
                        }}
                        onBlur={() => void saveConfig(config)}
                        className="w-[100px]"
                      />
                    </label>
                    <label className="grid gap-1 text-[0.84rem]">
                      <span className="text-[#afc0d5]">Reminder interval (minutes)</span>
                      <Input
                        type="number"
                        min="1"
                        value={Math.round(config.polling.reminderIntervalMs / 60_000)}
                        onChange={(e) => {
                          const updated = {
                            ...config,
                            polling: {
                              ...config.polling,
                              reminderIntervalMs: Number(e.target.value) * 60_000,
                            },
                          };
                          setConfig(updated);
                        }}
                        onBlur={() => void saveConfig(config)}
                        className="w-[100px]"
                      />
                    </label>
                    <label className="grid gap-1 text-[0.84rem]">
                      <span className="text-[#afc0d5]">Recovery cooldown (minutes)</span>
                      <Input
                        type="number"
                        min="1"
                        value={Math.round(config.polling.cooldownMs / 60_000)}
                        onChange={(e) => {
                          const updated = {
                            ...config,
                            polling: {
                              ...config.polling,
                              cooldownMs: Number(e.target.value) * 60_000,
                            },
                          };
                          setConfig(updated);
                        }}
                        onBlur={() => void saveConfig(config)}
                        className="w-[100px]"
                      />
                    </label>
                  </div>
                ) : null}
              </section>
            </div>
          ) : (
            <p className="text-[0.84rem] text-[#9fb1c7]">Loading configuration...</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
