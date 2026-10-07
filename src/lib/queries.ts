import "server-only";
import { sql } from "drizzle-orm";
import { db, ts } from "@/db";
import { startOfTodayWib } from "@/lib/time";

/**
 * Query untuk layar. Ditulis sebagai SQL langsung, bukan rangkaian query ORM,
 * karena papan tiket digambar ulang tiap kali ada peristiwa realtime - tiap
 * perjalanan tambahan ke database terasa.
 */

export type BoardTicket = {
  id: number;
  status: "open" | "on_progress" | "closed" | "not_for_us";
  triggerType: "mention" | "reply" | "dm";
  likelyNotOurs: boolean;
  triggeredAt: Date;
  slaTargetFrMin: number;
  slaTargetResMin: number;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  claimedBy: number | null;
  claimedByName: string | null;
  claimedAt: Date | null;
  groupJid: string;
  groupName: string | null;
  clientLabel: string | null;
  body: string | null;
  msgType: string;
  senderPushName: string | null;
  senderPn: string | null;
  senderLid: string | null;
  /** true = chat pribadi satu lawan satu, bukan grup. */
  isDm: boolean;
  /** section 6.8 berapa tiket lain dari grup ini yang masih terbuka. */
  siblings: number;
  /** section 6.9 pesan susulan yang datang SETELAH balasan terakhir kita - yang belum dijawab. */
  susulan: number;
  /** waktu pesan TERAKHIR di tiket ini, arah mana pun. */
  lastMessageAt: Date;
  /** ada kiriman gagal yang menunggu (section 9.4 tanda merah). */
  hasFailedSend: boolean;
};

const SELECT_BOARD = sql`
  SELECT
    t.id,
    t.status,
    t.trigger_type        AS "triggerType",
    t.likely_not_ours     AS "likelyNotOurs",
    t.triggered_at        AS "triggeredAt",
    t.sla_target_fr_min   AS "slaTargetFrMin",
    t.sla_target_res_min  AS "slaTargetResMin",
    t.first_response_at   AS "firstResponseAt",
    t.resolved_at         AS "resolvedAt",
    t.closed_at           AS "closedAt",
    t.claimed_by          AS "claimedBy",
    t.claimed_at          AS "claimedAt",
    ca.name               AS "claimedByName",
    g.jid                 AS "groupJid",
    g.name                AS "groupName",
    g.client_label        AS "clientLabel",
    g.is_dm               AS "isDm",
    m.body,
    m.msg_type            AS "msgType",
    m.sender_push_name    AS "senderPushName",
    m.sender_pn           AS "senderPn",
    m.sender_lid          AS "senderLid",
    (
      SELECT count(*)::int FROM tickets t2
      WHERE t2.group_jid = t.group_jid
        AND t2.id <> t.id
        AND t2.status IN ('open','on_progress')
    ) AS siblings,
    (
      /* section 6.9: cuplikan di baris ini isinya pesan PEMICU. Kalau klien
         menyapa lagi, pesan keduanya tidak terlihat di sini sama sekali - jadi
         jumlahnya harus disebut, kalau tidak agen membuka tiket dan kaget ada
         yang belum dibaca.
         Yang dihitung hanya yang datang SETELAH balasan terakhir kita. Sejak
         jawaban klien atas pesan "on check" ikut menempel ke tiket ini, angka
         yang menghitung semua susulan tidak pernah kembali ke nol - dan
         penanda yang tidak pernah padam berhenti dibaca orang. */
      SELECT count(*)::int FROM messages fm
      WHERE fm.ticket_id = t.id
        AND fm.direction = 'in'
        AND fm.stanza_id <> t.stanza_id
        AND fm.created_at > coalesce(
          (SELECT max(o.created_at) FROM messages o
            WHERE o.ticket_id = t.id AND o.direction = 'out'),
          '-infinity'::timestamptz
        )
    ) AS susulan,
    (
      /* Jam pesan terakhir di tiket ini - dipakai di baris papan.
         Kedua arah ikut: yang ditanyakan agen adalah "kapan percakapan ini
         terakhir bergerak", dan balasan kita sendiri juga menggerakkannya.
         coalesce ke triggered_at supaya baris tidak pernah kosong walau ada
         tiket lama yang ticket_id-nya belum sempat terisi. */
      SELECT coalesce(max(fm.created_at), t.triggered_at)
      FROM messages fm WHERE fm.ticket_id = t.id
    ) AS "lastMessageAt",
    EXISTS (
      SELECT 1 FROM outbox o WHERE o.ticket_id = t.id AND o.status = 'failed'
    ) AS "hasFailedSend"
  FROM tickets t
  JOIN groups g   ON g.jid = t.group_jid
  JOIN messages m ON m.stanza_id = t.stanza_id
  LEFT JOIN agents ca ON ca.id = t.claimed_by
`;

