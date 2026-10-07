/**
 * Setelan sistem - SPEC section 11, dengan jejak audit wajib (section 4.6).
 *
 * "Target SLA yang diubah diam-diam bisa mengubah makna seluruh laporan."
 * Karena itu tidak ada jalan tulis ke tabel settings selain lewat
 * writeSetting(), dan writeSetting() selalu menulis settings_audit.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { settings, settingsAudit } from "@/db/schema";

/**
 * Bentuk setelan ditulis eksplisit, bukan diturunkan dari `as const`.
 * Dengan `as const`, tipe tiap nilai menyempit jadi literal (mis. `5`), sehingga
 * writeSetting("ops.undo_seconds", 7) ditolak compiler - padahal justru itu
 * gunanya halaman setelan.
 */
export type SettingsShape = {
  "sla.first_response_min": number;
  "sla.resolution_min": number;
  "sla.warn_threshold_pct": number;
  "trigger.mention_creates_ticket": boolean;
  "trigger.reply_creates_ticket": boolean;
  /**
   * Chat pribadi (bukan grup) ikut disimpan atau tidak.
   *
   * Bawaannya MATI, dan itu keputusan sadar: satu nomor WhatsApp membawa
   * seluruh percakapan pribadi pemiliknya. Menyalakannya berarti isi chat
   * keluarga dan teman ikut masuk database tim. Yang menyalakan harus manusia
   * yang tahu konsekuensinya, bukan nilai bawaan.
   */
  "ingest.dm_enabled": boolean;
  /** Kalau chat pribadi disimpan: tiap pesan masuk bikin tiket atau tidak. */
  "trigger.dm_creates_ticket": boolean;
  /** section 6.9 jendela penggabungan pesan susulan, dalam menit. 0 = matikan. */
  "ticket.merge_window_min": number;
  "ops.auto_release_min": number;
  "ops.undo_seconds": number;
  "ops.session_idle_min": number;
  /** section 6.7 kalimat balasan penahan, dipakai kalau kotak balas kosong. */
  "ops.on_check_text": string;
  /** Menyimpang dari section 4.1 kalau dinyalakan - lihat catatan di ensureGroup(). */
  "ops.auto_monitor_new_groups": boolean;
  "signature.prefix": string;
  "signature.auto_insert": boolean;
  "signature.lenient_match": boolean;
  "gateway.alert_after_min": number;
  "gateway.quiet_alert_min": number;
  "gateway.busy_hours": [number, number];
  "access.ip_allowlist": string[];
};

