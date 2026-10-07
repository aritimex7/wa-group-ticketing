/**
 * Ingestion - SPEC section 5.
 *
 *   1. Terima webhook untuk SEMUA pesan di grup yang is_monitored = true
 *   2. Simpan SEMUA ke messages - tidak peduli jadi tiket atau tidak
 *   3. Baru kemudian evaluasi aturan pembuatan tiket (section 6)
 *
 * Kenapa langkah 2 tidak boleh dipangkas jadi "simpan yang nge-tag saja":
 * fitur lihat chat grup, pencarian, context utas, dan Fase 4 semuanya
 * bergantung pada data lengkap ini. Memotongnya berarti bongkar ulang nanti.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, ts } from "@/db";
import {
  agents,
  gatewayEvents,
  groups,
  messages,
  notifications,
  outbox,
  ticketEvents,
  tickets,
} from "@/db/schema";
import { publish } from "@/lib/events";
import { parseSignature } from "@/lib/signature";
import { applyTicketDecision, decideTicket } from "@/lib/tickets";
import { getSetting } from "@/lib/settings";
import { isDmJid } from "@/lib/identity";
import type { NormalizedEvent, NormalizedMessage } from "@/lib/gateway/types";

export type IngestSummary = {
  stored: number;
  ticketsCreated: number;
  /** 6.9 pesan susulan yang menempel ke tiket yang sudah ada. */
  merged: number;
  bucketed: number;
  ignored: number;
  /** peristiwa yang MELEDAK saat diproses - bukan yang sengaja diabaikan. */
  failed: number;
  warnings: string[];
};

export async function ingestEvents(events: NormalizedEvent[]): Promise<IngestSummary> {
  const summary: IngestSummary = {
    failed: 0,
    stored: 0,
    ticketsCreated: 0,
    merged: 0,
    bucketed: 0,
    ignored: 0,
    warnings: [],
  };

  for (const ev of events) {
    try {
      switch (ev.kind) {
        case "message": {
          summary.warnings.push(...ev.warnings);
          const res = await ingestMessage(ev.message);
          if (res.stored) summary.stored++;
          // Pesan susulan yang menempel ke tiket lama (6.9) BUKAN tiket baru.
          if (res.ticketId && !res.merged) summary.ticketsCreated++;
          if (res.merged) summary.merged++;
          if (res.bucketed) summary.bucketed++;
          break;
        }
        case "ack":
          await handleAck(ev.stanzaId, ev.ack);
          break;
        case "revoke":
          await handleRevoke(ev.stanzaId);
          break;
        case "edit":
          await handleEdit(ev.stanzaId, ev.newBody);
          break;
        case "connection":
          await handleConnection(ev.state, ev.detail);
          break;
        case "group":
          await handleGroupMeta(ev.jid, ev.subject);
          break;
        case "ignored":
          summary.ignored++;
          break;
      }
    } catch (err) {
      /* Satu peristiwa rusak tidak boleh menjatuhkan sisa batch - itu tetap
         benar. Yang SALAH sebelumnya: kegagalannya berhenti di console, dan
         webhook tetap menjawab 200. Gateway menganggap pesan itu sudah
         diterima dan tidak pernah mengulanginya, jadi pesan klien hilang
         dari catatan kita tanpa satu pun jejak yang dilihat manusia -
         persis kegagalan senyap yang diperingatkan section 15.

         Payload mentahnya masih ada di var/raw dan bisa diputar ulang
         (scripts/putar-ulang.ts). Yang kurang cuma satu: ada yang TAHU. */
      summary.warnings.push(`gagal memproses ${ev.kind}: ${(err as Error).message}`);
      summary.failed++;
      console.error("[ingest]", err);
      await beritahuGagalIngest(ev.kind, (err as Error).message);
    }
  }

  return summary;
}

/**
 * Beri tahu leader kalau ada peristiwa masuk yang gagal diproses.
 *
 * Dibatasi satu pemberitahuan per lima menit. Kalau yang rusak adalah parser -
 * bukan satu pesan aneh - maka SETIAP pesan gagal, dan tanpa pembatas ini
 * daftar notifikasi leader terkubur ribuan baris yang isinya sama.
 */
