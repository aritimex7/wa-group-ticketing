/**
 * Context percakapan - SPEC section 7.
 *
 * section 7.1 menolak penelusuran garis lurus, dan alasannya betul:
 *
 *   A reply B, C reply B, C tag kita.
 *   Naik dari C hanya menghasilkan C -> B. A hilang, padahal A ikut membahas B.
 *
 * Jadi algoritmanya dua arah:
 *   1. naik lewat reply_to_stanza_id sampai ketemu akar
 *   2. dari akar, tarik SEMUA turunan secara rekursif
 *   3. urutkan berdasarkan waktu
 *
 * Semua dalam satu recursive CTE supaya tidak ada N+1 query.
 */
import { sql } from "drizzle-orm";
import { db, ts } from "@/db";
import type { MediaMeta } from "@/db/schema";

/** Batas kedalaman: jaga performa, sekaligus jaring pengaman kalau rantai reply
 *  ternyata melingkar karena data rusak. */
const MAX_DEPTH = 60;
const MAX_NODES = 300;

export type ThreadMessage = {
  stanzaId: string;
  groupJid: string;
  senderPn: string | null;
  senderLid: string | null;
  senderPushName: string | null;
  direction: "in" | "out";
  msgType: string;
  body: string | null;
  replyToStanzaId: string | null;
  quotedSnippet: string | null;
  mediaMeta: MediaMeta | null;
  agentId: number | null;
  agentName: string | null;
  signatureCode: string | null;
  isDeleted: boolean;
  isEdited: boolean;
  createdAt: Date;
  /** kedalaman dari akar - dipakai UI untuk indentasi halus, bukan pohon penuh. */
  depth: number;
};

/**
 * @param ticketId kalau diisi, semua pesan yang tercatat sebagai anggota tiket
 *   ini ikut ditarik walau tidak nyambung ke rantai reply. Itu yang membuat
 *   pesan susulan (6.9) tetap terlihat: klien yang menyapa lagi dengan mention
 *   polos - tanpa swipe - tidak punya reply_to_stanza_id sama sekali, jadi
 *   penelusuran rekursif tidak akan pernah sampai ke sana.
 */
export async function loadThread(
  stanzaId: string,
  groupJid: string,
  ticketId: number | null = null,
): Promise<ThreadMessage[]> {
  const rows = await db.execute(sql`
    WITH RECURSIVE
    -- (1) naik sampai akar
    up AS (
      SELECT m.stanza_id, m.reply_to_stanza_id, 0 AS lvl
      FROM messages m
      WHERE m.stanza_id = ${stanzaId} AND m.group_jid = ${groupJid}
      UNION ALL
      SELECT p.stanza_id, p.reply_to_stanza_id, up.lvl + 1
      FROM messages p
      JOIN up ON p.stanza_id = up.reply_to_stanza_id
      WHERE p.group_jid = ${groupJid} AND up.lvl < ${MAX_DEPTH}
    ),
    root AS (
      SELECT stanza_id FROM up ORDER BY lvl DESC LIMIT 1
    ),
    -- (2) dari akar, semua turunan
    down AS (
      SELECT m.stanza_id, 0 AS depth
      FROM messages m
      JOIN root r ON r.stanza_id = m.stanza_id
      UNION
      SELECT c.stanza_id, d.depth + 1
      FROM messages c
      JOIN down d ON c.reply_to_stanza_id = d.stanza_id
      WHERE c.group_jid = ${groupJid} AND d.depth < ${MAX_DEPTH}
    ),
    -- (3) 6.9 anggota tiket yang tidak nyambung ke rantai reply mana pun
    anggota AS (
      SELECT m.stanza_id, 0 AS depth
      FROM messages m
      WHERE ${ticketId}::int IS NOT NULL
        AND m.ticket_id = ${ticketId}::int
        AND m.group_jid = ${groupJid}
    ),
    semua AS (
      SELECT stanza_id, depth FROM down
      UNION ALL
      SELECT stanza_id, depth FROM anggota
    )
    SELECT
      m.stanza_id        AS "stanzaId",
      m.group_jid        AS "groupJid",
      m.sender_pn        AS "senderPn",
      m.sender_lid       AS "senderLid",
      m.sender_push_name AS "senderPushName",
      m.direction,
      m.msg_type         AS "msgType",
      m.body,
      m.reply_to_stanza_id AS "replyToStanzaId",
      m.quoted_snippet   AS "quotedSnippet",
      m.media_meta       AS "mediaMeta",
      m.agent_id         AS "agentId",
      a.name             AS "agentName",
      m.signature_code   AS "signatureCode",
      m.is_deleted       AS "isDeleted",
      m.is_edited        AS "isEdited",
      m.created_at       AS "createdAt",
      MIN(d.depth)       AS depth
    FROM semua d
    JOIN messages m ON m.stanza_id = d.stanza_id
    LEFT JOIN agents a ON a.id = m.agent_id
    GROUP BY m.stanza_id, a.name
    ORDER BY m.created_at ASC
    LIMIT ${MAX_NODES}
  `);

  return (rows as unknown as ThreadMessage[]).map((r) => ({
    ...r,
    depth: Number(r.depth ?? 0),
    createdAt: new Date(r.createdAt),
  }));
}

