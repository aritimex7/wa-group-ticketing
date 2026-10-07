/**
 * Aturan tiket - SPEC section 6.
 *
 * Aturan pokok: 1 pesan masuk = 1 tiket (section 4.4).
 *
 * Yang paling gampang salah dan sudah dijaga di sini:
 *   section 6.1  "#dsp xx" adalah tanda tangan balasan tim, BUKAN pemicu tiket.
 *   section 6.3  Perebutan claim dijaga operasi atomik, bukan cek-lalu-tulis.
 *   section 6.4  likely_not_ours hanya diset kalau kita YAKIN yang di-reply orang lain.
 *                Kalau identitas tidak bisa dibandingkan (satu sisi cuma LID,
 *                sisi lain cuma PN), kita diam - bukan menebak lalu memberi
 *                penanda kuning yang salah.
 *   section 6.6  Pesan yang kena filter TIDAK dibuang, tapi masuk keranjang.
 */
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, ts } from "@/db";
import {
  agents,
  internalNumbers,
  ignoredPhrases,
  messages,
  ticketEvents,
  tickets,
  triageBucket,
  type Group,
} from "@/db/schema";
import {
  compareIdentity,
  isGroupJid,
  matchesAny,
  mentionsSelf,
  mentionsSelfInText,
  selfIdentity,
  type Identity,
} from "@/lib/identity";
import { getSettings } from "@/lib/settings";
import { publish } from "@/lib/events";
import type { NormalizedMessage } from "@/lib/gateway/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/* ----------------------------- filter: cache ----------------------------- */

type FilterSet = { internal: Identity[]; phrases: { phrase: string; mode: string }[] };
let filterCache: { at: number; value: FilterSet } | null = null;

async function loadFilters(): Promise<FilterSet> {
  if (filterCache && Date.now() - filterCache.at < 5_000) return filterCache.value;

  const [nums, phr] = await Promise.all([
    db.select().from(internalNumbers).where(eq(internalNumbers.isActive, true)),
    db.select().from(ignoredPhrases).where(eq(ignoredPhrases.isActive, true)),
  ]);

  const value: FilterSet = {
    internal: nums.map((n) => ({ pn: n.pn, lid: n.lid })),
    phrases: phr.map((p) => ({ phrase: normalizePhrase(p.phrase), mode: p.matchMode })),
  };
  filterCache = { at: Date.now(), value };
  return value;
}

export function invalidateFilterCache(): void {
  filterCache = null;
}

/** Turunkan variasi ketikan supaya "Ok!!" , "ok." dan "OK" jadi satu bentuk. */
export function normalizePhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export type PhraseVerdict = { hit: "ignored" | "needs_review" | null; rule: string | null };

/**
 * section 6.6: yang persis -> keranjang "diabaikan". Yang MIRIP tapi tidak persis ->
 * keranjang "perlu ditinjau". Tidak ada cabang ketiga yang membuang pesan.
 */
export function judgePhrase(body: string | null, phrases: { phrase: string; mode: string }[]): PhraseVerdict {
  if (!body) return { hit: null, rule: null };
  const norm = normalizePhrase(body);
  if (!norm) return { hit: null, rule: null };

  for (const p of phrases) {
    if (!p.phrase) continue;
    if (p.mode === "prefix" ? norm.startsWith(p.phrase) : norm === p.phrase) {
      return { hit: "ignored", rule: `frasa: ${p.phrase}` };
    }
  }

  // Hanya untuk pesan pendek. Kalimat panjang yang kebetulan mirip "ok" tidak ada.
  if (norm.length <= 24) {
    for (const p of phrases) {
      if (!p.phrase) continue;
      if (levenshtein(norm, p.phrase) <= 2) {
        return { hit: "needs_review", rule: `mirip frasa: ${p.phrase}` };
      }
    }
  }
  return { hit: null, rule: null };
}

/* --------------------------- pembuatan tiket --------------------------- */

export type TicketDecision =
  | { action: "none"; reason: string }
  | { action: "bucket"; kind: "ignored" | "needs_review"; rule: string }
  | { action: "create"; triggerType: "mention" | "reply" | "dm"; likelyNotOurs: boolean; notes: string[] };

