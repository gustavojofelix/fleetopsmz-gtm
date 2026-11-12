const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Creates a unique run ID such as 2026-11-12T1840Z_k3f9a2 (UTC time plus random suffix). */
export function createRunId(now: Date, random: () => number = Math.random): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += ALPHABET[Math.min(ALPHABET.length - 1, Math.floor(random() * ALPHABET.length))];
  }
  return `${stamp}_${suffix}`;
}