/* --------------------- section 7.2 pesan dari sebelum sistem aktif --------------------- */

export type MissingParentInfo = {
  /** cuplikan yang ikut dikirim WhatsApp di payload. */
  quotedSnippet: string | null;
  /** kandidat dari archive_messages - "kemungkinan cocok", bisa lebih dari satu. */
  candidates: ArchiveCandidate[];
};

export type ArchiveCandidate = {
  id: number;
  senderName: string | null;
  body: string;
  sentAt: Date;
  sourceFile: string;
  rank: number;
};

/**
 * Dipanggil kalau reply_to_stanza_id tidak ada di messages.
 *
 * Urutan yang diminta section 7.2:
 *   1. tampilkan quoted_snippet dari payload
 *   2. kalau ada archive_messages, cari kandidat kecocokan TEKS
 *   3. kalau tetap tidak ada, UI menampilkan "Membalas pesan dari sebelum
 *      sistem aktif" - bukan kutipan kosong
 *
 * Kandidat di sini tidak pernah dianggap fakta. Nilainya cuma "kemungkinan".
 */
export async function resolveMissingParent(
  quotedSnippet: string | null,
  groupJid: string | null,
): Promise<MissingParentInfo> {
  if (!quotedSnippet?.trim()) return { quotedSnippet, candidates: [] };

  // Ambil beberapa kata pertama saja: cuplikan WhatsApp sering terpotong,
  // dan mencocokkan seluruh kalimat justru menurunkan peluang ketemu.
  const needle = quotedSnippet.split(/\s+/).slice(0, 8).join(" ");

  const rows = await db.execute(sql`
    SELECT
      id,
      sender_name AS "senderName",
      body,
      sent_at     AS "sentAt",
      source_file AS "sourceFile",
      ts_rank(to_tsvector('simple', body), plainto_tsquery('simple', ${needle})) AS rank
    FROM archive_messages
    WHERE to_tsvector('simple', body) @@ plainto_tsquery('simple', ${needle})
      ${groupJid ? sql`AND (group_jid IS NULL OR group_jid = ${groupJid})` : sql``}
    ORDER BY rank DESC, sent_at DESC
    LIMIT 5
  `);

  const candidates = (rows as unknown as ArchiveCandidate[]).map((r) => ({
    ...r,
    sentAt: new Date(r.sentAt),
    rank: Number(r.rank),
  }));

  return { quotedSnippet, candidates };
}

/* ----------------- section 7.3 lihat chat grup (read-only) ----------------- */