async function beritahuGagalIngest(kind: string, pesan: string): Promise<void> {
  try {
    const baru = await db.execute(sql`
      INSERT INTO notifications (kind, title, detail, for_role)
      SELECT 'ingest_failed',
             'Ada pesan masuk yang gagal diproses',
             ${JSON.stringify({ kind, pesan: pesan.slice(0, 300) })}::jsonb,
             'leader'
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
        WHERE kind = 'ingest_failed'
          AND read_at IS NULL
          AND created_at > now() - interval '5 minutes'
      )
      RETURNING id
    `);
    if ((baru as unknown as unknown[]).length) {
      await publish({ t: "notification", kind: "ingest_failed" });
    }
  } catch (e) {
    /* Gagal memberi tahu tidak boleh menjatuhkan ingestion. */
    console.error("[ingest] gagal mencatat notifikasi:", (e as Error).message);
  }
}

/* ------------------------------- pesan masuk ------------------------------- */

async function ingestMessage(msg: NormalizedMessage) {
  let group = await ensureGroup(msg.groupJid, msg.senderPushName);
  /* Chat pribadi sementara dimatikan - tidak disimpan sama sekali. */
  if (!group) return { stored: false, ticketId: null, merged: false, bucketed: false };

  /*
   * Auto-pantau berlaku saat grup MENERIMA PESAN, bukan saat barisnya dibuat.
   *
   * Versi pertama hanya menyalakan grup yang barisnya baru lahir dari pesan.
   * Lubangnya langsung kena di pemakaian nyata: leader menekan "Tarik nama
   * grup dari WhatsApp", 12 baris grup terbuat sekaligus dalam keadaan
   * nonaktif, dan sejak itu TIDAK ADA grup yang bisa menyala sendiri - pesan
   * yang masuk selalu menemukan barisnya "sudah ada".
   *
   * monitor_decided_at yang menjaga supaya ini tidak liar: begitu manusia
   * menekan Simpan di Setelan, keputusannya dihormati selamanya. Grup yang
   * sengaja dimatikan tidak akan menyala lagi.
   */
  if (!group.isMonitored && group.monitorDecidedAt === null) {
    if (await getSetting("ops.auto_monitor_new_groups")) {
      const naik = await db
        .update(groups)
        .set({ isMonitored: true })
        .where(and(eq(groups.jid, msg.groupJid), isNull(groups.monitorDecidedAt)))
        .returning();
      if (naik[0]) group = naik[0];
    }
  }

  // section 5: hanya grup yang diaktifkan leader yang isinya disimpan.
  // Grupnya sendiri tetap tercatat di atas supaya leader bisa mengaktifkan.
  if (!group.isMonitored) return { stored: false, ticketId: null, merged: false, bucketed: false };

  const direction = msg.fromMe ? ("out" as const) : ("in" as const);
  const sig = parseSignature(msg.body);

  /* section 4.3: agent_id HANYA untuk pesan keluar dari dashboard. Balasan yang
     dikirim dari HP tetap NULL walau tanda tangannya terbaca - itulah yang
     membuat panel "tidak teratribusi" (section 10) jujur. */
  let agentId: number | null = null;
  if (direction === "out") {
    /*
     * PESAN KITA KEMBALI LEWAT WEBHOOK = KONFIRMASI WHATSAPP (section 9.4).
     *
     * Rencana semula memakai event ack terpisah. Ternyata Evolution v2.3.7
     * TIDAK PERNAH mengirimkannya untuk pesan grup - messages.update nol
     * kejadian, dan send.message.update pun nol walau sudah didaftarkan
     * eksplisit di webhook level instance. Menunggu event itu berarti setiap
     * balasan menggantung selamanya di "menunggu konfirmasi WhatsApp", dan
     * agen melihat pesannya DUA KALI: sekali sebagai pesan terkirim, sekali
     * lagi sebagai kiriman tertunda.
     *
     * Gema ini justru bukti yang lebih kuat daripada ack: WhatsApp mengirim
     * balik pesan itu lewat aliran peristiwanya sendiri, artinya benar-benar
     * diterima dan disiarkan ke grup. Yang section 9.4 larang adalah menganggap
     * "API sudah dipanggil" sebagai terkirim - dan ini bukan itu.
     *
     * Tingkat ack diisi 1 (sampai server), BUKAN 2 atau 3. Kita memang tidak
     * tahu apakah sudah sampai perangkat klien atau sudah dibaca; mengaku
     * tahu akan jadi kebohongan jenis yang sama.
     */
    const now = new Date();
    const cocok = await db
      .update(outbox)
      .set({
        confirmedAt: sql`coalesce(${outbox.confirmedAt}, ${ts(now)})`,
        waAck: sql`greatest(coalesce(${outbox.waAck}, -1), 1)`,
        updatedAt: now,
      })
      .where(eq(outbox.sentStanzaId, msg.stanzaId))
      .returning({ agentId: outbox.agentId, id: outbox.id, ticketId: outbox.ticketId });

    agentId = cocok[0]?.agentId ?? null;
    if (cocok[0]) {
      await publish({ t: "outbox.updated", id: cocok[0].id, ticketId: cocok[0].ticketId, status: "sent" });
    }
  }

  const decision = direction === "in" ? await decideTicket(msg) : { action: "none" as const, reason: "pesan keluar" };

  let ticketId: number | null = null;
  let merged = false;

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(messages)
      .values({
        stanzaId: msg.stanzaId,
        groupJid: msg.groupJid,
        senderPn: msg.sender.pn,
        senderLid: msg.sender.lid,
        senderPushName: msg.senderPushName,
        direction,
        msgType: msg.msgType,
        body: msg.body,
        replyToStanzaId: msg.replyToStanzaId,
        replyToSenderPn: msg.replyToSender.pn,
        replyToSenderLid: msg.replyToSender.lid,
        quotedSnippet: msg.quotedSnippet,
        mediaMeta: msg.mediaMeta,
        agentId,
        signatureCode: sig?.code ?? null,
        isEdited: msg.isEdited,
        createdAt: msg.timestamp,
      })
      // Gateway kadang mengirim webhook yang sama dua kali. Diamkan.
      .onConflictDoNothing({ target: messages.stanzaId })
      .returning({ stanzaId: messages.stanzaId });

    if (!inserted.length) return; // duplikat

    if (decision.action !== "none") {
      const hasil = await applyTicketDecision(tx, msg, group, decision);
      if (hasil) {
        ticketId = hasil.id;
        merged = hasil.merged;
      }
    }

    // section 15 rencana cadangan: balasan dari HP utama memakai swipe-reply.
    // Kalau pesan keluar ini me-reply pesan pemicu sebuah tiket, itu bukti
    // deterministik bahwa tiket tersebut sudah dijawab - bukan tebakan.
    if (direction === "out" && msg.replyToStanzaId) {
      await attachOutgoingToTicket(
        tx,
        msg.stanzaId,
        msg.replyToStanzaId,
        msg.timestamp,
        agentId,
        sig?.code ?? null,
      );
    }
  });

  await publish({ t: "message.new", group: msg.groupJid, stanzaId: msg.stanzaId });
  if (ticketId) {
    // Susulan tidak menambah baris di papan - yang berubah isi tiket lama.
    // Menyiarkannya sebagai "created" akan membuat papan berkedip seolah ada
    // pekerjaan baru, persis kebisingan yang bikin orang berhenti melihat papan.
    await publish(
      merged
        ? { t: "ticket.updated", id: ticketId, group: msg.groupJid }
        : { t: "ticket.created", id: ticketId, group: msg.groupJid },
    );
  }

  return {
    stored: true,
    ticketId,
    merged,
    bucketed: decision.action === "bucket",
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function attachOutgoingToTicket(
  tx: Tx,
  ownStanzaId: string,
  replyToStanzaId: string,
  at: Date,
  agentId: number | null,
  signatureCode: string | null,
): Promise<void> {
  let responderId = agentId;
  if (!responderId && signatureCode) {
    const found = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.signatureCode, signatureCode))
      .limit(1);
    responderId = found[0]?.id ?? null;
  }

  /* Pesan yang di-swipe bisa pemicu tiket, bisa juga pesan SUSULAN yang tadi
     menempel ke tiket (6.9). Dua-duanya harus mengarah ke tiket yang sama,
     jadi jangan cuma mencocokkan tickets.stanza_id. Jalur messages.ticket_id
     didahulukan karena itu yang berlaku untuk tiket yang dibuat sejak 6.9;
     jalur kedua menutup tiket lama yang barisnya belum sempat terisi. */
  const cari = (await tx.execute(sql`
    SELECT coalesce(
      (SELECT m.ticket_id FROM messages m WHERE m.stanza_id = ${replyToStanzaId}),
      (SELECT t.id FROM tickets t WHERE t.stanza_id = ${replyToStanzaId})
    ) AS id
  `)) as unknown as { id: number | null }[];

  const ticketId = cari[0]?.id ?? null;
  if (ticketId === null) return;

  // Balasan kita ikut jadi anggota tiket, supaya utasnya utuh walau klien
  // membalas lagi tanpa swipe.
  await tx.update(messages).set({ ticketId }).where(eq(messages.stanzaId, ownStanzaId));

  const updated = await tx
    .update(tickets)
    .set({ firstResponseAt: at, firstResponderId: responderId })
    .where(and(eq(tickets.id, ticketId), isNull(tickets.firstResponseAt)))
    .returning({ id: tickets.id });

  if (updated.length) {
    await tx.insert(ticketEvents).values({
      ticketId,
      agentId: responderId,
      action: "reply_sent",
      toValue: agentId ? "dari dashboard" : "dari HP (dicocokkan lewat swipe-reply)",
    });
  }
}

