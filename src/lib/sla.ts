import "server-only";
import { sql } from "drizzle-orm";
import { db, ts } from "@/db";
import { WIB } from "@/lib/time";

/**
 * Angka untuk dashboard SLA - dipakai peran "sla" dan leader.
 *
 * Aturan yang dipegang, sama seperti section 8:
 *   - Kalau memakai rata-rata waktu, pakai MEDIAN. Satu tiket nyangkut
 *     semalaman merusak rata-rata dan membuat hari normal terlihat buruk.
 *     Atas permintaan pemilik, median hanya tersisa di tabel per grup;
 *     ringkasan periode cukup memakai hitungan dan persentase.
 *   - Tiket not_for_us TIDAK dihitung di mana pun.
 *   - Target SLA dibaca dari kolom tiket (yang disalin saat dibuat, section 4.4),
 *     bukan dari setelan saat ini. Mengubah target hari ini tidak boleh
 *     mengubah penilaian tiket bulan lalu.
 *
 * TIDAK ADA satu pun angka per agen di berkas ini, dan itu disengaja: peran
 * "sla" memantau kesehatan layanan, bukan menilai orang (section 1, section 10).
 */

const rows = <T>(x: unknown): T[] => x as unknown as T[];
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const maybeNum = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

export type RingkasanSla = {
  tiket: number;
  open: number;
  progress: number;
  closed: number;
  terjawab: number;
  belumTerjawab: number;
  lewatBalas: number;
  tuntas: number;
  lewatTuntas: number;
};

export async function ringkasanSla(since: Date): Promise<RingkasanSla> {
  const [tiket] = await Promise.all([
    db.execute(sql`
      SELECT
        count(*) FILTER (WHERE status <> 'not_for_us')::int AS tiket,
        count(*) FILTER (WHERE status = 'open')::int        AS open,
        count(*) FILTER (WHERE status = 'on_progress')::int AS progress,
        count(*) FILTER (WHERE status = 'closed')::int      AS closed,
        count(*) FILTER (WHERE status <> 'not_for_us' AND first_response_at IS NOT NULL)::int AS terjawab,
        count(*) FILTER (WHERE status <> 'not_for_us' AND first_response_at IS NULL)::int AS belum,
        count(*) FILTER (
          WHERE status <> 'not_for_us'
            AND coalesce(first_response_at, now()) - triggered_at
                > make_interval(mins => sla_target_fr_min)
        )::int AS lewat_balas,
        count(*) FILTER (WHERE status <> 'not_for_us' AND resolved_at IS NOT NULL)::int AS tuntas,
        count(*) FILTER (
          WHERE status <> 'not_for_us'
            AND coalesce(resolved_at, now()) - triggered_at
                > make_interval(mins => sla_target_res_min)
        )::int AS lewat_tuntas
      FROM tickets WHERE triggered_at >= ${ts(since)}
    `),
  ]);

  const t = rows<Record<string, unknown>>(tiket)[0] ?? {};

  return {
    tiket: num(t.tiket),
    open: num(t.open),
    progress: num(t.progress),
    closed: num(t.closed),
    terjawab: num(t.terjawab),
    belumTerjawab: num(t.belum),
    lewatBalas: num(t.lewat_balas),
    tuntas: num(t.tuntas),
    lewatTuntas: num(t.lewat_tuntas),
  };
}

export type SlaGrup = {
  jid: string;
  nama: string;
  label: string | null;
  tiket: number;
  /** dari tiket periode ini, berapa yang MASIH berstatus open sekarang. */
  masihOpen: number;
  lewatBalas: number;
  medianBalasSec: number | null;
};

/**
 * Per grup/klien - ini yang paling berguna bagi pemantau: menunjukkan KLIEN
 * mana yang layanannya memburuk, tanpa menyebut satu pun nama agen.
 */
export async function slaPerGrup(since: Date, limit = 20): Promise<SlaGrup[]> {
  return rows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        g.jid,
        coalesce(g.name, g.jid) AS nama,
        g.client_label AS label,
        count(t.id)::int AS tiket,
        count(t.id) FILTER (WHERE t.status = 'open')::int AS masih_open,
        count(t.id) FILTER (
          WHERE coalesce(t.first_response_at, now()) - t.triggered_at
                > make_interval(mins => t.sla_target_fr_min)
        )::int AS lewat_balas,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (t.first_response_at - t.triggered_at))
        ) FILTER (WHERE t.first_response_at IS NOT NULL) AS median_balas
      FROM tickets t
      JOIN groups g ON g.jid = t.group_jid
      WHERE t.triggered_at >= ${ts(since)} AND t.status <> 'not_for_us'
      GROUP BY g.jid
      ORDER BY count(t.id) DESC
      LIMIT ${limit}
    `),
  ).map((r) => ({
    jid: String(r.jid),
    nama: String(r.nama),
    label: (r.label as string) ?? null,
    tiket: num(r.tiket),
    masihOpen: num(r.masih_open),
    lewatBalas: num(r.lewat_balas),
    medianBalasSec: maybeNum(r.median_balas),
  }));
}

/** Volume tiket per jam WIB - memperlihatkan kapan antrean menumpuk. */
export async function slaPerJam(since: Date): Promise<{ jam: number; tiket: number }[]> {
  const r = rows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        EXTRACT(HOUR FROM (triggered_at AT TIME ZONE ${WIB}))::int AS jam,
        count(*)::int AS tiket
      FROM tickets
      WHERE triggered_at >= ${ts(since)} AND status <> 'not_for_us'
      GROUP BY 1 ORDER BY 1
    `),
  );
  const map = new Map(r.map((x) => [num(x.jam), num(x.tiket)]));
  return Array.from({ length: 24 }, (_, jam) => ({ jam, tiket: map.get(jam) ?? 0 }));
}

/**
 * Keadaan antrean sekarang, plus waktu respon khas pada periode terpilih.
 *
 * responSec memakai MEDIAN, bukan mean - section 8 melarang rata-rata untuk ini, dan
 * alasannya kelihatan langsung di data uji: satu tiket menganggur 2 jam sudah
 * cukup menaikkan mean sampai hari yang normal terlihat buruk. Labelnya di
 * layar tetap "Rata-rata respon" sesuai permintaan pemilik.
 */
export async function antreanSekarang(since: Date) {
  const r = rows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'open')::int AS open,
        count(*) FILTER (WHERE status = 'on_progress')::int AS progress,
        count(*) FILTER (
          WHERE status IN ('open','on_progress')
            AND first_response_at IS NULL
            AND now() - triggered_at > make_interval(mins => sla_target_fr_min)
        )::int AS lewat,
        (
          SELECT percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (first_response_at - triggered_at))
          )
          FROM tickets p
          WHERE p.status <> 'not_for_us'
            AND p.first_response_at IS NOT NULL
            AND p.triggered_at >= ${ts(since)}
        ) AS respon_sec
      FROM tickets
    `),
  )[0];

  return {
    open: num(r?.open),
    progress: num(r?.progress),
    lewat: num(r?.lewat),
    responSec: maybeNum(r?.respon_sec),
  };
}

export const persen = (bagian: number, total: number): number =>
  total > 0 ? Math.round((bagian / total) * 100) : 0;
