/**
 * Skema database - acuan: SPEC section 4.
 *
 * Prinsip yang tidak boleh dilanggar:
 *  - 3.1  Setiap identitas WhatsApp disimpan DUA kolom: *_pn dan *_lid. Tanpa kecuali.
 *  - 4.2  Agen dinonaktifkan, tidak pernah DELETE (statistik lama ikut rusak).
 *  - 4.4  Target SLA disalin ke tiket saat dibuat, bukan dibaca dari setting saat lapor.
 *  - 4.7  archive_messages TERPISAH dan tidak pernah masuk hitungan SLA.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* --------------------------- enum --------------------------- */

/**
 * agent  - menangani tiket
 * leader - semua akses, termasuk setelan dan angka per agen
 * sla    - HANYA memantau angka tim. Tidak bisa membuka antrean, membalas,
 *          atau melihat nama agen. section 1 menyebut statistik milik team leader;
 *          yang dijaga kalimat itu adalah perbandingan ANTAR ORANG, dan peran
 *          ini memang tidak pernah melihatnya.
 */
export const roleEnum = pgEnum("role", ["agent", "leader", "sla"]);
export const directionEnum = pgEnum("direction", ["in", "out"]);
export const msgTypeEnum = pgEnum("msg_type", [
  "text",
  "image",
  "video",
  "document",
  "audio",
  "sticker",
  "location",
  "other",
]);
export const ticketStatusEnum = pgEnum("ticket_status", [
  "open",
  "on_progress",
  "closed",
  "not_for_us",
]);
export const triggerTypeEnum = pgEnum("trigger_type", ["mention", "reply", "dm"]);
export const ticketActionEnum = pgEnum("ticket_action", [
  "created",
  "claim",
  "release",
  "auto_release",
  "takeover",
  "reply_sent",
  "send_failed",
  "mark_on_check",
  "mark_resolved",
  "mark_not_for_us",
  "bulk_closed",
  "note_updated",
  /** 6.9 pesan susulan dari orang yang sama menempel ke tiket ini, bukan bikin tiket baru. */
  "merged",
  "undo",
]);
export const outboxStatusEnum = pgEnum("outbox_status", [
  "holding", // 9.4 masih di jendela undo, belum dilempar ke WhatsApp
  "sending",
  "sent",
  "failed",
  "canceled", // agen menekan undo
]);
export const bucketKindEnum = pgEnum("bucket_kind", ["ignored", "needs_review"]);
export const gatewayStateEnum = pgEnum("gateway_state", [
  "connected",
  "disconnected",
  "qr_required",
  "error",
]);

/* --------------------------- 4.1 groups --------------------------- */

/**
 * Daftar percakapan. Namanya "groups" karena awalnya memang cuma grup; sejak
 * chat pribadi ikut masuk (permintaan pemilik), tabel ini menampung dua-duanya
 * dan `is_dm` yang membedakan. Sengaja TIDAK dipecah jadi tabel baru: seluruh
 * pipa - messages, tickets, papan, utas, cari, SLA - menggantung di kolom
 * `group_jid`, dan memecahnya berarti menulis ulang semuanya untuk keuntungan
 * yang cuma soal penamaan.
 */
export const groups = pgTable("groups", {
  jid: text("jid").primaryKey(), // ...@g.us, atau ...@s.whatsapp.net / ...@lid untuk chat pribadi
  name: text("name"),
  /** true = chat pribadi satu lawan satu, bukan grup. */
  isDm: boolean("is_dm").notNull().default(false),
  /** 4.1 default FALSE - grup diaktifkan manual oleh leader. */
  isMonitored: boolean("is_monitored").notNull().default(false),
  clientLabel: text("client_label"),
  /** null = pakai target global dari settings. */
  slaFirstResponseMin: integer("sla_first_response_min"),
  slaResolutionMin: integer("sla_resolution_min"),
  /** 5 dipakai untuk notifikasi "grup baru terdeteksi". */
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  /**
   * Kapan MANUSIA memutuskan status pantau grup ini (menekan Simpan di Setelan).
   *
   * Dipakai auto-pantau: promosi otomatis hanya boleh menyentuh grup yang
   * keputusannya belum pernah diambil. Tanpa kolom ini, grup yang sengaja
   * dimatikan leader akan menyala lagi begitu ada pesan berikutnya - artinya
   * tidak ada cara membungkam satu grup pun.
   *
   * Sengaja TERPISAH dari acknowledged_at: yang itu menandai "sudah dilihat
   * leader" untuk panel Perlu Perhatian, dan ikut terisi oleh tarikan daftar
   * grup. Dua makna berbeda tidak boleh menumpang di satu kolom.
   */
  monitorDecidedAt: timestamp("monitor_decided_at", { withTimezone: true }),
});

