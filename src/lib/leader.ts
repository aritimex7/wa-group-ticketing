import "server-only";
import { sql } from "drizzle-orm";
import { db, ts } from "@/db";
import { WIB, startOfTodayWib } from "@/lib/time";

/**
 * Angka untuk dashboard leader - SPEC section 10.
 *
 * Dua hal yang dipegang di seluruh berkas ini:
 *
 *   section 8  MEDIAN, bukan rata-rata. "Satu tiket nyangkut semalaman bisa merusak
 *              rata-rata seorang agen yang kerjanya normal."
 *   section 8  Tiket not_for_us TIDAK MASUK perhitungan SLA maupun jumlah tiket.
 *              Satu-satunya tempat ia dihitung adalah notForUsByAgent(), dan di
 *              sana pun disajikan sebagai sinyal untuk ditanya, bukan vonis.
 */

export type Rentang = "hari" | "minggu" | "bulan";

export function sinceOf(r: Rentang): Date {
  const today = startOfTodayWib();
  if (r === "hari") return today;
  const days = r === "minggu" ? 7 : 30;
  return new Date(today.getTime() - days * 86_400_000);
}

const rows = <T>(x: unknown): T[] => x as unknown as T[];
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const maybeNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/* ------------------------------ kondisi sekarang ------------------------------ */

export type QueueSummary = {
  open: number;
  onProgress: number;
  breached: number;
  oldestWaitingMs: number | null;
  oldestTicketId: number | null;
};

export async function queueSummary(): Promise<QueueSummary> {
  const r = rows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'open')::int         AS open,
        count(*) FILTER (WHERE status = 'on_progress')::int  AS on_progress,
        count(*) FILTER (
          WHERE status IN ('open','on_progress')
            AND first_response_at IS NULL
            AND now() - triggered_at > make_interval(mins => sla_target_fr_min)
        )::int AS breached,
        min(triggered_at) FILTER (WHERE status = 'open') AS oldest_at,
        (SELECT id FROM tickets WHERE status = 'open' ORDER BY triggered_at ASC LIMIT 1) AS oldest_id
      FROM tickets
    `),
  )[0];

  return {
    open: num(r?.open),
    onProgress: num(r?.on_progress),
    breached: num(r?.breached),
    oldestWaitingMs: r?.oldest_at ? Date.now() - new Date(r.oldest_at as string).getTime() : null,
    oldestTicketId: r?.oldest_id ? num(r.oldest_id) : null,
  };
}

export type ActiveAgent = { id: number; name: string; shift: string | null; holding: number; lastSeenAt: Date };

/** Siapa yang sedang aktif dan memegang berapa. */
export async function activeAgents(idleMin = 15): Promise<ActiveAgent[]> {
  return rows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT a.id, a.name, a.shift,
             max(s.last_seen_at) AS last_seen_at,
             (SELECT count(*) FROM tickets t WHERE t.claimed_by = a.id AND t.status = 'on_progress')::int AS holding
      FROM agents a
      JOIN sessions s ON s.agent_id = a.id AND s.revoked_at IS NULL
      WHERE a.is_active
        AND s.last_seen_at > now() - make_interval(mins => ${idleMin})
      GROUP BY a.id
      ORDER BY a.name
    `),
  ).map((r) => ({
    id: num(r.id),
    name: String(r.name),
    shift: (r.shift as string) ?? null,
    holding: num(r.holding),
    lastSeenAt: new Date(r.last_seen_at as string),
  }));
}

/* --------------------------------- per agen --------------------------------- */

export type AgentStat = {
  id: number;
  name: string;
  shift: string | null;
  handled: number;
  medianFrSec: number | null;
  medianResSec: number | null;
  breaches: number;
};

