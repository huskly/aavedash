import { useCallback, useRef } from 'react';
import type { ZoneName } from '@aave-monitor/core';
import { Slider, SliderThumb } from './ui/slider';

type ZoneEntry = {
  name: ZoneName;
  minHF: number;
  maxHF: number;
};

type ZoneSliderProps = {
  /** Zones ordered from highest (safe) to lowest (critical) */
  zones: ZoneEntry[];
  onChange: (zones: ZoneEntry[]) => void;
  onCommit: (zones: ZoneEntry[]) => void;
};

const MIN = 0.5;
const MAX = 3.0;
const STEP = 0.05;

// Colors from safe (top) to critical (bottom)
const ZONE_COLORS: Record<string, string> = {
  safe: '#16a34a',
  comfort: '#22c55e',
  watch: '#eab308',
  alert: '#f59e0b',
  action: '#ef4444',
  critical: '#dc2626',
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * Extracts the 5 boundary values from the 6 contiguous zones.
 * Zones are ordered safe→critical (descending minHF).
 * Boundaries returned in ascending order:
 *   [critical/action, action/alert, alert/watch, watch/comfort, comfort/safe]
 */
function zonesToBoundaries(zones: ZoneEntry[]): number[] {
  // zones[0]=safe, zones[1]=comfort, ..., zones[5]=critical
  // boundary between zones[i] and zones[i+1] = zones[i].minHF = zones[i+1].maxHF (when finite)
  // We want ascending order, so reverse
  const boundaries: number[] = [];
  for (let i = zones.length - 1; i >= 1; i--) {
    boundaries.push(zones[i]!.maxHF);
  }
  return boundaries.map((v) => (Number.isFinite(v) ? v : MAX));
}

function boundariesToZones(boundaries: number[], zones: ZoneEntry[]): ZoneEntry[] {
  // boundaries are in ascending order: [b0, b1, b2, b3, b4]
  // zones[0]=safe:     minHF=b4, maxHF=Infinity
  // zones[1]=comfort:  minHF=b3, maxHF=b4
  // zones[2]=watch:    minHF=b2, maxHF=b3
  // zones[3]=alert:    minHF=b1, maxHF=b2
  // zones[4]=action:   minHF=b0, maxHF=b1
  // zones[5]=critical: minHF=0,  maxHF=b0
  const n = zones.length;
  const bLen = boundaries.length; // n-1
  return zones.map((z, i) => {
    if (i === 0) {
      return { ...z, minHF: boundaries[bLen - 1]!, maxHF: Infinity };
    }
    if (i === n - 1) {
      return { ...z, minHF: 0, maxHF: boundaries[0]! };
    }
    const upper = boundaries[bLen - i]!;
    const lower = boundaries[bLen - 1 - i]!;
    return { ...z, minHF: lower, maxHF: upper };
  });
}

export function ZoneSlider({ zones, onChange, onCommit }: ZoneSliderProps) {
  const boundaries = zonesToBoundaries(zones);
  const commitRef = useRef(zones);

  const handleValueChange = useCallback(
    (raw: number[]) => {
      const clamped = raw.map((v) => round2(Math.min(MAX, Math.max(MIN, v ?? MIN))));
      const updated = boundariesToZones(clamped, zones);
      commitRef.current = updated;
      onChange(updated);
    },
    [zones, onChange],
  );

  const handleValueCommit = useCallback(() => {
    onCommit(commitRef.current);
  }, [onCommit]);

  // Tick marks
  const ticks = [];
  for (let v = MIN; v <= MAX; v += 0.5) {
    const pct = ((v - MIN) / (MAX - MIN)) * 100;
    ticks.push(
      <div key={v} className="absolute" style={{ left: `${pct}%` }}>
        <div className="h-2 w-px bg-[rgba(168,191,217,0.3)]" />
        <span className="absolute left-1/2 mt-0.5 -translate-x-1/2 text-[0.65rem] text-[#6b7f96]">
          {v.toFixed(1)}
        </span>
      </div>,
    );
  }

  // Zone labels positioned between boundaries
  const allPoints = [MIN, ...boundaries, MAX];
  const zoneSegments = [...zones].reverse(); // critical→safe (ascending order)

  return (
    <div className="grid gap-2">
      {/* Zone color bar */}
      <div className="flex h-4 overflow-hidden rounded-full">
        {zoneSegments.map((z, i) => {
          const lo = allPoints[i]!;
          const hi = allPoints[i + 1]!;
          const pct = ((hi - lo) / (MAX - MIN)) * 100;
          return (
            <div
              key={z.name}
              className="flex items-center justify-center overflow-hidden text-[0.6rem] font-semibold uppercase text-white/80"
              style={{
                width: `${pct}%`,
                backgroundColor: ZONE_COLORS[z.name] ?? '#6b7280',
              }}
              title={`${z.name}: ${lo.toFixed(2)} – ${Number.isFinite(hi) ? hi.toFixed(2) : '∞'}`}
            >
              {pct > 8 ? z.name : ''}
            </div>
          );
        })}
      </div>

      {/* Slider */}
      <div className="relative pb-5">
        <Slider
          min={MIN}
          max={MAX}
          step={STEP}
          minStepsBetweenThumbs={1}
          value={boundaries}
          onValueChange={handleValueChange}
          onValueCommit={handleValueCommit}
        >
          {boundaries.map((val, i) => {
            const lowerZone = zoneSegments[i]!;
            const upperZone = zoneSegments[i + 1]!;
            return (
              <SliderThumb
                key={i}
                className="border-[#9fb1c7]"
                aria-label={`${lowerZone.name}/${upperZone.name} boundary`}
                title={`${val.toFixed(2)}`}
              />
            );
          })}
        </Slider>
        {/* Tick marks */}
        <div className="absolute left-0 right-0 top-[calc(50%+4px)]">{ticks}</div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem]">
        {zones.map((z) => (
          <div key={z.name} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: ZONE_COLORS[z.name] ?? '#6b7280' }}
            />
            <span className="capitalize text-[#afc0d5]">{z.name}</span>
            <span className="text-[#6b7f96]">
              {z.minHF.toFixed(2)}–{Number.isFinite(z.maxHF) ? z.maxHF.toFixed(2) : '∞'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