/**
 * Keputusan murni (tanpa efek samping) supaya bisa diuji dan supaya alasannya
 * bisa ditampilkan di UI saat leader bertanya "kenapa ini tidak jadi tiket?".
 */
export async function decideTicket(msg: NormalizedMessage): Promise<TicketDecision> {
  const self = selfIdentity();
  const notes: string[] = [];

  // section 6.1 pesan dari akun sendiri tidak pernah jadi tiket.
  if (msg.fromMe) return { action: "none", reason: "pesan dari akun sendiri" };

  const [filters, cfg] = await Promise.all([
    loadFilters(),
    getSettings([
      "trigger.mention_creates_ticket",
      "trigger.reply_creates_ticket",
      "trigger.dm_creates_ticket",
    ] as const),
  ]);

  // section 6.1 nomor internal diabaikan - tapi tetap masuk keranjang supaya
  // salah daftar bisa ketahuan, bukan hilang tanpa jejak (semangat section 6.6).
  if (matchesAny(msg.sender, filters.internal)) {
    return { action: "bucket", kind: "ignored", rule: "nomor internal" };
  }

  /* --- pemicu --- */
  /* Dua jalur deteksi mention, dan jalur kedua BUKAN pelengkap yang jarang
     terpakai: di data sungguhan grup pertama, mentionedJid selalu null dan
     seluruh mention hanya ada sebagai teks "@<LID>". Tanpa jalur kedua,
     tidak akan pernah ada satu tiket pun. Lihat mentionsSelfInText(). */
  const mentionedViaArray = mentionsSelf(msg.mentionedJids, self);
  const mentionedViaText = !mentionedViaArray && mentionsSelfInText(msg.body, self);
  const mentioned = mentionedViaArray || mentionedViaText;
  const replyCmp = msg.replyToStanzaId ? compareIdentity(msg.replyToSender, self) : "unknown";
  const repliedToUs = replyCmp === "match";

  /* CHAT PRIBADI tidak punya pemicu, dan itu bukan kekurangan - tiap pesan yang
     masuk ke sana memang ditujukan ke kita. Tidak ada yang perlu ditebak, jadi
     jalurnya dipisah sejak awal: tidak ada mention, tidak ada "mungkin bukan
     untuk kita", tidak ada reply yang identitasnya tidak bisa dibandingkan.
     Yang tetap berlaku: nomor internal (di atas) dan frasa diabaikan (di bawah). */
  const dm = !isGroupJid(msg.groupJid);

  let triggerType: "mention" | "reply" | "dm" | null = null;
  if (dm) {
    if (!cfg["trigger.dm_creates_ticket"]) {
      return { action: "none", reason: "chat pribadi tidak membuat tiket (setelan)" };
    }
    triggerType = "dm";
  } else if (mentioned && cfg["trigger.mention_creates_ticket"]) triggerType = "mention";
  else if (repliedToUs && cfg["trigger.reply_creates_ticket"]) triggerType = "reply";

  if (!triggerType) {
    if (mentioned || repliedToUs) return { action: "none", reason: "pemicu dimatikan di setelan" };
    if (msg.replyToStanzaId && replyCmp === "unknown") {
      // Jujur soal ini: kita tidak bisa memastikan reply ini ke kita atau bukan.
      // Bukan tiket, tapi wajib ditinjau - persis kasus kegagalan senyap LID.
      return {
        action: "bucket",
        kind: "needs_review",
        rule: "reply tapi identitas pemilik pesan tidak bisa dibandingkan (PN vs LID)",
      };
    }
    return { action: "none", reason: "tidak mention dan tidak reply ke kita" };
  }

  // section 6.6 filter frasa dijalankan SETELAH pemicu, supaya pesan yang tidak
  // menyapa kita sama sekali tidak ikut memenuhi keranjang.
  const verdict = judgePhrase(msg.body, filters.phrases);
  if (verdict.hit) return { action: "bucket", kind: verdict.hit, rule: verdict.rule! };

  /* --- section 6.4 kemungkinan bukan untuk kita --- */
  let likelyNotOurs = false;
  if (triggerType === "mention" && msg.replyToStanzaId) {
    const cmp = compareIdentity(msg.replyToSender, self);
    if (cmp === "differ") {
      likelyNotOurs = true;
      notes.push("mention kita, tapi sedang me-reply orang lain");
    } else if (cmp === "unknown") {
      notes.push("tidak bisa memastikan pesan yang di-reply milik siapa (PN vs LID)");
    }
  }

  if (mentionedViaText) {
    // Ditandai supaya panel Kesehatan Data bisa memperlihatkan seberapa besar
    // ketergantungan pada jalur cadangan ini.
    notes.push("mention terdeteksi dari teks, mentionedJid kosong");
  }

  return { action: "create", triggerType, likelyNotOurs, notes };
}