/* -------------------------------- grup baru -------------------------------- */

async function ensureGroup(jid: string, pushName?: string | null) {
  const existing = await db.select().from(groups).where(eq(groups.jid, jid)).limit(1);
  if (existing.length) return existing[0];

  /* Chat pribadi punya saklarnya sendiri, dan bawaannya MATI. Selama mati,
     barisnya pun tidak dibuat: satu nomor bisa punya ratusan lawan bicara, dan
     mendaftarkan semuanya cuma untuk menandainya "tidak dipantau" akan
     menenggelamkan panel Perlu Perhatian milik leader. */
  const dm = isDmJid(jid);
  if (dm && !(await getSetting("ingest.dm_enabled"))) return null;

  /* section 5 + section 4.1: grup baru dibuat is_monitored = FALSE dan leader diberi tahu.
   *
   * PENYIMPANGAN YANG DIMINTA PEMILIK: kalau ops.auto_monitor_new_groups
   * dinyalakan, grup langsung aktif begitu ada pesan pertama - tidak perlu
   * dicentang dulu. Yang dibeli: tidak ada pesan yang lewat sementara leader
   * belum sempat meninjau. Yang dibayar: isi SEMUA grup ikut tersimpan,
   * termasuk grup pribadi yang kebetulan memakai nomor yang sama.
   *
   * Sengaja hanya berlaku di jalur PESAN MASUK. Grup yang lahir dari tarikan
   * daftar (handleGroupMeta) tetap nonaktif - kalau tidak, satu klik
   * "Tarik nama grup" akan menyalakan belasan grup sekaligus tanpa disadari.
   */
  const autoPantau = await getSetting("ops.auto_monitor_new_groups");

  const created = await db
    .insert(groups)
    .values({
      jid,
      isDm: dm,
      /* Nama chat pribadi diambil dari pushName pengirim supaya barisnya tidak
         berupa nomor mentah sejak awal. Nama kontak tersimpan tetap menang
         saat ditampilkan - lihat namaOrang(). */
      name: dm ? (pushName?.trim() || null) : null,
      isMonitored: autoPantau,
    })
    .onConflictDoNothing()
    .returning();

  if (created.length) {
    await db.insert(notifications).values({
      kind: "new_group",
      title: dm
        ? autoPantau
          ? "Chat pribadi baru dan langsung dipantau"
          : "Chat pribadi baru terdeteksi"
        : autoPantau
          ? "Grup baru terdeteksi dan langsung dipantau"
          : "Grup baru terdeteksi",
      detail: { jid, autoPantau, dm },
    });
    await publish({ t: "notification", kind: "new_group" });
    return created[0];
  }

  const again = await db.select().from(groups).where(eq(groups.jid, jid)).limit(1);
  return again[0];
}

