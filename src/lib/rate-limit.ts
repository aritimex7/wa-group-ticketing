/**
 * Pembatas laju login - mencegah brute-force.
 *
 * Menggunakan Map di memori (sederhana, cukup untuk satu proses).
 * Kalau nanti horizontal-scale, ganti dengan Redis INCR+EXPIRE.
 */
import "server-only";

interface Entry {
  count: number;
  resetAt: number;
}

const store = new Map<string, Entry>();

/**
 * Periksa apakah kunci (IP / username) sudah melebihi batas.
 *
 * @param key  - identifier (IP address atau username)
 * @param max  - percobaan maksimal dalam jendela waktu
 * @param windowMs - jendela waktu dalam milidetik
 */
export function checkRateLimit(
  key: string,
  max = 5,
  windowMs = 60_000,
): { blocked: boolean; remaining: number; retryAfterMs?: number } {
  const now = Date.now();
  const entry = store.get(key);

  // Entri belum ada atau sudah kedaluwarsa
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { blocked: false, remaining: max - 1 };
  }

  entry.count++;

  if (entry.count > max) {
    return { blocked: true, remaining: 0, retryAfterMs: entry.resetAt - now };
  }

  return { blocked: false, remaining: max - entry.count };
}

/**
 * Catat login berhasil - reset counter supaya user yang sudah masuk
 * tidak terkunci saat coba lagi nanti.
 */
export function resetRateLimit(key: string): void {
  store.delete(key);
}

// Bersihkan entri kadaluarsa setiap 5 menit supaya Map tidak membengkak.
if (typeof globalThis !== "undefined") {
  const CLEANUP_INTERVAL = 5 * 60_000;
  const cleanup = () => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  };
  // @ts-expect-error -- simpan referensi supaya tidak dobel di HMR
  if (!globalThis.__rateLimitCleanup) {
    // @ts-expect-error
    globalThis.__rateLimitCleanup = setInterval(cleanup, CLEANUP_INTERVAL);
  }
}