/* ------------------- 6.9 pesan susulan menempel, tidak beranak ------------------- */

/**
 * Cari tiket yang seharusnya MENAMPUNG pesan ini, bukan membuat tiket baru.
 *
 * PENYIMPANGAN SADAR dari section 4.4 "1 pesan masuk = 1 tiket", diminta pemilik
 * setelah terlihat di pemakaian nyata: satu orang menyapa dua kali sebelum
 * sempat dibalas menghasilkan dua baris "Open" yang isinya permintaan yang
 * sama. Bagi agen itu bukan dua pekerjaan - itu satu pekerjaan yang terlihat
 * dua kali, dan menutup salah satunya selalu terasa seperti menyembunyikan
 * sesuatu.
 *
 * DUA JALUR, dan bedanya adalah seberapa banyak yang kita tebak. Yang pasti
 * dicoba lebih dulu, dan karena kepastiannya ia boleh lebih longgar.
 *
 *   Jalur 1 - klien swipe-reply pesan yang sudah jadi anggota sebuah tiket.
 *             Tidak ada tebakan: WhatsApp sendiri yang memberi kaitannya.
 *   Jalur 2 - pengirim yang sama menyapa lagi tanpa reply. Ini tebakan
 *             berdasarkan "orang yang sama, berdekatan waktu", jadi dibatasi.
 *
 * Syarat yang berlaku di KEDUA jalur, dan tidak boleh dilonggarkan:
 *
 *  - PENGIRIM SAMA, dibandingkan persis seperti compareIdentity(): cocok kalau
 *    ada satu sumbu yang sama-sama terisi dan nilainya sama. Kalau tiket lama
 *    hanya punya PN dan pesan ini hanya punya LID, hasilnya "tidak tahu" -
 *    dan "tidak tahu" TIDAK PERNAH digabung. Menebak di sini berarti
 *    menempelkan pertanyaan orang lain ke tiket yang salah.
 *  - TIKETNYA MASIH HIDUP (open / on_progress). Tiket yang sudah ditutup tidak
 *    pernah dibuka lagi diam-diam: pesan yang datang setelah perkara selesai
 *    memang perkara baru. Status on_progress ikut, karena agen yang sedang
 *    memegang tiket justru paling butuh pesan susulan mendarat di layar yang
 *    sedang ia buka.
 *
 * Syarat yang HANYA berlaku di jalur 2, karena di sanalah ada tebakan:
 *
 *  - GRUP SAMA.
 *  - BELUM DIBALAS (first_response_at IS NULL). Tanpa kaitan dari WhatsApp,
 *    satu-satunya alasan menganggap dua pesan itu satu permintaan adalah
 *    keduanya sama-sama belum dijawab. Begitu sudah ada balasan, pesan
 *    berikutnya berdiri sendiri supaya jam SLA-nya ikut jalan.
 *  - MASIH DALAM JENDELA. Tiket menganggur sejak pagi tidak boleh menelan
 *    pertanyaan sore yang tidak ada hubungannya lalu melaporkannya sebagai
 *    terlambat delapan jam.
 */