/* ------------------------------ nama grup ------------------------------ */

/**
 * Isi nama grup dari WhatsApp.
 *
 * Nama yang DIKETIK LEADER tidak pernah ditimpa. Leader sering memakai nama
 * internal ("PT Anugerah - Retail") yang lebih berguna daripada subject grup
 * yang bisa diubah siapa saja di dalam grup. Yang diisi hanya yang masih
 * kosong atau masih berupa JID mentah.
 */
export async function handleGroupMeta(jid: string, subject: string | null): Promise<void> {
  if (!subject?.trim()) return;
  const polos = jid.replace(/@g\.us$/, "");

  /* acknowledgedAt diisi untuk baris BARU yang lahir dari sini.
     Bedanya penting. Grup yang muncul karena ada PESAN MASUK (ensureGroup)
     berarti klien sedang bicara dan isinya sedang tidak disimpan - itu alarm
     sungguhan. Grup yang muncul karena metadata atau tarikan daftar cuma
     "grup ini ada"; menandainya belum-ditinjau akan membanjiri panel Perlu
     Perhatian dengan alarm palsu dan membuat yang asli tenggelam. */
  await db
    .insert(groups)
    .values({ jid, name: subject, isMonitored: false, acknowledgedAt: new Date() })
    .onConflictDoUpdate({
      target: groups.jid,
      set: { name: subject },
      setWhere: sql`${groups.name} IS NULL OR ${groups.name} = ${jid} OR ${groups.name} = ${polos}`,
    });
}

