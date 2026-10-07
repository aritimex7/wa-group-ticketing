/**
 * Pengaman pengiriman - SPEC section 9.4.
 *
 * Empat janji yang dipegang berkas ini:
 *
 *   1. Idempotency key per pengiriman. Klik ganda atau internet lambat tidak
 *      pernah menghasilkan dua pesan di grup klien.
 *   2. Undo 5 detik yang SUNGGUHAN. Pesan ditahan di tabel outbox dan baru
 *      dilempar ke WhatsApp setelah release_at lewat. Bukan "hapus untuk
 *      semua" yang meninggalkan jejak "pesan ini telah dihapus" di grup klien.
 *   3. Status kirim datang dari konfirmasi WhatsApp (webhook ack), bukan dari
 *      "API sudah dipanggil". Lihat lib/ingest.ts -> handleAck.
 *   4. Kirim gagal mengembalikan tiket ke antrean dengan tanda merah, dan teks
 *      balasannya tetap utuh di kolom body supaya agen tidak mengetik ulang.
 */
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { unlink } from "node:fs/promises";
import { db, ts } from "@/db";
import { agents, outbox, ticketEvents, tickets } from "@/db/schema";
import { gateway } from "@/lib/gateway";
import { publish } from "@/lib/events";
import { getSettings } from "@/lib/settings";
import { bulkClose, markResolved } from "@/lib/tickets";
import { ensureSignature } from "@/lib/signature";
import type { OutboxAttachment } from "@/db/schema";

export type EnqueueArgs = {
  idempotencyKey: string;
  ticketId: number | null;
  groupJid: string;
  agentId: number;
  agentSignature: string;
  body: string;
  mentions?: { pn: string | null; lid: string | null }[];
  attachment?: OutboxAttachment | null;
  replyToStanzaId?: string | null;
  alsoCloseTicketIds?: number[];
  isOnCheck?: boolean;
  markResolved?: boolean;
};

export type EnqueueResult = { id: string; releaseAt: Date; duplicate: boolean };

export async function enqueue(args: EnqueueArgs): Promise<EnqueueResult> {
  const cfg = await getSettings(["ops.undo_seconds", "signature.auto_insert", "signature.prefix"] as const);

  // section 11: sisip tanda tangan otomatis, dan jangan digandakan kalau agen
  // sudah mengetiknya sendiri.
  const body = cfg["signature.auto_insert"]
    ? ensureSignature(args.body, args.agentSignature, cfg["signature.prefix"])
    : args.body;

  const releaseAt = new Date(Date.now() + cfg["ops.undo_seconds"] * 1000);

  const rows = await db
    .insert(outbox)
    .values({
      idempotencyKey: args.idempotencyKey,
      ticketId: args.ticketId,
      groupJid: args.groupJid,
      agentId: args.agentId,
      body,
      mentions: args.mentions ?? null,
      attachment: args.attachment ?? null,
      replyToStanzaId: args.replyToStanzaId ?? null,
      alsoCloseTicketIds: args.alsoCloseTicketIds ?? null,
      isOnCheck: args.isOnCheck ?? false,
      markResolved: args.markResolved ?? false,
      status: "holding",
      releaseAt,
    })
    .onConflictDoNothing({ target: outbox.idempotencyKey })
    .returning({ id: outbox.id, releaseAt: outbox.releaseAt });

  if (rows.length) {
    // Jadwalkan pemicu presisi tepat saat masa undo habis
    const msUntilRelease = Math.max(0, rows[0].releaseAt.getTime() - Date.now());
    setTimeout(() => {
      flushDue().catch((err) => console.error("[outbox:scheduleFlush]", err));
    }, msUntilRelease + 100);

    return { id: rows[0].id, releaseAt: rows[0].releaseAt, duplicate: false };
  }

  // Kunci sudah ada: ini kiriman ulang dari klik yang sama. Kembalikan yang lama.
  const existing = await db
    .select({ id: outbox.id, releaseAt: outbox.releaseAt })
    .from(outbox)
    .where(eq(outbox.idempotencyKey, args.idempotencyKey))
    .limit(1);

  return { id: existing[0].id, releaseAt: existing[0].releaseAt, duplicate: true };
}

/** Undo. Hanya mungkin selama pesan masih ditahan. */
export async function cancel(id: string, agentId: number): Promise<boolean> {
  const rows = await db
    .update(outbox)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(and(eq(outbox.id, id), eq(outbox.status, "holding"), eq(outbox.agentId, agentId)))
    .returning({ ticketId: outbox.ticketId, attachment: outbox.attachment });

  if (!rows.length) return false;

  await cleanupAttachment(rows[0].attachment);
  if (rows[0].ticketId) {
    await db.insert(ticketEvents).values({ ticketId: rows[0].ticketId, agentId, action: "undo", toValue: "batal kirim" });
  }
  await publish({ t: "outbox.updated", id, ticketId: rows[0].ticketId, status: "canceled" });
  return true;
}