async function findMergeTarget(tx: Tx, msg: NormalizedMessage, windowMin: number): Promise<number | null> {
  const { pn, lid } = msg.sender;
  if (!pn && !lid) return null; // tanpa identitas tidak ada yang bisa dibandingkan

  /* Cocok pengirim, dipakai dua kali di bawah. Persis compareIdentity():
     satu sumbu sama-sama terisi dan nilainya sama. PN lawan LID = tidak tahu,
     dan tidak tahu tidak pernah digabung. */
  const pengirimSama = sql`(
    (${pn}::text IS NOT NULL AND awal.sender_pn = ${pn}::text)
    OR (${lid}::text IS NOT NULL AND awal.sender_lid = ${lid}::text)
  )`;

  /* ---------- JALUR 1: kaitan yang DIBERITAHU WhatsApp ---------- */
  /*
   * Klien swipe-reply pesan kita yang sudah tercatat sebagai anggota sebuah
   * tiket. Ini kasus "on check": kita kirim penahan ("kami cek dulu ya"),
   * klien membalasnya "oke ditunggu", dan sebelum ini jawaban itu jadi tiket
   * baru yang tidak ada isinya - agen menutupnya cuma untuk membersihkan papan.
   *
   * Bedanya dengan jalur 2 penting, dan itu yang membuat jalur ini boleh lebih
   * longgar: di sini tidak ada tebakan sama sekali. WhatsApp sendiri yang
   * bilang pesan ini membalas pesan yang mana, dan pesan itu sudah punya
   * ticket_id. Karena itu:
   *
   *   - TIDAK pakai jendela waktu. Jendela ada untuk membatasi tebakan; di sini
   *     tidak ada yang ditebak. Tiket yang di-on-check tiga jam lalu lalu
   *     ditanya "gimana bang?" tetap tiket yang sama.
   *   - TIDAK mensyaratkan tiketnya belum dibalas. Justru sebaliknya: on check
   *     SELALU mengisi first_response_at (6.7) tanpa menuntaskan, jadi syarat
   *     "belum dibalas" akan meleset persis di kasus yang mau ditolong.
   *
   * Yang tetap dijaga: tiketnya masih hidup (open/on_progress). Tiket yang
   * sudah ditutup TIDAK dibuka lagi diam-diam - pesan baru setelah perkara
   * selesai memang perkara baru.
   */
  if (msg.replyToStanzaId) {
    const lewatReply = (await tx.execute(sql`
      SELECT t.id
      FROM messages induk
      JOIN tickets t   ON t.id = induk.ticket_id
      JOIN messages awal ON awal.stanza_id = t.stanza_id
      WHERE induk.stanza_id = ${msg.replyToStanzaId}
        AND t.status IN ('open', 'on_progress')
        AND ${pengirimSama}
      LIMIT 1
      FOR UPDATE OF t
    `)) as unknown as { id: number }[];

    if (lewatReply[0]) return lewatReply[0].id;
  }

  /* ---------- JALUR 2: tebakan berjendela ---------- */
  if (windowMin <= 0) return null;

  const cutoff = new Date(msg.timestamp.getTime() - windowMin * 60_000);

  /* FOR UPDATE OF t mengunci baris tiketnya sampai transaksi ingestion selesai.
     Dua pesan susulan yang datang berbarengan jadi antre, bukan saling
     menimpa. Yang TIDAK dijaga di sini: dua pesan PERTAMA yang datang
     bersamaan saat belum ada tiket sama sekali - tidak ada baris untuk
     dikunci. Itu balapan bawaan, dan dengan volume grup pelanggan (hitungan
     pesan per menit) harganya jauh lebih murah daripada advisory lock. */
  const found = (await tx.execute(sql`
    SELECT t.id
    FROM tickets t
    JOIN messages awal ON awal.stanza_id = t.stanza_id
    WHERE t.group_jid = ${msg.groupJid}
      AND t.status IN ('open', 'on_progress')
      AND t.first_response_at IS NULL
      AND t.triggered_at >= ${ts(cutoff)}
      AND t.triggered_at <= ${ts(msg.timestamp)}
      AND ${pengirimSama}
    ORDER BY t.triggered_at DESC
    LIMIT 1
    FOR UPDATE OF t
  `)) as unknown as { id: number }[];

  return found[0]?.id ?? null;
}

export type ApplyResult = { id: number; merged: boolean } | null;

/**
 * Terapkan keputusan. Dijalankan di dalam transaksi ingestion supaya pesan dan
 * tiketnya tidak pernah setengah jadi.
 */