/**
 * section 10 rambu tampilan: "Jangan pasang papan peringkat. Begitu diperingkat,
 * agen akan memilih tiket mudah dan menghindari yang rumit."
 *
 * Karena itu urutannya menurut NAMA - bukan menurut angka. Fungsi ini sengaja
 * tidak menyediakan opsi urut berdasarkan performa.
 *
 * CATATAN PENYIMPANGAN: section 10 meminta angka per agen "dipisah per shift", dan
 * dulu memang begitu. Pemilik menghapus shift dari halaman setelan, jadi tidak
 * ada lagi yang bisa mengisinya dan pengelompokannya jadi satu blok kosong.
 * Kolom agents.shift dibiarkan ada di database supaya pemisahan itu bisa
 * dihidupkan lagi tanpa migrasi kalau nanti diperlukan.
 */
export async function perAgent(since: Date): Promise<AgentStat[]> {
  const list = rows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        a.id, a.name, a.shift,
        count(t.id)::int AS handled,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (t.first_response_at - t.triggered_at))
        ) FILTER (WHERE t.first_response_at IS NOT NULL) AS median_fr,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (t.resolved_at - t.triggered_at))
        ) FILTER (WHERE t.resolved_at IS NOT NULL) AS median_res,
        count(t.id) FILTER (
          WHERE t.first_response_at IS NOT NULL
            AND t.first_response_at - t.triggered_at > make_interval(mins => t.sla_target_fr_min)
        )::int AS breaches
      FROM agents a
      LEFT JOIN tickets t
        ON (t.first_responder_id = a.id OR t.resolved_by = a.id)
       AND t.triggered_at >= ${ts(since)}
       AND t.status <> 'not_for_us'
      WHERE a.is_active
      GROUP BY a.id
      ORDER BY a.name
    `),
  ).map((r) => ({
    id: num(r.id),
    name: String(r.name),
    shift: (r.shift as string) ?? null,
    handled: num(r.handled),
    medianFrSec: maybeNum(r.median_fr),
    medianResSec: maybeNum(r.median_res),
    breaches: num(r.breaches),
  }));

  return list;
}

/* ------------------------------ kesehatan data ------------------------------
 * section 10: "bagian yang menentukan angka di atas boleh dipercaya atau tidak".
 */

export type DataHealth = {
  unattributedOut: number;
  totalOut: number;
  bucketIgnored: number;
  bucketNeedsReview: number;
  bucketUnreviewed: number;
  sendFailed: number;
  gatewayDownSec: number;
  parseGapLid: number;
};

export async function dataHealth(since: Date): Promise<DataHealth> {
  const [out, bucket, failed, down, lidGap] = await Promise.all([
    db.execute(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE agent_id IS NULL AND signature_code IS NULL)::int AS unattributed
      FROM messages WHERE direction = 'out' AND created_at >= ${ts(since)}
    `),
    db.execute(sql`
      SELECT
        count(*) FILTER (WHERE kind = 'ignored')::int      AS ignored,
        count(*) FILTER (WHERE kind = 'needs_review')::int AS needs_review,
        count(*) FILTER (WHERE reviewed_at IS NULL)::int   AS unreviewed
      FROM triage_bucket WHERE created_at >= ${ts(since)}
    `),
    db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE status = 'failed' AND created_at >= ${ts(since)}`),
    db.execute(sql`
      WITH ev AS (
        SELECT state, created_at, lead(created_at) OVER (ORDER BY created_at) AS next_at
        FROM gateway_events WHERE created_at >= ${ts(since)}
      )
      SELECT coalesce(sum(EXTRACT(EPOCH FROM (coalesce(next_at, now()) - created_at))), 0) AS secs
      FROM ev WHERE state <> 'connected'
    `),
    /* section 3: pesan masuk yang tidak punya LID sama sekali. Kalau angka ini
       tinggi, pencocokan identitas kita berjalan di atas separuh data - dan
       itu persis kegagalan senyap yang diperingatkan spesifikasi. */
    db.execute(sql`
      SELECT count(*)::int AS n FROM messages
      WHERE direction = 'in' AND created_at >= ${ts(since)} AND sender_lid IS NULL
    `),
  ]);

  const o = rows<Record<string, unknown>>(out)[0];
  const b = rows<Record<string, unknown>>(bucket)[0];

  return {
    totalOut: num(o?.total),
    unattributedOut: num(o?.unattributed),
    bucketIgnored: num(b?.ignored),
    bucketNeedsReview: num(b?.needs_review),
    bucketUnreviewed: num(b?.unreviewed),
    sendFailed: num(rows<Record<string, unknown>>(failed)[0]?.n),
    gatewayDownSec: Math.round(num(rows<Record<string, unknown>>(down)[0]?.secs)),
    parseGapLid: num(rows<Record<string, unknown>>(lidGap)[0]?.n),
  };
}

/* -------------------------------- beban kerja -------------------------------- */



/**
 * section 10: "Persentase not_for_us tinggi pada satu orang bukan otomatis berarti
 * curang - bisa jadi dia pegang grup paling ramai. Sajikan sebagai sinyal untuk
 * ditanya, bukan vonis."
 *
 * Karena itu yang dikembalikan selalu berpasangan dengan penyebutnya (total
 * tiket yang dia sentuh), supaya persentase tidak pernah berdiri sendiri.
 */
export async function notForUsByAgent(since: Date) {
  return rows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT a.id, a.name, a.shift,
        count(*) FILTER (WHERE t.status = 'not_for_us')::int AS discarded,
        count(*)::int AS touched
      FROM agents a
      JOIN tickets t ON (t.closed_by = a.id OR t.first_responder_id = a.id OR t.resolved_by = a.id)
      WHERE a.is_active AND t.triggered_at >= ${ts(since)}
      GROUP BY a.id ORDER BY a.name
    `),
  ).map((r) => ({
    id: num(r.id),
    name: String(r.name),
    shift: (r.shift as string) ?? null,
    discarded: num(r.discarded),
    touched: num(r.touched),
  }));
}