/* --------------------------- 4.2 agents --------------------------- */

export const agents = pgTable(
  "agents",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    /** 4.2 kode #dsp - UNIQUE, wajib divalidasi. Disimpan lowercase. */
    signatureCode: text("signature_code").notNull(),
    role: roleEnum("role").notNull().default("agent"),
    shift: text("shift"),
    /** 4.2 nonaktifkan, JANGAN pernah DELETE. */
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agents_username_uq").on(t.username),
    uniqueIndex("agents_signature_code_uq").on(t.signatureCode),
  ],
);

/* ----------------------- 4.3 messages (SEMUA pesan) ----------------------- */

export type MediaMeta = {
  mimetype?: string;
  fileName?: string;
  fileLength?: number;
  /** thumbnail base64 kecil dari payload - bukan file aslinya (section 12). */
  thumbnailBase64?: string;
  seconds?: number;
  pageCount?: number;
};

export const messages = pgTable(
  "messages",
  {
    stanzaId: text("stanza_id").primaryKey(),
    groupJid: text("group_jid")
      .notNull()
      .references(() => groups.jid),

    /** 3.1 dua-duanya, selalu. */
    senderPn: text("sender_pn"),
    senderLid: text("sender_lid"),
    senderPushName: text("sender_push_name"),

    direction: directionEnum("direction").notNull(),
    msgType: msgTypeEnum("msg_type").notNull().default("text"),
    body: text("body"),

    /** 4.3 inti dari fitur context - dari contextInfo.stanzaId. */
    replyToStanzaId: text("reply_to_stanza_id"),
    /** dari contextInfo.participant - 3.1 dua-duanya. */
    replyToSenderPn: text("reply_to_sender_pn"),
    replyToSenderLid: text("reply_to_sender_lid"),
    /** 7.2 cuplikan pesan yang di-reply; penyelamat untuk pesan pra-sistem. */
    quotedSnippet: text("quoted_snippet"),

    /** 12 metadata saja - BUKAN filenya. */
    mediaMeta: jsonb("media_meta").$type<MediaMeta | null>(),

    /**
     * Tiket yang memuat pesan ini.
     *
     * PENYIMPANGAN dari 4.4 "1 pesan masuk = 1 tiket", diminta pemilik: pesan
     * susulan dari ORANG YANG SAMA ke tiket yang BELUM DIBALAS menempel ke
     * tiket itu, tidak melahirkan tiket kedua. Tanpa kolom ini penempelannya
     * tidak punya jejak - utas tiket kehilangan pesan susulannya, dan balasan
     * swipe ke pesan susulan tidak bisa dikaitkan ke tiketnya.
     *
     * Terisi untuk pesan pemicu maupun susulannya. NULL = pesan biasa yang
     * memang bukan bagian tiket mana pun.
     */
    ticketId: integer("ticket_id").references((): AnyPgColumn => tickets.id, {
      onDelete: "set null",
    }),

    /** hanya untuk direction=out dari dashboard. NULL = tidak teratribusi (10 kesehatan data). */
    agentId: integer("agent_id").references(() => agents.id),
    /** hasil parsing "#dsp xx" dari teks. */
    signatureCode: text("signature_code"),

    isDeleted: boolean("is_deleted").notNull().default(false),
    isEdited: boolean("is_edited").notNull().default(false),

    /** 4.3 JSONB mentah - sangat menolong saat debugging & Fase 0. */
    rawPayload: jsonb("raw_payload"),

    /** timestamp WhatsApp (bukan waktu kita menerima). */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** waktu kita menerima - selisihnya mengukur lag gateway (section 15). */
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_group_created_idx").on(t.groupJid, t.createdAt),
    index("messages_reply_to_idx").on(t.replyToStanzaId),
    index("messages_ticket_idx").on(t.ticketId),
    index("messages_agent_idx").on(t.agentId),
    index("messages_sender_pn_idx").on(t.senderPn),
    index("messages_sender_lid_idx").on(t.senderLid),
    /**
     * Full-text 'simple', bukan 'english'. Bahasa Indonesia tidak punya konfigurasi
     * stemmer bawaan di Postgres; 'english' malah memotong kata Indonesia keliru.
     */
    index("messages_body_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${t.body}, ''))`,
    ),
  ],
);

