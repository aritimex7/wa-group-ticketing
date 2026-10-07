"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { ticketEvents, tickets, messages } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import {
  claimTicket,
  markNotForUs,
  markResolved,
  releaseTicket,
  takeoverTicket,
  undoNotForUs,
} from "@/lib/tickets";
import { cancel, discard, enqueue, retry } from "@/lib/outbox";
import { rapikanMention } from "@/lib/mention";
import { daftarTag, orangGrup } from "@/lib/orang";
import { getSetting } from "@/lib/settings";

export type ActionResult =
  | { ok: true; message?: string; outboxId?: string; releaseAt?: string }
  | { ok: false; message: string };

/**
 * section 6.3: "Pengecekan lock dilakukan di server saat tombol kirim ditekan, bukan
 * saat tiket dibuka. Layar bisa basi; server tidak."
 *
 * Semua aksi di bawah memeriksa ulang keadaan di server. Tidak ada satu pun
 * yang mempercayai apa yang terlihat di layar agen.
 */

export async function actClaim(ticketId: number): Promise<ActionResult> {
  const me = await requireAgent();
  const res = await claimTicket(ticketId, me.id);
  revalidatePath("/");
  revalidatePath(`/tiket/${ticketId}`);

  if (res.ok) return { ok: true };
  if (res.reason === "closed") return { ok: false, message: "Tiket ini sudah ditutup." };
  return { ok: false, message: `${res.byName} sudah mengambil tiket ini.` };
}

export async function actTakeover(ticketId: number): Promise<ActionResult> {
  const me = await requireAgent();
  const res = await takeoverTicket(ticketId, me.id);
  revalidatePath("/");
  revalidatePath(`/tiket/${ticketId}`);
  return res.ok ? { ok: true } : { ok: false, message: "Tiket ini sudah ditutup." };
}

export async function actRelease(ticketId: number): Promise<ActionResult> {
  const me = await requireAgent();
  await releaseTicket(ticketId, me.id);
  revalidatePath("/");
  revalidatePath(`/tiket/${ticketId}`);
  return { ok: true };
}

export async function actResolve(ticketId: number): Promise<ActionResult> {
  const me = await requireAgent();
  await markResolved(ticketId, me.id);
  revalidatePath("/");
  revalidatePath(`/tiket/${ticketId}`);
  return { ok: true };
}

/** section 6.5 satu klik, tanpa menyimpan alasan, ada undo beberapa detik. */
export async function actNotForUs(ticketId: number): Promise<ActionResult> {
  const me = await requireAgent();
  await markNotForUs(ticketId, me.id);
  revalidatePath("/");
  revalidatePath(`/tiket/${ticketId}`);
  return { ok: true, message: "Ditandai bukan untuk kami." };
}

export async function actUndoNotForUs(ticketId: number): Promise<ActionResult> {
  const me = await requireAgent();
  await undoNotForUs(ticketId, me.id);
  revalidatePath("/");
  revalidatePath(`/tiket/${ticketId}`);
  return { ok: true, message: "Dikembalikan ke antrean." };
}

/** section 4.4 catatan serah terima antar shift. */
export async function actSaveNote(ticketId: number, note: string): Promise<ActionResult> {
  const me = await requireAgent();
  await db.update(tickets).set({ note: note.slice(0, 2000) }).where(eq(tickets.id, ticketId));
  await db.insert(ticketEvents).values({ ticketId, agentId: me.id, action: "note_updated" });
  revalidatePath(`/tiket/${ticketId}`);
  return { ok: true, message: "Catatan disimpan." };
}

export type SendArgs = {
  ticketId: number;
  idempotencyKey: string;
  body: string;
  /** section 6.7 balasan menempel ke pesan asli klien, bukan ke pesan "on check" sendiri. */
  replyToStanzaId: string | null;
  isOnCheck: boolean;
  markResolved: boolean;
  /** section 6.8 tiket lain dari grup yang sama yang ikut ditutup. */
  alsoCloseTicketIds: number[];
};

/**
 * section 9.4 pengaman pengiriman. Pesan TIDAK langsung dilempar ke WhatsApp -
 * masuk outbox dan ditahan selama jendela undo. Lihat lib/outbox.ts.
 */