export async function applyTicketDecision(
  tx: Tx,
  msg: NormalizedMessage,
  group: Group,
  decision: TicketDecision,
): Promise<ApplyResult> {
  if (decision.action === "none") return null;

  if (decision.action === "bucket") {
    await tx
      .insert(triageBucket)
      .values({
        stanzaId: msg.stanzaId,
        groupJid: msg.groupJid,
        kind: decision.kind,
        matchedRule: decision.rule,
      })
      .onConflictDoNothing();
    return null;
  }

  const globals = await getSettings([
    "sla.first_response_min",
    "sla.resolution_min",
    "ticket.merge_window_min",
  ] as const);

  const induk = await findMergeTarget(tx, msg, globals["ticket.merge_window_min"]);
  if (induk !== null) {
    await tx.update(messages).set({ ticketId: induk }).where(eq(messages.stanzaId, msg.stanzaId));
    await tx.insert(ticketEvents).values({
      ticketId: induk,
      agentId: null,
      action: "merged",
      toValue: `pesan susulan (${decision.triggerType}) dari pengirim yang sama`,
    });
    return { id: induk, merged: true };
  }

  // section 4.4 target DISALIN, bukan direferensikan. Mengubah setelan besok tidak
  // boleh mengubah arti laporan hari ini.
  const frTarget = group.slaFirstResponseMin ?? globals["sla.first_response_min"];
  const resTarget = group.slaResolutionMin ?? globals["sla.resolution_min"];

  const inserted = await tx
    .insert(tickets)
    .values({
      stanzaId: msg.stanzaId,
      groupJid: msg.groupJid,
      status: "open",
      triggerType: decision.triggerType,
      likelyNotOurs: decision.likelyNotOurs,
      slaTargetFrMin: frTarget,
      slaTargetResMin: resTarget,
      triggeredAt: msg.timestamp,
    })
    .onConflictDoNothing({ target: tickets.stanzaId })
    .returning({ id: tickets.id });

  const id = inserted[0]?.id ?? null;
  if (!id) return null;

  // Pesan pemicu juga ditandai, supaya messages.ticket_id berarti satu hal saja:
  // "pesan ini bagian dari tiket X" - tanpa perlu tahu ia pemicu atau susulan.
  await tx.update(messages).set({ ticketId: id }).where(eq(messages.stanzaId, msg.stanzaId));
  await tx.insert(ticketEvents).values({
    ticketId: id,
    agentId: null,
    action: "created",
    toValue: decision.notes.length ? decision.notes.join(" | ") : decision.triggerType,
  });
  return { id, merged: false };
}

/* ------------------------------ claim & lock ------------------------------ */

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: "taken"; byName: string }
  | { ok: false; reason: "closed" };

/**
 * section 6.3 "Perebutan claim harus pakai operasi atomik supaya dua klik bersamaan
 * hanya menghasilkan satu pemenang."
 *
 * Syaratnya ada di WHERE, bukan di SELECT sebelumnya. Tidak ada celah antara
 * membaca dan menulis.
 */
export async function claimTicket(ticketId: number, agentId: number): Promise<ClaimResult> {
  const won = await db
    .update(tickets)
    .set({ status: "on_progress", claimedBy: agentId, claimedAt: new Date() })
    .where(
      and(
        eq(tickets.id, ticketId),
        eq(tickets.status, "open"),
        isNull(tickets.claimedBy),
      ),
    )
    .returning({ id: tickets.id, groupJid: tickets.groupJid });

  if (won.length) {
    await db.insert(ticketEvents).values({ ticketId, agentId, action: "claim" });
    const who = await agentName(agentId);
    await publish({ t: "ticket.claimed", id: ticketId, group: won[0].groupJid, by: agentId, byName: who });
    return { ok: true };
  }

  // Kalah. Cari tahu kenapa, supaya pesannya berguna: "{nama} sudah mengambil tiket ini".
  const current = await db
    .select({ status: tickets.status, claimedBy: tickets.claimedBy })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  const row = current[0];
  if (!row) return { ok: false, reason: "closed" };
  if (row.claimedBy === agentId) return { ok: true }; // sudah milik dia sendiri
  if (row.status === "closed" || row.status === "not_for_us") return { ok: false, reason: "closed" };
  return { ok: false, reason: "taken", byName: row.claimedBy ? await agentName(row.claimedBy) : "orang lain" };
}