/* --------------------------- 4.4 tickets --------------------------- */

export const tickets = pgTable(
  "tickets",
  {
    id: serial("id").primaryKey(),
    /** 4.4 1 pesan masuk = 1 tiket. */
    stanzaId: text("stanza_id")
      .notNull()
      .references(() => messages.stanzaId),
    groupJid: text("group_jid")
      .notNull()
      .references(() => groups.jid),

    status: ticketStatusEnum("status").notNull().default("open"),
    triggerType: triggerTypeEnum("trigger_type").notNull(),
    /** 6.4 mention ke kita tapi contextInfo.participant orang lain. */
    likelyNotOurs: boolean("likely_not_ours").notNull().default(false),

    /** 6.3 hanya terisi saat on_progress. */
    claimedBy: integer("claimed_by").references(() => agents.id),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),

    /** 6.7 "on check" JUGA mengisi ini. */
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    firstResponderId: integer("first_responder_id").references(() => agents.id),

    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: integer("resolved_by").references(() => agents.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: integer("closed_by").references(() => agents.id),

    /** 4.4 DISALIN saat tiket dibuat - ubah setting tidak mengubah laporan lama. */
    slaTargetFrMin: integer("sla_target_fr_min").notNull(),
    slaTargetResMin: integer("sla_target_res_min").notNull(),

    /** catatan serah terima antar shift. */
    note: text("note"),

    /** waktu pesan pemicu masuk - didenormalisasi supaya query SLA tidak perlu join. */
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tickets_stanza_uq").on(t.stanzaId),
    index("tickets_status_idx").on(t.status, t.triggeredAt),
    index("tickets_group_status_idx").on(t.groupJid, t.status),
    index("tickets_claimed_idx").on(t.claimedBy),
  ],
);

/* ----------------------- 4.5 ticket_events (audit log) ----------------------- */

export const ticketEvents = pgTable(
  "ticket_events",
  {
    id: serial("id").primaryKey(),
    ticketId: integer("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    agentId: integer("agent_id").references(() => agents.id),
    action: ticketActionEnum("action").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ticket_events_ticket_idx").on(t.ticketId, t.createdAt)],
);

/* ------------------- 4.6 settings + settings_audit ------------------- */

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer("updated_by").references(() => agents.id),
});

/** 4.6 Target SLA yang diubah diam-diam bisa mengubah makna seluruh laporan. */
export const settingsAudit = pgTable(
  "settings_audit",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),
    fromValue: jsonb("from_value"),
    toValue: jsonb("to_value"),
    changedBy: integer("changed_by").references(() => agents.id),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("settings_audit_key_idx").on(t.key, t.changedAt)],
);

/* -------------- 4.7 archive_messages - OPSIONAL, WAJIB TERPISAH --------------
 * Hasil impor export chat .txt. Dicocokkan lewat ISI TEKS, bukan ID.
 * JANGAN PERNAH ikut masuk statistik SLA atau hitungan tiket.
 * Sengaja tanpa foreign key ke messages/tickets supaya tidak bisa "nyasar" ke sana.
 */
