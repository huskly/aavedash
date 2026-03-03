export type ZoneName = 'safe' | 'watch' | 'alert' | 'action' | 'critical';

export type Zone = {
  name: ZoneName;
  emoji: string;
  label: string;
  minHF: number;
  maxHF: number;
  action: string;
};

export const DEFAULT_ZONES: Zone[] = [
  {
    name: 'safe',
    emoji: '\u{1F7E2}',
    label: 'SAFE',
    minHF: 2.0,
    maxHF: Infinity,
    action: 'No action',
  },
  {
    name: 'watch',
    emoji: '\u{1F7E1}',
    label: 'WATCH',
    minHF: 1.5,
    maxHF: 2.0,
    action: 'Monitor closely',
  },
  {
    name: 'alert',
    emoji: '\u{1F7E0}',
    label: 'ALERT',
    minHF: 1.25,
    maxHF: 1.5,
    action: 'Prepare to act',
  },
  {
    name: 'action',
    emoji: '\u{1F534}',
    label: 'ACTION',
    minHF: 1.1,
    maxHF: 1.25,
    action: 'Repay immediately',
  },
  {
    name: 'critical',
    emoji: '\u{1F6A8}',
    label: 'CRITICAL',
    minHF: 0,
    maxHF: 1.1,
    action: 'Emergency repay / add collateral NOW',
  },
];

export function classifyZone(healthFactor: number, zones: Zone[] = DEFAULT_ZONES): Zone {
  if (!Number.isFinite(healthFactor) || healthFactor <= 0) {
    return zones.find((z) => z.name === 'critical') ?? zones[zones.length - 1]!;
  }

  for (const zone of zones) {
    const maxHF = zone.maxHF ?? Infinity;
    if (healthFactor >= zone.minHF && healthFactor < maxHF) {
      return zone;
    }
  }

  if (healthFactor >= (zones[0]?.maxHF ?? Infinity)) {
    return zones[0]!;
  }

  return zones[zones.length - 1]!;
}

const ZONE_SEVERITY: Record<ZoneName, number> = {
  safe: 0,
  watch: 1,
  alert: 2,
  action: 3,
  critical: 4,
};

export function isWorsening(from: ZoneName, to: ZoneName): boolean {
  return (ZONE_SEVERITY[to] ?? 0) > (ZONE_SEVERITY[from] ?? 0);
}

export function isImproving(from: ZoneName, to: ZoneName): boolean {
  return (ZONE_SEVERITY[to] ?? 0) < (ZONE_SEVERITY[from] ?? 0);
}