/** Daftar tiket yang dibuang - leader bisa klik-tembus ke percakapannya. */
export async function notForUsList(since: Date, limit = 50) {
  return rows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT t.id, t.triggered_at AS at, coalesce(g.name, g.jid) AS group_name,
             m.sender_push_name AS sender, m.body, a.name AS by_name
      FROM tickets t
      JOIN groups g ON g.jid = t.group_jid
      JOIN messages m ON m.stanza_id = t.stanza_id
      LEFT JOIN agents a ON a.id = t.closed_by
      WHERE t.status = 'not_for_us' AND t.triggered_at >= ${ts(since)}
      ORDER BY t.closed_at DESC NULLS LAST LIMIT ${limit}
    `),
  ).map((r) => ({
    id: num(r.id),
    at: new Date(r.at as string),
    groupName: String(r.group_name),
    sender: (r.sender as string) ?? null,
    body: (r.body as string) ?? null,
    byName: (r.by_name as string) ?? null,
  }));
}

/** Isi keranjang section 6.6 yang belum ditinjau leader. */
export async function bucketItems(kind: "ignored" | "needs_review", limit = 50) {
  return rows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT b.id, b.matched_rule AS rule, b.created_at AS at,
             coalesce(g.name, g.jid) AS group_name,
             m.sender_push_name AS sender, m.body
      FROM triage_bucket b
      JOIN messages m ON m.stanza_id = b.stanza_id
      JOIN groups g ON g.jid = b.group_jid
      WHERE b.kind = ${kind} AND b.reviewed_at IS NULL
      ORDER BY b.created_at DESC LIMIT ${limit}
    `),
  ).map((r) => ({
    id: num(r.id),
    rule: String(r.rule),
    at: new Date(r.at as string),
    groupName: String(r.group_name),
    sender: (r.sender as string) ?? null,
    body: (r.body as string) ?? null,
  }));
}