export async function loadGroupWindow(
  groupJid: string,
  around: Date,
  opts: { before?: number; after?: number } = {},
): Promise<ThreadMessage[]> {
  const before = opts.before ?? 40;
  const after = opts.after ?? 40;

  const rows = await db.execute(sql`
    (
      SELECT m.*, a.name AS agent_name
      FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
      WHERE m.group_jid = ${groupJid} AND m.created_at <= ${ts(around)}
      ORDER BY m.created_at DESC LIMIT ${before}
    )
    UNION ALL
    (
      SELECT m.*, a.name AS agent_name
      FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
      WHERE m.group_jid = ${groupJid} AND m.created_at > ${ts(around)}
      ORDER BY m.created_at ASC LIMIT ${after}
    )
  `);

  return (rows as unknown as Record<string, unknown>[])
    .map((r) => ({
      stanzaId: r.stanza_id as string,
      groupJid: r.group_jid as string,
      senderPn: r.sender_pn as string | null,
      senderLid: r.sender_lid as string | null,
      senderPushName: r.sender_push_name as string | null,
      direction: r.direction as "in" | "out",
      msgType: r.msg_type as string,
      body: r.body as string | null,
      replyToStanzaId: r.reply_to_stanza_id as string | null,
      quotedSnippet: r.quoted_snippet as string | null,
      mediaMeta: r.media_meta as MediaMeta | null,
      agentId: r.agent_id as number | null,
      agentName: (r.agent_name as string) ?? null,
      signatureCode: r.signature_code as string | null,
      isDeleted: r.is_deleted as boolean,
      isEdited: r.is_edited as boolean,
      createdAt: new Date(r.created_at as string),
      depth: 0,
    }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * Berapa pesan yang lebih baru dari ujung jendela yang sedang ditampilkan.
 *
 * Jendela loadGroupWindow dibatasi jumlah baris, jadi membuka tiket lama di
 * grup ramai bisa berhenti jauh sebelum pesan terakhir. Tanpa angka ini, dasar
 * layar terlihat persis seperti akhir percakapan - agen mengira sudah membaca
 * semuanya padahal masih ada 200 pesan di bawahnya. Pemotongan senyap seperti
 * itu yang section 15 sebut mimpi buruk: layar terlihat normal, isinya tidak.
 */
export async function hitungLebihBaru(groupJid: string, setelah: Date): Promise<number> {
  const r = (await db.execute(sql`
    SELECT count(*)::int AS n
    FROM messages
    WHERE group_jid = ${groupJid} AND created_at > ${ts(setelah)}
  `)) as unknown as { n: number }[];
  return Number(r[0]?.n ?? 0);
}

/** section 7.3 pencarian teks lintas grup. */
export type HasilCari = {
  stanzaId: string;
  groupJid: string;
  groupName: string | null;
  senderPushName: string | null;
  senderPn: string | null;
  senderLid: string | null;
  direction: "in" | "out";
  agentName: string | null;
  signatureCode: string | null;
  body: string | null;
  createdAt: Date;
};

export async function searchMessages(query: string, limit = 50): Promise<HasilCari[]> {
  if (!query.trim()) return [];
  const rows = await db.execute(sql`
    SELECT
      m.stanza_id  AS "stanzaId",
      m.group_jid  AS "groupJid",
      g.name       AS "groupName",
      m.sender_push_name AS "senderPushName",
      m.sender_pn        AS "senderPn",
      m.sender_lid       AS "senderLid",
      m.direction,
      a.name       AS "agentName",
      m.signature_code AS "signatureCode",
      m.body,
      m.created_at AS "createdAt",
      ts_rank(to_tsvector('simple', coalesce(m.body, '')), plainto_tsquery('simple', ${query})) AS rank
    FROM messages m
    JOIN groups g ON g.jid = m.group_jid
    LEFT JOIN agents a ON a.id = m.agent_id
    WHERE to_tsvector('simple', coalesce(m.body, '')) @@ plainto_tsquery('simple', ${query})
    ORDER BY rank DESC, m.created_at DESC
    LIMIT ${limit}
  `);

  /* createdAt WAJIB dinormalkan jadi Date di sini.
     Sebelumnya tipenya dideklarasikan string padahal postgres.js mengembalikan
     Date - dan halaman cari menyisipkannya mentah-mentah ke URL. Hasilnya
     "GMT+0700" berubah jadi spasi saat query string di-parse, tanggalnya jadi
     Invalid Date, dan halaman tujuan melempar RangeError. Tipe yang berbohong
     bukan sekadar tidak rapi - di sini ia langsung jadi halaman error. */
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    stanzaId: r.stanzaId as string,
    groupJid: r.groupJid as string,
    groupName: (r.groupName as string) ?? null,
    senderPushName: (r.senderPushName as string) ?? null,
    senderPn: (r.senderPn as string) ?? null,
    senderLid: (r.senderLid as string) ?? null,
    direction: r.direction as "in" | "out",
    agentName: (r.agentName as string) ?? null,
    signatureCode: (r.signatureCode as string) ?? null,
    body: (r.body as string) ?? null,
    createdAt: new Date(r.createdAt as string),
  }));
}