export const SETTING_DEFAULTS: SettingsShape = {
  /* ---- SLA (section 8) ---- */
  "sla.first_response_min": 15,
  "sla.resolution_min": 120,
  /** ambang peringatan, persen dari target. */
  "sla.warn_threshold_pct": 80,

  /* ---- pemicu tiket (section 6.1) ---- */
  "trigger.mention_creates_ticket": true,
  "trigger.reply_creates_ticket": true,
  /* Lihat catatan panjang di SettingsShape. Jangan diubah jadi true tanpa
     pemiliknya sendiri yang memutuskan. */
  "ingest.dm_enabled": false,
  /* Di chat pribadi tidak ada mention - tiap pesan masuk memang ditujukan ke
     kita. Jadi begitu chat pribadi dinyalakan, tiket dibuat apa adanya. */
  "trigger.dm_creates_ticket": true,
  /* section 6.9 (penyimpangan dari section 4.4, diminta pemilik).
     Orang yang sama menyapa dua kali sebelum dibalas = SATU permintaan, bukan dua.
     Jendelanya dibatasi supaya tiket yang menganggur seharian tidak menelan
     pertanyaan baru yang tidak ada hubungannya - lihat findMergeTarget(). */
  "ticket.merge_window_min": 120,

  /* ---- operasional (section 6.3, 9.4) ---- */
  /** section 6.3 auto-release: on_progress kembali ke open setelah agen diam sekian menit. */
  "ops.auto_release_min": 10,
  /** section 9.4 undo sungguhan: pesan ditahan di server selama ini. */
  "ops.undo_seconds": 5,
  /** sesi dianggap tidak aktif setelah sekian menit tanpa heartbeat. */
  "ops.session_idle_min": 15,
  /* section 6.7 "on check" adalah balasan penahan - isinya kalimat yang sama terus.
     Disimpan di setelan supaya satu klik cukup, dan supaya seluruh tim memakai
     kalimat yang sama di depan klien. */
  "ops.on_check_text": "Baik, kami cek dulu ya. Mohon ditunggu.",
  /* section 4.1 mengharuskan default FALSE: grup diaktifkan manual oleh leader.
     Default di sini tetap mengikuti spesifikasi. Pemilik boleh menyalakannya,
     dan itu keputusan sadar - bukan bawaan yang tidak sengaja aktif. */
  "ops.auto_monitor_new_groups": false,

  /* ---- tanda tangan (section 11) ---- */
  "signature.prefix": "#dsp",
  "signature.auto_insert": true,
  /** huruf besar-kecil bebas, spasi bebas. */
  "signature.lenient_match": true,

  /* ---- gateway & alarm (section 15) ---- */
  "gateway.alert_after_min": 3,
  /** section 15 "sepi beneran vs sepi karena rusak": alarm kalau tidak ada pesan masuk
   *  selama sekian menit pada jam ramai. */
  "gateway.quiet_alert_min": 45,
  "gateway.busy_hours": [8, 21],

  /* ---- akses (section 2.2) ---- */
  /** daftar CIDR / IP kantor. Kosong = tidak dibatasi (hanya untuk pengembangan). */
  "access.ip_allowlist": [],
};

export type SettingKey = keyof SettingsShape;
export type SettingValue<K extends SettingKey> = SettingsShape[K];

type CacheEntry = { value: unknown; at: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 5_000;

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as SettingValue<K>;

  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  const value = (rows[0]?.value ?? SETTING_DEFAULTS[key]) as SettingValue<K>;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function getSettings<K extends SettingKey>(
  keys: readonly K[],
): Promise<{ [P in K]: SettingValue<P> }> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, keys as unknown as string[]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as { [P in K]: SettingValue<P> };
  for (const k of keys) {
    out[k] = (byKey.get(k) ?? SETTING_DEFAULTS[k]) as SettingValue<typeof k>;
  }
  return out;
}

/** Semua setelan sekaligus - untuk halaman setelan. */
export async function getAllSettings(): Promise<Record<SettingKey, unknown>> {
  const rows = await db.select().from(settings);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<SettingKey, unknown>;
  for (const k of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
    out[k] = byKey.get(k) ?? SETTING_DEFAULTS[k];
  }
  return out;
}

/**
 * Satu-satunya jalan menulis setelan. Selalu mencatat nilai lama -> nilai baru.
 * Tanpa ini, angka SLA di laporan lama tidak bisa dipertanggungjawabkan.
 */
export async function writeSetting<K extends SettingKey>(
  key: K,
  value: SettingValue<K>,
  changedBy: number | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const prev = await tx.select().from(settings).where(eq(settings.key, key)).limit(1);
    const fromValue = prev[0]?.value ?? SETTING_DEFAULTS[key];

    if (JSON.stringify(fromValue) === JSON.stringify(value)) return;

    await tx
      .insert(settings)
      .values({ key, value: value as unknown as object, updatedBy: changedBy })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: value as unknown as object, updatedAt: new Date(), updatedBy: changedBy },
      });

    await tx.insert(settingsAudit).values({
      key,
      fromValue: fromValue as unknown as object,
      toValue: value as unknown as object,
      changedBy,
    });
  });

  cache.delete(key);
}

export function invalidateSettingsCache(): void {
  cache.clear();
}