/* ------------------------- ack / revoke / edit ------------------------- */

/**
 * section 9.4: status kirim berasal dari KONFIRMASI WhatsApp, bukan dari pemanggilan API.
 *
 * Dua aturan yang tidak boleh dilanggar:
 *
 *  1. PENDING (0) BUKAN konfirmasi. Itu artinya "sudah dilempar, belum ada
 *     kabar" - persis keadaan yang section 9.4 melarang kita sebut terkirim.
 *     confirmed_at hanya diisi mulai SERVER_ACK (1) ke atas.
 *  2. Ack tidak boleh MUNDUR. Webhook bisa datang tidak berurutan; kalau
 *     DELIVERY_ACK sudah masuk lalu PENDING menyusul, status tidak boleh
 *     turun lagi jadi "belum sampai".
 */
async function handleAck(stanzaId: string, ack: number): Promise<void> {
  const now = new Date();
  const rows = await db
    .update(outbox)
    .set({
      waAck: sql`greatest(coalesce(${outbox.waAck}, -1), ${ack})`,
      // ts() wajib: objek Date di dalam template `sql` gagal saat dieksekusi.
      confirmedAt: ack >= 1 ? sql`coalesce(${outbox.confirmedAt}, ${ts(now)})` : outbox.confirmedAt,
      updatedAt: now,
    })
    .where(eq(outbox.sentStanzaId, stanzaId))
    .returning({ id: outbox.id, ticketId: outbox.ticketId, status: outbox.status });

  if (rows.length) {
    await publish({ t: "outbox.updated", id: rows[0].id, ticketId: rows[0].ticketId, status: rows[0].status });
  }
}

/** section 12: tandai "pesan ini dihapus pengirim" - jangan ikut hilang dari tiket. */
async function handleRevoke(stanzaId: string): Promise<void> {
  const updated = await db
    .update(messages)
    .set({ isDeleted: true })
    .where(eq(messages.stanzaId, stanzaId))
    .returning({ groupJid: messages.groupJid, ticketId: messages.ticketId });

  if (updated.length) {
    const row = updated[0];
    await publish({ t: "message.new", group: row.groupJid, stanzaId });
    if (row.ticketId) {
      await publish({ t: "ticket.updated", id: row.ticketId, group: row.groupJid });
    }
  }
}

async function handleEdit(stanzaId: string, newBody: string | null): Promise<void> {
  const updated = await db
    .update(messages)
    .set({ isEdited: true, ...(newBody !== null ? { body: newBody } : {}) })
    .where(eq(messages.stanzaId, stanzaId))
    .returning({ groupJid: messages.groupJid, ticketId: messages.ticketId });

  if (updated.length) {
    const row = updated[0];
    await publish({ t: "message.new", group: row.groupJid, stanzaId });
    if (row.ticketId) {
      await publish({ t: "ticket.updated", id: row.ticketId, group: row.groupJid });
    }
  }
}

/* ------------------------------- koneksi ------------------------------- */

async function handleConnection(state: string, detail: unknown): Promise<void> {
  const instance = process.env.GATEWAY_INSTANCE ?? "default";

  // Hanya catat kalau BERUBAH. Tanpa ini, tabel penuh baris "connected" tiap
  // beberapa detik dan hitungan total waktu terputus (section 10) jadi tidak terbaca.
  const last = await db
    .select({ state: gatewayEvents.state })
    .from(gatewayEvents)
    .orderBy(sql`${gatewayEvents.createdAt} DESC`)
    .limit(1);

  if (last[0]?.state === state) return;

  await db.insert(gatewayEvents).values({
    instance,
    state: state as "connected" | "disconnected" | "qr_required" | "error",
    detail: (detail ?? null) as object | null,
  });

  if (state !== "connected") {
    await db.insert(notifications).values({
      kind: "gateway_down",
      title: `Gateway ${state === "qr_required" ? "minta scan QR" : "terputus"}`,
      detail: { state },
    });
  }

  await publish({ t: "gateway", state });
}
