import { useCallback, useRef, useState } from 'react';
import { Slider, SliderThumb } from './ui/slider';

type HfSliderProps = {
  triggerHF: number;
  minResultingHF: number;
  targetHF: number;
  onChange: (values: { triggerHF: number; minResultingHF: number; targetHF: number }) => void;
  onCommit: (values: { triggerHF: number; minResultingHF: number; targetHF: number }) => void;
};

const MIN = 1.0;
const MAX = 3.0;
const STEP = 0.01;
// Minimum gap between adjacent thumbs
const GAP = 0.01;

const THUMB_COLORS = {
  trigger: '#ef4444', // red
  minResulting: '#f59e0b', // amber
  target: '#22c55e', // green
} as const;

function clamp(val: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, val));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function HfSlider({
  triggerHF,
  minResultingHF,
  targetHF,
  onChange,
  onCommit,
}: HfSliderProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const commitRef = useRef({ triggerHF, minResultingHF, targetHF });

  const handleValueChange = useCallback(
    (raw: number[]) => {
      // Enforce ordering: trigger < minResulting <= target
      let [t = MIN, m = MIN, g = MIN] = raw;
      t = round2(clamp(t, MIN, MAX));
      g = round2(clamp(g, MIN, MAX));
      m = round2(clamp(m, MIN, MAX));

      // Ensure gaps
      if (m <= t) m = round2(t + GAP);
      if (g < m) g = m;

      const vals = { triggerHF: t, minResultingHF: m, targetHF: g };
      commitRef.current = vals;
      onChange(vals);
    },
    [onChange],
  );

  const handleValueCommit = useCallback(() => {
    onCommit(commitRef.current);
  }, [onCommit]);

  // Tick marks for whole numbers
  const ticks = [];
  for (let v = MIN; v <= MAX; v += 0.5) {
    const pct = ((v - MIN) / (MAX - MIN)) * 100;
    ticks.push(
      <div key={v} className="absolute" style={{ left: `${pct}%` }}>
        <div className="h-2 w-px bg-[rgba(168,191,217,0.3)]" />
        <span className="absolute left-1/2 -translate-x-1/2 mt-0.5 text-[0.65rem] text-[#6b7f96]">
          {v.toFixed(1)}
        </span>
      </div>,
    );
  }

  const thumbs = [
    { idx: 0, label: 'Trigger', value: triggerHF, color: THUMB_COLORS.trigger },
    { idx: 1, label: 'Min resulting', value: minResultingHF, color: THUMB_COLORS.minResulting },
    { idx: 2, label: 'Target', value: targetHF, color: THUMB_COLORS.target },
  ] as const;

  return (
    <div className="grid gap-2">
      {/* Legend */}
      <div className="flex items-center gap-4 text-[0.78rem]">
        {thumbs.map((t) => (
          <div key={t.idx} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: t.color }}
            />
            <span className="text-[#afc0d5]">
              {t.label}: <span className="text-[#e8f2ff] font-medium">{t.value.toFixed(2)}</span>
            </span>
          </div>
        ))}
      </div>

      {/* Slider */}
      <div className="relative pt-2 pb-5">
        <Slider
          min={MIN}
          max={MAX}
          step={STEP}
          minStepsBetweenThumbs={1}
          value={[triggerHF, minResultingHF, targetHF]}
          onValueChange={handleValueChange}
          onValueCommit={handleValueCommit}
        >
          {thumbs.map((t) => (
            <SliderThumb
              key={t.idx}
              style={{
                borderColor: t.color,
                backgroundColor: hovered === t.idx ? t.color : undefined,
              }}
              onPointerEnter={() => setHovered(t.idx)}
              onPointerLeave={() => setHovered(null)}
              aria-label={t.label}
            />
          ))}
        </Slider>
        {/* Tick marks */}
        <div className="absolute left-0 right-0 top-[calc(50%+4px)]">{ticks}</div>
      </div>
    </div>
  );
}