export async function actSend(args: SendArgs): Promise<ActionResult> {
  const me = await requireAgent();

  /* section 6.7: "on check" boleh dikirim tanpa mengetik apa pun - itu inti
     gunanya. Kalimatnya diambil dari setelan, jadi satu klik cukup dan seluruh
     tim memakai kalimat yang sama di depan klien. */
  let body = args.body.trim();
  if (!body && args.isOnCheck) body = (await getSetting("ops.on_check_text")).trim();
  if (!body) return { ok: false, message: "Teks balasan masih kosong." };

  const rows = await db
    .select({
      groupJid: tickets.groupJid,
      status: tickets.status,
      claimedBy: tickets.claimedBy,
      stanzaId: tickets.stanzaId,
    })
    .from(tickets)
    .where(eq(tickets.id, args.ticketId))
    .limit(1);

  const t = rows[0];
  if (!t) return { ok: false, message: "Tiket tidak ditemukan." };
  if (t.status === "closed" || t.status === "not_for_us") {
    return { ok: false, message: "Tiket ini sudah ditutup." };
  }

  // section 6.3 pengecekan lock DI SINI, saat kirim - bukan saat tiket dibuka.
  if (t.claimedBy !== null && t.claimedBy !== me.id) {
    return { ok: false, message: "Tiket ini sedang ditangani orang lain. Ambil alih dulu kalau perlu." };
  }

  if (t.claimedBy === null) {
    const claim = await claimTicket(args.ticketId, me.id);
    if (!claim.ok) {
      return {
        ok: false,
        message: claim.reason === "closed" ? "Tiket ini sudah ditutup." : `${claim.byName} sudah mengambil tiket ini.`,
      };
    }
  }

  /* section 12 mention. Dibaca ULANG dari teks di sini, bukan dari daftar yang
     dipilih di kotak balas, supaya tidak pernah ada mention hantu: agen sering
     memilih orang lalu menghapus lagi tulisannya. Yang berlaku adalah apa yang
     benar-benar berdiri di teks saat tombol kirim ditekan.

     Ini juga yang membetulkan "@+6281200000099" - tanda "+" saja sudah cukup
     membuat WhatsApp tidak mengenalinya sebagai tag. */
  const [orang, daftar] = await Promise.all([orangGrup(t.groupJid), daftarTag()]);
  const tag = rapikanMention(body, orang, daftar);

  /* Daftar yang mekar jadi nol orang DITOLAK, bukan dibuang diam-diam.
     Dua-duanya buruk kalau dibiarkan lewat: kalau teksnya dibiarkan, klien
     membaca "mohon dibantu @sameday" dan bingung; kalau dihapus, agen mengira
     sudah menandai orang padahal tidak ada yang diberi tahu. */
  if (tag.daftarKosong.length) {
    return {
      ok: false,
      message:
        tag.daftarKosong.length === 1
          ? `Tidak ada anggota "${tag.daftarKosong[0]}" di grup ini. Hapus tagnya atau tandai orangnya satu per satu.`
          : `Daftar ini tidak punya anggota di grup ini: ${tag.daftarKosong.join(", ")}.`,
    };
  }
  body = tag.teks;

  // Jika membalas pesan tertentu (replyToStanzaId), pastikan pesan target belum dihapus pengirimnya.
  const targetId = args.replyToStanzaId ?? t.stanzaId;
  if (targetId) {
    const targetMsg = await db
      .select({ isDeleted: messages.isDeleted })
      .from(messages)
      .where(eq(messages.stanzaId, targetId))
      .limit(1);
    if (targetMsg[0]?.isDeleted) {
      return { ok: false, message: "Pesan sudah dihapus pengirim. Silakan close ticket." };
    }
  }

  const res = await enqueue({
    idempotencyKey: args.idempotencyKey,
    ticketId: args.ticketId,
    groupJid: t.groupJid,
    agentId: me.id,
    agentSignature: me.signatureCode,
    body,
    mentions: tag.mentions.length ? tag.mentions : undefined,
    replyToStanzaId: args.replyToStanzaId ?? t.stanzaId,
    isOnCheck: args.isOnCheck,
    markResolved: args.markResolved,
    alsoCloseTicketIds: args.alsoCloseTicketIds,
  });

  revalidatePath("/");
  revalidatePath(`/tiket/${args.ticketId}`);

  return {
    ok: true,
    outboxId: res.id,
    releaseAt: res.releaseAt.toISOString(),
    message: res.duplicate ? "Kiriman ini sudah tercatat sebelumnya." : undefined,
  };
}

/** Undo sungguhan: batalkan sebelum pesan pernah menyentuh WhatsApp. */
export async function actCancelSend(outboxId: string, ticketId: number): Promise<ActionResult> {
  const me = await requireAgent();
  const done = await cancel(outboxId, me.id);
  revalidatePath(`/tiket/${ticketId}`);
  return done
    ? { ok: true, message: "Batal. Pesan tidak jadi dikirim." }
    : { ok: false, message: "Terlambat - pesan sudah dilempar ke WhatsApp." };
}

/** section 9.4 kirim ulang yang sudah menyerah. Teks dipakai apa adanya. */
export async function actRetrySend(outboxId: string, ticketId: number): Promise<ActionResult> {
  const me = await requireAgent();
  const ok = await retry(outboxId, me.id);
  revalidatePath(`/tiket/${ticketId}`);
  revalidatePath("/");
  return ok
    ? { ok: true, message: "Diantre ulang." }
    : { ok: false, message: "Kiriman ini sudah tidak dalam keadaan gagal." };
}

/** Buang kiriman gagal tanpa mengirim ulang. */
export async function actDiscardSend(outboxId: string, ticketId: number): Promise<ActionResult> {
  await requireAgent();
  const ok = await discard(outboxId);
  revalidatePath(`/tiket/${ticketId}`);
  revalidatePath("/");
  return ok ? { ok: true, message: "Dibuang." } : { ok: false, message: "Sudah tidak bisa dibuang." };
}
