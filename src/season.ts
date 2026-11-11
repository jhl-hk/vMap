export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export const SEASON_NAME: Record<Season, string> = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };

/** Beijing wall-clock time, whatever the device timezone. */
export function beijingNow(): { month: number; hour: number; minute: number } {
  const d = new Date(Date.now() + 8 * 3600_000);
  return { month: d.getUTCMonth() + 1, hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

export function seasonOf(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

/**
 * Light at a given hour: multiply colour and strength (0 day .. 1 deep night).
 * Beijing sunrise/sunset drift between ~5:00/19:40 (June) and ~7:30/17:00 (December).
 */
export function daylight(hour: number, minute: number, month: number): { tint: [number, number, number]; night: number } {
  const t = hour + minute / 60;
  const summer = Math.cos(((month - 6.5) / 12) * Math.PI * 2) * 0.5 + 0.5; // 1 in June/July, 0 in Dec/Jan
  const rise = 7.3 - summer * 2.3;
  const set = 17.1 + summer * 2.6;
  let night: number;
  if (t < rise - 1 || t > set + 1) night = 1;
  else if (t < rise + 0.5) night = (rise + 0.5 - t) / 1.5;
  else if (t > set - 0.5) night = (t - (set - 0.5)) / 1.5;
  else night = 0;
  night = Math.max(0, Math.min(1, night));
  // golden hour tint near sunrise and sunset, deep blue at night
  const dusk = Math.max(0, 1 - Math.abs(night - 0.4) / 0.4) * (night < 1 ? 1 : 0);
  const tint: [number, number, number] = [
    255 - night * 165 + dusk * 30,
    255 - night * 150 - dusk * 20,
    255 - night * 95 - dusk * 60,
  ];
  return { tint: tint.map((v) => Math.max(0, Math.min(255, v))) as [number, number, number], night };
}