function hydrate(rows: unknown): BoardTicket[] {
  return (rows as Record<string, unknown>[]).map((r) => ({
    ...(r as unknown as BoardTicket),
    triggeredAt: new Date(r.triggeredAt as string),
    firstResponseAt: r.firstResponseAt ? new Date(r.firstResponseAt as string) : null,
    resolvedAt: r.resolvedAt ? new Date(r.resolvedAt as string) : null,
    closedAt: r.closedAt ? new Date(r.closedAt as string) : null,
    claimedAt: r.claimedAt ? new Date(r.claimedAt as string) : null,
    lastMessageAt: new Date((r.lastMessageAt ?? r.triggeredAt) as string),
  }));
}

/**
 * Papan tiket agen.
 *
 * PENYIMPANGAN DARI SPEC section 9.1: spesifikasi meminta tiga kolom bersebelahan.
 * Pemilik memilih tab - satu daftar tampil penuh lebar layar. Yang hilang:
 * agen tidak lagi melihat sekilas siapa sedang menangani apa tanpa berpindah
 * tab. Yang didapat: cuplikan pesan terbaca jauh lebih panjang, dan dua daftar
 * yang tidak sedang dilihat tidak perlu di-query sama sekali.
 *
 * Urutan tiap daftar tetap seperti section 9.1:
 *   open     -> yang paling lama menunggu DI ATAS
 *   progress -> yang paling lama dipegang di atas
 *   done     -> terbaru di atas
 */
export type BoardTab = "open" | "progress" | "done";

export const BOARD_TABS: { key: BoardTab; label: string; hint: string }[] = [
  { key: "open", label: "Open", hint: "paling lama menunggu di atas" },
  { key: "progress", label: "Progress", hint: "terkunci ke pemegangnya" },
  { key: "done", label: "Done", hint: "selesai hari ini, terbaru di atas" },
];

export function isBoardTab(v: string | undefined): v is BoardTab {
  return v === "open" || v === "progress" || v === "done";
}