/** section 6.3 takeover: bebas, tanpa izin, tapi wajib tercatat. */
export async function takeoverTicket(ticketId: number, agentId: number): Promise<ClaimResult> {
  const before = await db
    .select({ claimedBy: tickets.claimedBy, status: tickets.status, groupJid: tickets.groupJid })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  const prev = before[0];
  if (!prev) return { ok: false, reason: "closed" };
  if (prev.status === "closed" || prev.status === "not_for_us") return { ok: false, reason: "closed" };

  await db
    .update(tickets)
    .set({ status: "on_progress", claimedBy: agentId, claimedAt: new Date() })
    .where(eq(tickets.id, ticketId));

  await db.insert(ticketEvents).values({
    ticketId,
    agentId,
    action: "takeover",
    fromValue: prev.claimedBy ? String(prev.claimedBy) : null,
    toValue: String(agentId),
  });

  const who = await agentName(agentId);
  await publish({
    t: "ticket.takenover",
    id: ticketId,
    group: prev.groupJid,
    by: agentId,
    byName: who,
    from: prev.claimedBy ?? 0,
  });
  return { ok: true };
}

export async function releaseTicket(ticketId: number, agentId: number | null, auto = false): Promise<void> {
  const rows = await db
    .update(tickets)
    .set({ status: "open", claimedBy: null, claimedAt: null })
    .where(and(eq(tickets.id, ticketId), eq(tickets.status, "on_progress")))
    .returning({ groupJid: tickets.groupJid });

  if (!rows.length) return;
  await db.insert(ticketEvents).values({
    ticketId,
    agentId,
    action: auto ? "auto_release" : "release",
  });
  await publish({ t: "ticket.released", id: ticketId, group: rows[0].groupJid });
}

/**
 * section 6.3 auto-release. "Ini yang mencegah tiket nyangkut saat pergantian shift."
 * Dipanggil berkala oleh /api/cron/tick.
 */
export async function autoReleaseStale(): Promise<number> {
  const cfg = await getSettings(["ops.auto_release_min"] as const);
  const cutoff = new Date(Date.now() - cfg["ops.auto_release_min"] * 60_000);

  // Lepas kalau agen pemegangnya tidak punya sesi yang masih hidup.
  const stale = await db.execute(sql`
    SELECT t.id, t.group_jid, t.claimed_by
    FROM tickets t
    WHERE t.status = 'on_progress'
      AND t.claimed_at < ${ts(cutoff)}
      AND NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.agent_id = t.claimed_by
          AND s.revoked_at IS NULL
          AND s.last_seen_at >= ${ts(cutoff)}
      )
  `);

  const rows = stale as unknown as { id: number }[];
  for (const r of rows) await releaseTicket(r.id, null, true);
  return rows.length;
}

/* --------------------------- perubahan status --------------------------- */

/** section 6.7 "on check" mengisi first_response_at, TIDAK mengisi resolved_at. */
export async function recordFirstResponse(tx: Tx, ticketId: number, agentId: number, at: Date): Promise<void> {
  await tx
    .update(tickets)
    .set({ firstResponseAt: at, firstResponderId: agentId })
    .where(and(eq(tickets.id, ticketId), isNull(tickets.firstResponseAt)));
}

export async function markResolved(ticketId: number, agentId: number): Promise<void> {
  const now = new Date();
  const rows = await db
    .update(tickets)
    .set({
      status: "closed",
      resolvedAt: sql`coalesce(${tickets.resolvedAt}, ${ts(now)})`,
      resolvedBy: sql`coalesce(${tickets.resolvedBy}, ${agentId})`,
      closedAt: now,
      closedBy: agentId,
      firstResponseAt: sql`coalesce(${tickets.firstResponseAt}, ${ts(now)})`,
      firstResponderId: sql`coalesce(${tickets.firstResponderId}, ${agentId})`,
    })
    .where(and(eq(tickets.id, ticketId), ne(tickets.status, "not_for_us")))
    .returning({ groupJid: tickets.groupJid });

  if (!rows.length) return;
  await db.insert(ticketEvents).values({ ticketId, agentId, action: "mark_resolved" });
  await publish({ t: "ticket.updated", id: ticketId, group: rows[0].groupJid, status: "closed" });
}

/**
 * section 6.5 "Bukan untuk kami": satu klik, tanpa menyimpan alasan, tidak dihitung
 * di SLA maupun jumlah tiket agen, ada undo beberapa detik.
 */