/**
 * Lempar semua yang jendela undo-nya sudah habis.
 * Dipanggil /api/cron/tick setiap beberapa detik.
 */
export async function flushDue(limit = 20): Promise<{ sent: number; failed: number }> {
  const claimed = await claimDue(limit);

  let sent = 0;
  let failed = 0;

  for (const row of claimed) {
    try {
      /* Percobaan ULANG saja yang diperiksa. Di percobaan pertama tidak mungkin
         ada gemanya, dan memeriksa semua kiriman justru berbahaya: agen yang
         sengaja mengirim kalimat yang sama dua kali (mis. "on check" di dua
         tiket grup yang sama) akan dikira duplikat lalu ditelan. */
      if (row.attempts > 0) {
        const gema = await cariGema(row.groupJid, row.body, row.createdAt);
        if (gema) {
          await tandaiTerkirim(row, gema, "gema ditemukan - tidak dikirim ulang");
          sent++;
          continue;
        }
      }

      const adapter = gateway();
      const result = row.attachment
        ? await adapter.sendDocument({
            groupJid: row.groupJid,
            fileName: row.attachment.fileName,
            mimetype: row.attachment.mimetype,
            data: await readTemp(row.attachment.tempPath),
            caption: row.body,
            replyToStanzaId: row.replyToStanzaId,
          })
        : await adapter.sendText({
            groupJid: row.groupJid,
            text: row.body,
            replyToStanzaId: row.replyToStanzaId,
            mentions: row.mentions ?? undefined,
          });

      await tandaiTerkirim(row, result.stanzaId, null);
      sent++;
    } catch (err) {
      failed++;
      await handleSendFailure(row.id, row.ticketId, row.agentId, (err as Error).message, row.attempts);
    }
  }

  return { sent, failed };
}

/** Tandai satu baris outbox sebagai terkirim, beserta seluruh akibatnya. */
async function tandaiTerkirim(
  row: Awaited<ReturnType<typeof claimDue>>[number],
  stanzaId: string | null,
  catatan: string | null,
): Promise<void> {
  await db
    .update(outbox)
    .set({
      status: "sent",
      sentStanzaId: stanzaId,
      lastError: catatan,
      updatedAt: new Date(),
    })
    .where(eq(outbox.id, row.id));

  // section 12: berkas sementara dihapus setelah terkirim.
  await cleanupAttachment(row.attachment);

  await applyPostSend(row.id, row.ticketId, row.agentId, row.isOnCheck, row.markResolved, row.alsoCloseTicketIds);
  await publish({ t: "outbox.updated", id: row.id, ticketId: row.ticketId, status: "sent" });
}

/**
 * Apakah pesan ini SEBENARNYA sudah sampai di WhatsApp?
 *
 * Jawaban dari API tidak bisa dipercaya penuh: koneksi yang putus SESUDAH
 * WhatsApp menerima pesan tetap terlihat seperti kegagalan di sisi kita, dan
 * percobaan ulangnya melahirkan pesan kembar di grup klien. Yang bisa
 * dipercaya adalah gema - pesan keluar kita sendiri kembali lewat webhook
 * (lihat lib/ingest.ts). Kalau gemanya ada, pesannya SUDAH terkirim, apa pun
 * kata jawaban API tadi.
 */
async function cariGema(groupJid: string, body: string, sejak: Date): Promise<string | null> {
  /* Kelonggaran satu menit ke belakang: created_at pesan memakai stempel waktu
     WhatsApp, bukan jam server kita, dan keduanya tidak pernah persis sama. */
  const batas = new Date(sejak.getTime() - 60_000);
  const rows = (await db.execute(sql`
    SELECT m.stanza_id
    FROM messages m
    WHERE m.group_jid = ${groupJid}
      AND m.direction = 'out'
      AND m.body = ${body}
      AND m.created_at >= ${ts(batas)}
    ORDER BY m.created_at DESC
    LIMIT 1
  `)) as unknown as { stanza_id: string }[];
  return rows[0]?.stanza_id ?? null;
}

/**
 * Ambil-dan-kunci baris yang jendela undo-nya sudah habis.
 *
 * Dipisah dari flushDue supaya bisa diadu dua kali berbarengan di smoke test
 * tanpa benar-benar menembak WhatsApp - lihat ujiBalapanKirim().
 */