/** Hitungan untuk badge di tab. Selalu ketiganya - ini murah, satu query. */
export async function boardCounts(): Promise<Record<BoardTab, number>> {
  const since = startOfTodayWib();
  const rows = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'open')::int        AS open,
      count(*) FILTER (WHERE status = 'on_progress')::int AS progress,
      count(*) FILTER (WHERE status = 'closed' AND closed_at >= ${ts(since)})::int AS done
    FROM tickets
  `);
  const r = (rows as unknown as Record<string, unknown>[])[0] ?? {};
  return { open: Number(r.open ?? 0), progress: Number(r.progress ?? 0), done: Number(r.done ?? 0) };
}

/** Hanya daftar yang sedang dilihat. */
export async function loadColumn(tab: BoardTab): Promise<BoardTicket[]> {
  const since = startOfTodayWib();

  if (tab === "progress") {
    return hydrate(
      await db.execute(sql`${SELECT_BOARD} WHERE t.status = 'on_progress' ORDER BY t.claimed_at ASC LIMIT 200`),
    );
  }
  if (tab === "done") {
    return hydrate(
      await db.execute(
        sql`${SELECT_BOARD} WHERE t.status = 'closed' AND t.closed_at >= ${ts(since)} ORDER BY t.closed_at DESC LIMIT 60`,
      ),
    );
  }
  return hydrate(await db.execute(sql`${SELECT_BOARD} WHERE t.status = 'open' ORDER BY t.triggered_at ASC LIMIT 200`));
}

export async function loadTicket(id: number): Promise<BoardTicket | null> {
  const rows = await db.execute(sql`${SELECT_BOARD} WHERE t.id = ${id} LIMIT 1`);
  return hydrate(rows)[0] ?? null;
}

/** Pesan pemicu tiket - dibutuhkan halaman tiket untuk menyusun utas. */
export async function ticketAnchor(id: number) {
  const rows = await db.execute(sql`
    SELECT t.stanza_id AS "stanzaId", t.group_jid AS "groupJid",
           m.reply_to_stanza_id AS "replyToStanzaId",
           m.quoted_snippet AS "quotedSnippet"
    FROM tickets t JOIN messages m ON m.stanza_id = t.stanza_id
    WHERE t.id = ${id} LIMIT 1
  `);
  return (rows as unknown as {
    stanzaId: string;
    groupJid: string;
    replyToStanzaId: string | null;
    quotedSnippet: string | null;
  }[])[0];
}

/* -------------------------- section 9.3 statistik pribadi --------------------------
 * "Agen harus bisa melihat angkanya sendiri - sama persis dengan yang dilihat
 *  leader. Metrik yang hanya terlihat dari atas lebih cepat diakali daripada
 *  diperbaiki."
 *
 * Pemilik memutuskan agen cukup melihat JUMLAH yang ditangani dan JUMLAH yang
 * lewat SLA - dua median (balas pertama & tuntas) dihapus dari layar agen dan
 * hanya ada di dashboard leader. Perhitungan mediannya ikut dibuang dari query
 * ini, bukan sekadar disembunyikan di UI: dua percentile_cont per render papan
 * itu ongkos yang tidak ada gunanya kalau angkanya tidak ditampilkan.
 *
 * section 8 tetap berlaku untuk yang tersisa: tiket not_for_us tidak dihitung.
 */
export type PersonalStats = {
  handled: number;
  breaches: number;
};

export async function personalStats(agentId: number, since = startOfTodayWib()): Promise<PersonalStats> {
  const rows = await db.execute(sql`
    SELECT
      count(*)::int AS handled,
      count(*) FILTER (
        WHERE t.first_response_at IS NOT NULL
          AND t.first_response_at - t.triggered_at > make_interval(mins => t.sla_target_fr_min)
      )::int AS breaches
    FROM tickets t
    WHERE t.status <> 'not_for_us'
      AND t.triggered_at >= ${ts(since)}
      AND (t.first_responder_id = ${agentId} OR t.resolved_by = ${agentId})
  `);

  const r = (rows as unknown as Record<string, unknown>[])[0] ?? {};
  return { handled: Number(r.handled ?? 0), breaches: Number(r.breaches ?? 0) };
}

/* ------------------------------ status gateway ------------------------------ */

export type GatewayHealth = {
  state: "connected" | "disconnected" | "qr_required" | "error" | "unknown";
  since: Date | null;
  downtimeTodaySec: number;
  lastMessageAt: Date | null;
};

export async function gatewayHealth(): Promise<GatewayHealth> {
  const since = startOfTodayWib();

  const [last, downtime, lastMsg] = await Promise.all([
    db.execute(sql`SELECT state, created_at AS "createdAt" FROM gateway_events ORDER BY created_at DESC LIMIT 1`),
    /* Total waktu terputus hari ini (section 10). Tiap baris "bukan connected"
       dihitung sampai baris berikutnya - atau sampai sekarang kalau itu yang
       terakhir. */
    db.execute(sql`
      WITH ev AS (
        SELECT state, created_at,
               lead(created_at) OVER (ORDER BY created_at) AS next_at
        FROM gateway_events
        WHERE created_at >= ${ts(since)}
      )
      SELECT coalesce(sum(EXTRACT(EPOCH FROM (coalesce(next_at, now()) - created_at))), 0) AS secs
      FROM ev WHERE state <> 'connected'
    `),
    db.execute(sql`SELECT max(ingested_at) AS "at" FROM messages`),
  ]);

  const lastRow = (last as unknown as { state: string; createdAt: string }[])[0];
  const dt = (downtime as unknown as { secs: string }[])[0];
  const lm = (lastMsg as unknown as { at: string | null }[])[0];

  return {
    state: (lastRow?.state as GatewayHealth["state"]) ?? "unknown",
    since: lastRow ? new Date(lastRow.createdAt) : null,
    downtimeTodaySec: Math.round(Number(dt?.secs ?? 0)),
    lastMessageAt: lm?.at ? new Date(lm.at) : null,
  };
}