export async function markNotForUs(ticketId: number, agentId: number): Promise<void> {
  const now = new Date();
  const rows = await db
    .update(tickets)
    .set({ status: "not_for_us", closedAt: now, closedBy: agentId, claimedBy: null, claimedAt: null })
    .where(eq(tickets.id, ticketId))
    .returning({ groupJid: tickets.groupJid });

  if (!rows.length) return;
  await db.insert(ticketEvents).values({ ticketId, agentId, action: "mark_not_for_us" });
  await publish({ t: "ticket.updated", id: ticketId, group: rows[0].groupJid, status: "not_for_us" });
}

export async function undoNotForUs(ticketId: number, agentId: number): Promise<void> {
  const rows = await db
    .update(tickets)
    .set({ status: "open", closedAt: null, closedBy: null })
    .where(and(eq(tickets.id, ticketId), eq(tickets.status, "not_for_us")))
    .returning({ groupJid: tickets.groupJid });

  if (!rows.length) return;
  await db.insert(ticketEvents).values({ ticketId, agentId, action: "undo", fromValue: "not_for_us", toValue: "open" });
  await publish({ t: "ticket.updated", id: ticketId, group: rows[0].groupJid, status: "open" });
}

/**
 * section 6.8 "Satu balasan menutup beberapa tiket."
 * Karena 1 pesan = 1 tiket, klien yang mengirim 3 pesan beruntun menghasilkan
 * 3 tiket yang biasanya dijawab sekali.
 */
export async function otherOpenTicketsInGroup(groupJid: string, excludeTicketId: number) {
  return db
    .select({
      id: tickets.id,
      triggeredAt: tickets.triggeredAt,
      status: tickets.status,
      body: messages.body,
      pushName: messages.senderPushName,
    })
    .from(tickets)
    .innerJoin(messages, eq(messages.stanzaId, tickets.stanzaId))
    .where(
      and(
        eq(tickets.groupJid, groupJid),
        ne(tickets.id, excludeTicketId),
        inArray(tickets.status, ["open", "on_progress"]),
      ),
    )
    .orderBy(desc(tickets.triggeredAt))
    .limit(10);
}

export async function bulkClose(ticketIds: number[], agentId: number): Promise<void> {
  if (!ticketIds.length) return;
  const now = new Date();
  const rows = await db
    .update(tickets)
    .set({
      status: "closed",
      closedAt: now,
      closedBy: agentId,
      resolvedAt: sql`coalesce(${tickets.resolvedAt}, ${ts(now)})`,
      resolvedBy: sql`coalesce(${tickets.resolvedBy}, ${agentId})`,
      firstResponseAt: sql`coalesce(${tickets.firstResponseAt}, ${ts(now)})`,
      firstResponderId: sql`coalesce(${tickets.firstResponderId}, ${agentId})`,
    })
    .where(and(inArray(tickets.id, ticketIds), ne(tickets.status, "not_for_us")))
    .returning({ id: tickets.id, groupJid: tickets.groupJid });

  for (const r of rows) {
    await db.insert(ticketEvents).values({ ticketId: r.id, agentId, action: "bulk_closed" });
    await publish({ t: "ticket.updated", id: r.id, group: r.groupJid, status: "closed" });
  }
}

/* -------------------------------- bantu -------------------------------- */

const nameCache = new Map<number, string>();
export async function agentName(id: number): Promise<string> {
  const hit = nameCache.get(id);
  if (hit) return hit;
  const rows = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).limit(1);
  const name = rows[0]?.name ?? `Agen #${id}`;
  nameCache.set(id, name);
  return name;
}

/** Dipakai UI: apakah tiket ini sudah lewat / mendekati target SLA. */
export function slaState(
  triggeredAt: Date,
  targetMin: number,
  warnPct: number,
  doneAt: Date | null,
  now = new Date(),
): { elapsedMs: number; pct: number; level: "ok" | "warn" | "breach" } {
  const end = doneAt ?? now;
  const elapsedMs = end.getTime() - triggeredAt.getTime();
  const targetMs = targetMin * 60_000;
  const pct = targetMs > 0 ? (elapsedMs / targetMs) * 100 : 0;
  const level = pct >= 100 ? "breach" : pct >= warnPct ? "warn" : "ok";
  return { elapsedMs, pct, level };
}