export async function claimDue(limit = 20, exec: Pick<typeof db, "update"> = db) {
  const now = new Date();

  /*
   * Ambil-dan-kunci dalam satu operasi: dua proses cron yang tumpang tindih
   * tidak boleh mengirim baris yang sama dua kali.
   *
   * `status = 'holding'` WAJIB ikut di WHERE LUAR, bukan cuma di subquery -
   * dan ini bukan soal rapi-rapian. Diuji ke Postgres sungguhan dengan dua
   * transaksi berebut satu baris:
   *
   *   status hanya di subquery -> A dapat baris X, B JUGA dapat baris X
   *   status ikut di WHERE luar -> A dapat baris X, B tidak dapat apa-apa
   *
   * Sebabnya: di READ COMMITTED, transaksi kedua yang tertahan kunci akan
   * memeriksa ULANG qual dari UPDATE-nya sesudah yang pertama commit - tapi
   * yang diperiksa ulang hanya `id IN (...)`, dan hasil subquery-nya sudah
   * terlanjur dihitung. Predikat status yang bersembunyi di dalam subquery
   * tidak pernah ikut diperiksa lagi, jadi baris yang sudah jadi 'sending'
   * tetap lolos. Akibatnya satu pesan terkirim dua kali ke grup klien.
   */
  return await exec
    .update(outbox)
    .set({ status: "sending", updatedAt: now })
    .where(
      and(
        eq(outbox.status, "holding"),
        inArray(
          outbox.id,
          db
            .select({ id: outbox.id })
            .from(outbox)
            .where(and(eq(outbox.status, "holding"), lte(outbox.releaseAt, now)))
            .orderBy(asc(outbox.releaseAt))
            .limit(limit),
        ),
      ),
    )
    .returning();
}

async function applyPostSend(
  outboxId: string,
  ticketId: number | null,
  agentId: number,
  isOnCheck: boolean,
  shouldResolve: boolean,
  alsoClose: number[] | null,
): Promise<void> {
  if (!ticketId) return;

  await db.insert(ticketEvents).values({
    ticketId,
    agentId,
    action: isOnCheck ? "mark_on_check" : "reply_sent",
    toValue: outboxId,
  });

  /* section 6.7: "on check" adalah balasan penahan. Mengisi first_response_at,
     TIDAK mengisi resolved_at. Pengisian first_response_at sendiri dilakukan
     lib/ingest.ts saat pesan keluar kembali lewat webhook - supaya waktunya
     memakai stempel WhatsApp, bukan stempel server kita. */

  if (shouldResolve && !isOnCheck) {
    await markResolved(ticketId, agentId);
    if (alsoClose?.length) await bulkClose(alsoClose, agentId); // section 6.8
  }
}

/**
 * section 9.4: "Kirim gagal -> tiket kembali ke antrean dengan tanda merah dan teks
 * balasan masih utuh. Jangan pernah hilang diam-diam."
 *
 * Teks tetap tersimpan di outbox.body; UI halaman tiket membacanya kembali.
 */
async function handleSendFailure(
  outboxId: string,
  ticketId: number | null,
  agentId: number,
  message: string,
  attempts: number,
): Promise<void> {
  const MAX_ATTEMPTS = 3;
  const giveUp = attempts + 1 >= MAX_ATTEMPTS;

  await db
    .update(outbox)
    .set({
      // Belum menyerah: kembalikan ke antrean kirim dengan jeda mundur.
      status: giveUp ? "failed" : "holding",
      releaseAt: giveUp ? new Date() : new Date(Date.now() + (attempts + 1) * 15_000),
      attempts: attempts + 1,
      lastError: message.slice(0, 500),
      updatedAt: new Date(),
    })
    /* Hanya baris yang MEMANG sedang kita kirim. Tanpa penjaga ini, galat yang
       datang sesudah baris terlanjur ditandai 'sent' (mis. oleh flush lain,
       atau oleh jalur gema) akan menghidupkannya kembali jadi 'holding' - dan
       ia dikirim lagi. Jalur pesan kembar yang sama, pintu yang berbeda. */
    .where(and(eq(outbox.id, outboxId), eq(outbox.status, "sending")));

  if (!giveUp) return;

  if (ticketId) {
    /* Jangan menghidupkan tiket yang sudah selesai. Kiriman yang gagal pada
       tiket yang sementara itu sudah ditutup agen lain tidak boleh menariknya
       kembali ke antrean, dan tidak boleh melepas claim orang. */
    await db
      .update(tickets)
      .set({ status: "open", claimedBy: null, claimedAt: null })
      .where(and(eq(tickets.id, ticketId), inArray(tickets.status, ["open", "on_progress"])));
    await db.insert(ticketEvents).values({
      ticketId,
      agentId,
      action: "send_failed",
      toValue: message.slice(0, 200),
    });
  }

  await publish({ t: "outbox.updated", id: outboxId, ticketId, status: "failed" });
}