export const archiveMessages = pgTable(
  "archive_messages",
  {
    id: serial("id").primaryKey(),
    groupJid: text("group_jid"),
    groupLabel: text("group_label"),
    senderName: text("sender_name"),
    body: text("body").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    sourceFile: text("source_file").notNull(),
    lineNo: integer("line_no"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("archive_sent_at_idx").on(t.sentAt),
    index("archive_body_fts_idx").using("gin", sql`to_tsvector('simple', ${t.body})`),
  ],
);

/* -------------- 6.6 keranjang "diabaikan" & "perlu ditinjau" --------------
 * Pesan yang kena filter JANGAN dibuang. Leader harus bisa meninjau.
 */
export const triageBucket = pgTable(
  "triage_bucket",
  {
    id: serial("id").primaryKey(),
    stanzaId: text("stanza_id")
      .notNull()
      .references(() => messages.stanzaId),
    groupJid: text("group_jid").notNull(),
    kind: bucketKindEnum("kind").notNull(),
    /** aturan mana yang membuang pesan ini - supaya salah-setting bisa dilacak. */
    matchedRule: text("matched_rule").notNull(),
    reviewedBy: integer("reviewed_by").references(() => agents.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** kalau leader memutuskan ini seharusnya jadi tiket. */
    promotedTicketId: integer("promoted_ticket_id").references(() => tickets.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("triage_stanza_uq").on(t.stanzaId),
    index("triage_kind_idx").on(t.kind, t.createdAt),
  ],
);

/* ------------------ 9.4 outbox - pengaman pengiriman ------------------
 * Undo 5 detik yang SUNGGUHAN: pesan ditahan di sini, baru dilempar ke
 * WhatsApp setelah release_at lewat. Bukan "hapus untuk semua".
 */
export type OutboxAttachment = {
  fileName: string;
  mimetype: string;
  size: number;
  /** path file sementara di server - section 12 dihapus setelah terkirim. */
  tempPath: string;
};

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 9.4 klik ganda / internet lambat tidak menghasilkan dua pesan. */
    idempotencyKey: text("idempotency_key").notNull(),
    ticketId: integer("ticket_id").references(() => tickets.id),
    groupJid: text("group_jid").notNull(),
    agentId: integer("agent_id")
      .notNull()
      .references(() => agents.id),

    body: text("body").notNull(),
    /** 12 mention harus PN DAN LID. */
    mentions: jsonb("mentions").$type<{ pn: string | null; lid: string | null }[]>(),
    attachment: jsonb("attachment").$type<OutboxAttachment | null>(),
    /** 6.7 balasan menempel ke pesan asli klien, bukan ke pesan "on check" sendiri. */
    replyToStanzaId: text("reply_to_stanza_id"),
    /** tiket lain dari grup yang sama yang ikut ditutup (6.8). */
    alsoCloseTicketIds: jsonb("also_close_ticket_ids").$type<number[]>(),
    /** true kalau ini balasan penahan "on check" (6.7). */
    isOnCheck: boolean("is_on_check").notNull().default(false),
    /** true kalau agen menandai selesai bersamaan dengan kirim. */
    markResolved: boolean("mark_resolved").notNull().default(false),

    status: outboxStatusEnum("status").notNull().default("holding"),
    /** kapan boleh dilempar ke WhatsApp = created_at + durasi undo. */
    releaseAt: timestamp("release_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),

    /** 9.4 status kirim dari KONFIRMASI WhatsApp, bukan dari "API sudah dipanggil". */
    sentStanzaId: text("sent_stanza_id"),
    waAck: integer("wa_ack"), // 0 pending - 1 server - 2 delivered - 3 read
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("outbox_idempotency_uq").on(t.idempotencyKey),
    index("outbox_due_idx").on(t.status, t.releaseAt),
    index("outbox_ticket_idx").on(t.ticketId),
  ],
);

/* --------- 10/11/15 riwayat sambungan gateway ---------
 * Dibutuhkan untuk "Total waktu gateway terputus" dan alarm putus.
 */
export const gatewayEvents = pgTable(
  "gateway_events",
  {
    id: serial("id").primaryKey(),
    instance: text("instance").notNull(),
    state: gatewayStateEnum("state").notNull(),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("gateway_events_created_idx").on(t.createdAt)],
);

/* --------- sesi login - dipakai auto-release claim (6.3) ---------
 * "on_progress kembali ke open kalau agennya logout atau tidak aktif."
 * Tanpa last_seen_at, aturan itu tidak bisa dijalankan.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: integer("agent_id")
      .notNull()
      .references(() => agents.id),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_agent_idx").on(t.agentId, t.lastSeenAt)],
);

/* --------- 11 daftar nomor internal & frasa yang diabaikan ---------
 * Tabel, bukan blob JSON di settings: tiap baris perlu jejak siapa yang
 * menambah dan kapan - 6.6 menyebut setting ini yang paling berbahaya.
 */
export const internalNumbers = pgTable(
  "internal_numbers",
  {
    id: serial("id").primaryKey(),
    label: text("label"),
    /** 3.1 dua-duanya. */
    pn: text("pn"),
    lid: text("lid"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: integer("created_by").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("internal_numbers_pn_idx").on(t.pn), index("internal_numbers_lid_idx").on(t.lid)],
);

export const ignoredPhrases = pgTable("ignored_phrases", {
  id: serial("id").primaryKey(),
  phrase: text("phrase").notNull(),
  /** "exact" = sama persis setelah normalisasi, "prefix" = diawali frasa ini. */
  matchMode: text("match_mode").notNull().default("exact"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: integer("created_by").references(() => agents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* --------- 12 daftar tag: satu nama untuk beberapa orang --------- */

/**
 * Diminta pemilik: "kalo gua mau ngetag orang2 ini gua tinggal tag 1, dan
 * mereka yg ada di grup ditag, yg ga ada tidak ditag."
 *
 * WhatsApp tidak punya konsep ini - di kabel tetap harus satu token per orang.
 * Jadi daftar ini murni milik kita: agen mengetik "@sameday", dan saat kirim
 * ia mekar jadi token tiap anggota YANG MEMANG PESERTA grup itu. Anggota yang
 * tidak ada di grup dilewati - menandai orang yang bukan peserta tidak
 * memberitahu siapa-siapa, cuma meninggalkan angka aneh di depan klien.
 */
export const mentionLists = pgTable(
  "mention_lists",
  {
    id: serial("id").primaryKey(),
    /** yang diketik sesudah "@". huruf kecil, tanpa spasi. */
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: integer("created_by").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("mention_lists_slug_uq").on(t.slug)],
);

export const mentionListMembers = pgTable(
  "mention_list_members",
  {
    id: serial("id").primaryKey(),
    listId: integer("list_id")
      .notNull()
      .references(() => mentionLists.id, { onDelete: "cascade" }),
    /** 3.1 dua-duanya. LID tidak bisa diturunkan dari nomor - kosong, bukan ditebak. */
    pn: text("pn"),
    lid: text("lid"),
    /** nama saat ditambahkan, cuma untuk dibaca di Setelan. */
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mention_list_members_list_idx").on(t.listId)],
);

/* --------- 9.5 / 11 balasan cepat --------- */

export const quickReplies = pgTable("quick_replies", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
});

/* --------- 5 notifikasi ke leader (grup baru, gateway putus) --------- */

export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(), // new_group | gateway_down | quiet_hours | send_failed
    title: text("title").notNull(),
    detail: jsonb("detail"),
    forRole: roleEnum("for_role").notNull().default("leader"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_unread_idx").on(t.forRole, t.readAt)],
);

/* --------- penanda tiket sudah dilihat agen (badge realtime) --------- */

export const agentSeen = pgTable(
  "agent_seen",
  {
    agentId: integer("agent_id")
      .notNull()
      .references(() => agents.id),
    ticketId: integer("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.ticketId] })],
);

/* --------- tipe turunan --------- */

export type Agent = typeof agents.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Ticket = typeof tickets.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
