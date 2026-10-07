/**
 * Data contoh supaya dashboard bisa dilihat dan diuji tanpa menyentuh nomor
 * WhatsApp sungguhan (SPEC section 16: "Uji dengan nomor dan grup percobaan minimal
 * seminggu sebelum menyentuh nomor kerja").
 *
 * Jalankan:  npm run db:seed
 * Aman diulang - memakai onConflictDoNothing, tidak menggandakan.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { getDb, getSql } from "./index";
import {
  agents,
  groups,
  ignoredPhrases,
  messages,
  quickReplies,
  ticketEvents,
  tickets,
} from "./schema";

const db = getDb();
const now = Date.now();
const menit = (n: number) => new Date(now - n * 60_000);

const SELF_PN = process.env.WA_SELF_PN || "628110000000";
const SELF_LID = process.env.WA_SELF_LID || "199900000000001";

async function main() {
  const sandi = await bcrypt.hash(process.env.SEED_PASSWORD || "rahasia123", 11);

  /* --------------------------------- agen --------------------------------- */
  const daftarAgen = [
    { name: "Rio Pratama", username: "rio", signatureCode: "ry", shift: "pagi", role: "leader" as const },
    { name: "Ayu Lestari", username: "ayu", signatureCode: "ay", shift: "pagi", role: "agent" as const },
    { name: "Dedi Kurnia", username: "dedi", signatureCode: "dd", shift: "sore", role: "agent" as const },
    { name: "Nina Halim", username: "nina", signatureCode: "nn", shift: "malam", role: "agent" as const },
  ];

  await db
    .insert(agents)
    .values(daftarAgen.map((a) => ({ ...a, passwordHash: sandi })))
    .onConflictDoNothing();

  const semuaAgen = await db.select().from(agents);
  const id = (u: string) => semuaAgen.find((a) => a.username === u)!.id;

  /* --------------------------------- grup --------------------------------- */
  const daftarGrup = [
    { jid: "6281100000001-1600000001@g.us", name: "PT Anugerah Jaya", clientLabel: "Retail", isMonitored: true },
    { jid: "6281100000002-1600000002@g.us", name: "CV Mitra Sentosa", clientLabel: "Distribusi", isMonitored: true },
    { jid: "6281100000003-1600000003@g.us", name: "Toko Sinar Abadi", clientLabel: "Retail", isMonitored: true },
    {
      jid: "6281100000004-1600000004@g.us",
      name: "Koperasi Bina Usaha",
      clientLabel: "Koperasi",
      isMonitored: true,
      slaFirstResponseMin: 30,
      slaResolutionMin: 240,
    },
    // Sengaja nonaktif: memperlihatkan section 4.1 default FALSE.
    { jid: "6281100000005-1600000005@g.us", name: "Grup Internal Tim", isMonitored: false },
  ];
  await db.insert(groups).values(daftarGrup).onConflictDoNothing();

  /* ---------------------------- frasa & template ---------------------------- */
  await db
    .insert(ignoredPhrases)
    .values([
      { phrase: "ok", matchMode: "exact" },
      { phrase: "oke", matchMode: "exact" },
      { phrase: "siap", matchMode: "exact" },
      { phrase: "makasih", matchMode: "prefix" },
      { phrase: "terima kasih", matchMode: "prefix" },
    ])
    .onConflictDoNothing();

  await db
    .insert(quickReplies)
    .values([
      { title: "On check", body: "Baik, kami cek dulu ya. Mohon ditunggu.", sortOrder: 1 },
      { title: "Minta nomor", body: "Boleh dibantu nomor invoice / order-nya?", sortOrder: 2 },
      { title: "Sudah diproses", body: "Sudah kami proses ya. Kalau ada kendala lagi silakan kabari.", sortOrder: 3 },
    ])
    .onConflictDoNothing();

  /* ------------------------------- percakapan ------------------------------- */
  let seq = 0;
  const sid = () => `SEED${String(++seq).padStart(4, "0")}`;

  type Masuk = {
    grup: string;
    pengirim: string;
    pn: string;
    teks: string;
    menitLalu: number;
    balasKe?: string;
    balasKePn?: string;
    tiket?: { status: "open" | "on_progress" | "closed"; oleh?: string; likelyNotOurs?: boolean };
  };

  const g = daftarGrup;
  const skrip: (Masuk & { stanza?: string })[] = [];

  const tambah = (m: Masuk): string => {
    const s = sid();
    skrip.push({ ...m, stanza: s });
    return s;
  };

  /* --- grup 1: utas bercabang (section 7.1) ---
     Budi kirim pesan (B). Sari reply B. Budi reply B lagi sambil tag kita.
     Penelusuran garis lurus dari pesan terakhir akan kehilangan pesan Sari;
     algoritma akar-lalu-turunan menampilkannya. */
  const B = tambah({
    grup: g[0].jid,
    pengirim: "Budi Santoso",
    pn: "628121111111",
    teks: "Pagi, invoice bulan lalu nomor INV-2291 kok belum masuk ya?",
    menitLalu: 34,
  });
  tambah({
    grup: g[0].jid,
    pengirim: "Sari Wulandari",
    pn: "628122222222",
    teks: "Betul pak, saya juga belum terima tembusannya",
    menitLalu: 31,
    balasKe: B,
    balasKePn: "628121111111",
  });
  tambah({
    grup: g[0].jid,
    pengirim: "Budi Santoso",
    pn: "628121111111",
    teks: `@${SELF_PN} tolong dibantu cek ya`,
    menitLalu: 26,
    balasKe: B,
    balasKePn: "628121111111",
    // 26 menit dengan target 15 menit -> sudah lewat SLA, muncul merah.
    tiket: { status: "open" },
  });

  /* --- grup 3: sedang menunggu, mendekati ambang --- */
  tambah({
    grup: g[2].jid,
    pengirim: "Rina Kartika",
    pn: "628124444444",
    teks: `@${SELF_PN} stok barang kode A-119 masih ada? klien saya nanya terus`,
    menitLalu: 13,
    tiket: { status: "open" },
  });

  /* --- grup 2: baru masuk --- */
  tambah({
    grup: g[1].jid,
    pengirim: "Hendra Wijaya",
    pn: "628125555555",
    teks: `@${SELF_PN} pengiriman ke Surabaya hari ini jadi berangkat?`,
    menitLalu: 3,
    tiket: { status: "open" },
  });

  /* --- grup 4: section 6.4 mention kita, tapi sedang membalas orang lain --- */
  const lain = tambah({
    grup: g[3].jid,
    pengirim: "Wati Suryani",
    pn: "628126666666",
    teks: "Bu, laporan koperasi bulan ini sudah dikirim?",
    menitLalu: 20,
  });
  tambah({
    grup: g[3].jid,
    pengirim: "Joko Prasetyo",
    pn: "628127777777",
    teks: `Sudah bu, kemarin lewat @${SELF_PN} juga sudah dikabari`,
    menitLalu: 18,
    balasKe: lain,
    balasKePn: "628126666666",
    tiket: { status: "open", likelyNotOurs: true },
  });

  /* --- grup 2: sedang ditangani Dedi --- */
  tambah({
    grup: g[1].jid,
    pengirim: "Hendra Wijaya",
    pn: "628125555555",
    teks: `@${SELF_PN} sekalian minta nomor resi yang kemarin ya`,
    menitLalu: 47,
    tiket: { status: "on_progress", oleh: "dedi" },
  });

  /* --- grup 3: selesai hari ini --- */
  tambah({
    grup: g[2].jid,
    pengirim: "Rina Kartika",
    pn: "628124444444",
    teks: `@${SELF_PN} tolong kirim katalog terbaru`,
    menitLalu: 190,
    tiket: { status: "closed", oleh: "ayu" },
  });
  tambah({
    grup: g[0].jid,
    pengirim: "Sari Wulandari",
    pn: "628122222222",
    teks: `@${SELF_PN} PO baru sudah saya kirim ke email ya`,
    menitLalu: 240,
    tiket: { status: "closed", oleh: "nina" },
  });

  /* ------------------------------ tulis ke DB ------------------------------ */
  for (const m of skrip) {
    await db
      .insert(messages)
      .values({
        stanzaId: m.stanza!,
        groupJid: m.grup,
        senderPn: m.pn,
        // Sengaja ada yang punya LID dan ada yang tidak - supaya panel Kesehatan
        // Data menunjukkan angka yang tidak nol, seperti kenyataannya nanti.
        senderLid: m.pn.endsWith("1") || m.pn.endsWith("5") ? `1999${m.pn.slice(-9)}` : null,
        senderPushName: m.pengirim,
        direction: "in",
        msgType: "text",
        body: m.teks,
        replyToStanzaId: m.balasKe ?? null,
        replyToSenderPn: m.balasKePn ?? null,
        replyToSenderLid: null,
        quotedSnippet: m.balasKe ? skrip.find((x) => x.stanza === m.balasKe)?.teks.slice(0, 80) : null,
        createdAt: menit(m.menitLalu),
      })
      .onConflictDoNothing();
  }

  // Balasan tim untuk tiket yang sudah selesai + satu balasan tanpa atribusi
  // (dikirim dari HP), supaya panel Kesehatan Data punya isi.
  const balasan = [
    { stanza: sid(), grup: g[2].jid, ke: skrip.find((s) => s.menitLalu === 190)!.stanza!, teks: "Baik, katalog sudah kami kirim ya. #dsp ay", agen: id("ayu"), kode: "ay", menitLalu: 178 },
    { stanza: sid(), grup: g[0].jid, ke: skrip.find((s) => s.menitLalu === 240)!.stanza!, teks: "Sudah kami terima, terima kasih. #dsp nn", agen: id("nina"), kode: "nn", menitLalu: 225 },
    { stanza: sid(), grup: g[1].jid, ke: skrip.find((s) => s.menitLalu === 47)!.stanza!, teks: "Sebentar ya pak, saya cek dulu resinya. #dsp dd", agen: null, kode: "dd", menitLalu: 40 },
  ];

  for (const b of balasan) {
    await db
      .insert(messages)
      .values({
        stanzaId: b.stanza,
        groupJid: b.grup,
        senderPn: SELF_PN,
        senderLid: SELF_LID,
        senderPushName: "Customer Service",
        direction: "out",
        msgType: "text",
        body: b.teks,
        replyToStanzaId: b.ke,
        agentId: b.agen,
        signatureCode: b.kode,
        createdAt: menit(b.menitLalu),
      })
      .onConflictDoNothing();
  }

  /* --------------------------------- tiket --------------------------------- */
  const grupById = new Map(daftarGrup.map((x) => [x.jid, x]));

  for (const m of skrip) {
    if (!m.tiket) continue;
    const grup = grupById.get(m.grup)!;
    const triggeredAt = menit(m.menitLalu);
    const olehId = m.tiket.oleh ? id(m.tiket.oleh) : null;

    const frTarget = grup.slaFirstResponseMin ?? 15;
    const resTarget = grup.slaResolutionMin ?? 120;

    const firstResponseAt =
      m.tiket.status === "closed"
        ? menit(m.menitLalu - 12)
        : m.tiket.status === "on_progress"
          ? menit(m.menitLalu - 7)
          : null;

    const inserted = await db
      .insert(tickets)
      .values({
        stanzaId: m.stanza!,
        groupJid: m.grup,
        status: m.tiket.status,
        triggerType: m.balasKe ? "reply" : "mention",
        likelyNotOurs: m.tiket.likelyNotOurs ?? false,
        claimedBy: m.tiket.status === "on_progress" ? olehId : null,
        claimedAt: m.tiket.status === "on_progress" ? menit(m.menitLalu - 5) : null,
        firstResponseAt,
        firstResponderId: firstResponseAt ? olehId : null,
        resolvedAt: m.tiket.status === "closed" ? menit(m.menitLalu - 12) : null,
        resolvedBy: m.tiket.status === "closed" ? olehId : null,
        closedAt: m.tiket.status === "closed" ? menit(m.menitLalu - 12) : null,
        closedBy: m.tiket.status === "closed" ? olehId : null,
        slaTargetFrMin: frTarget,
        slaTargetResMin: resTarget,
        triggeredAt,
      })
      .onConflictDoNothing({ target: tickets.stanzaId })
      .returning({ id: tickets.id });

    if (inserted[0]) {
      await db.insert(ticketEvents).values({
        ticketId: inserted[0].id,
        action: "created",
        toValue: m.balasKe ? "reply" : "mention",
      });
    }
  }

  const hitung = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM agents)::int   AS agen,
      (SELECT count(*) FROM groups)::int   AS grup,
      (SELECT count(*) FROM messages)::int AS pesan,
      (SELECT count(*) FROM tickets)::int  AS tiket
  `);

  console.log("Seed selesai:", (hitung as unknown as Record<string, number>[])[0]);
  console.log(`Login contoh: rio / ${process.env.SEED_PASSWORD || "rahasia123"} (leader)`);
  console.log("Agen lain: ayu, dedi, nina - kata sandi sama.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getSql().end();
  });