export type PendingOut = {
  id: string;
  body: string;
  status: "holding" | "sending" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
  releaseAt: Date;
  waAck: number | null;
  confirmedAt: Date | null;
  agentName: string | null;
  createdAt: Date;
};

/**
 * Semua kiriman milik satu tiket yang BELUM tuntas sampai ke WhatsApp.
 *
 * section 9.4: "Kirim gagal -> tiket kembali ke antrean dengan tanda merah dan teks
 * balasan masih utuh. Jangan pernah hilang diam-diam."
 *
 * Sebelum fungsi ini ada, kalimat terakhir itu dilanggar dengan cara yang
 * paling buruk: agen menekan kirim, teksnya lenyap dari layar, dan tidak ada
 * satu pun tempat di UI yang menunjukkan pesannya masih tertahan. Dari kursi
 * agen itu tidak bisa dibedakan dari "sudah terkirim".
 *
 * Yang ikut: masih ditahan, sedang dikirim, gagal, dan yang sudah dilempar tapi
 * BELUM dikonfirmasi WhatsApp - karena "API sudah dipanggil" bukan bukti
 * terkirim (section 9.4).
 */
export async function pendingForTicket(ticketId: number): Promise<PendingOut[]> {
  const rows = await db
    .select({
      id: outbox.id,
      body: outbox.body,
      status: outbox.status,
      attempts: outbox.attempts,
      lastError: outbox.lastError,
      releaseAt: outbox.releaseAt,
      waAck: outbox.waAck,
      confirmedAt: outbox.confirmedAt,
      createdAt: outbox.createdAt,
      agentName: agents.name,
    })
    .from(outbox)
    .leftJoin(agents, eq(agents.id, outbox.agentId))
    .where(
      and(
        eq(outbox.ticketId, ticketId),
        inArray(outbox.status, ["holding", "sending", "failed", "sent"]),
        // yang sudah dikonfirmasi WhatsApp tidak perlu ditampilkan lagi -
        // pesannya sudah masuk lewat webhook dan tampil sebagai pesan biasa.
        isNull(outbox.confirmedAt),
      ),
    )
    .orderBy(outbox.createdAt);

  return rows as PendingOut[];
}

/**
 * Coba kirim ulang yang sudah menyerah. Teksnya dipakai apa adanya.
 *
 * `attempts` SENGAJA TIDAK dinolkan. Angka itu bukan jatah, ia catatan: berapa
 * kali baris ini pernah ditembakkan ke WhatsApp. Menolkannya menghapus satu-
 * satunya penanda yang dipakai flushDue untuk memutuskan perlu memeriksa gema
 * atau tidak - dan justru tombol inilah jalur pesan kembar yang paling nyata:
 * pesan sebenarnya sudah sampai, tercatat gagal, lalu besoknya agen menekan
 * "Kirim ulang". Dengan angkanya utuh, gema diperiksa dulu.
 *
 * Konsekuensi yang diterima: satu kali gagal lagi sesudah ini langsung
 * menyerah, tidak dapat tiga kesempatan baru. Itu memang benar - baris ini
 * sudah gagal tiga kali sebelumnya.
 */
export async function retry(id: string, agentId: number): Promise<boolean> {
  const rows = await db
    .update(outbox)
    .set({ status: "holding", releaseAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(and(eq(outbox.id, id), eq(outbox.status, "failed")))
    .returning({ ticketId: outbox.ticketId });

  if (!rows.length) return false;
  await publish({ t: "outbox.updated", id, ticketId: rows[0].ticketId, status: "holding" });
  void agentId;
  return true;
}

/** Buang kiriman yang gagal tanpa mengirim ulang. */
export async function discard(id: string): Promise<boolean> {
  const rows = await db
    .update(outbox)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(and(eq(outbox.id, id), inArray(outbox.status, ["failed", "holding"])))
    .returning({ ticketId: outbox.ticketId, attachment: outbox.attachment });

  if (!rows.length) return false;
  await cleanupAttachment(rows[0].attachment);
  await publish({ t: "outbox.updated", id, ticketId: rows[0].ticketId, status: "canceled" });
  return true;
}

async function readTemp(path: string): Promise<Buffer> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path);
}

async function cleanupAttachment(att: OutboxAttachment | null): Promise<void> {
  if (!att?.tempPath) return;
  try {
    await unlink(att.tempPath);
  } catch {
    /* sudah terhapus */
  }
}
