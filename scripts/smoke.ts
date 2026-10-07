/**
 * Smoke test: panggil SETIAP fungsi query ke database sungguhan.
 *
 * Kenapa ini ada. Typecheck lulus penuh sementara seluruh dashboard tidak bisa
 * dibuka, karena objek Date yang diinterpolasi ke template `sql` baru meledak
 * saat dieksekusi - tidak terlihat oleh compiler sama sekali. Sekali kejadian,
 * cukup. Jalankan ini tiap kali menyentuh berkas query.
 *
 *   npm run smoke
 *
 * Skrip ini hanya MEMBACA, kecuali dua fungsi pemeliharaan di bagian akhir yang
 * memang tidak berbahaya di database kosong (autoReleaseStale, flushDue).
 */
import "dotenv/config";
import { getSql, ts } from "../src/db";
import { sql } from "drizzle-orm";
import { db } from "../src/db";

import {
  boardCounts,
  gatewayHealth,
  loadColumn,
  loadTicket,
  personalStats,
  ticketAnchor,
} from "../src/lib/queries";
import {
  activeAgents,
  bucketItems,
  dataHealth,
  notForUsByAgent,
  notForUsList,
  perAgent,
  queueSummary,
  sinceOf,
} from "../src/lib/leader";
import {
  hitungLebihBaru,
  loadGroupWindow,
  loadThread,
  resolveMissingParent,
  searchMessages,
} from "../src/lib/thread";
import { autoReleaseStale, otherOpenTicketsInGroup, slaState } from "../src/lib/tickets";
import { getAllSettings, getSetting, writeSetting } from "../src/lib/settings";
import { claimDue, flushDue, retry } from "../src/lib/outbox";

import { ingestEvents } from "../src/lib/ingest";
import { namaOrang, petaNama, selfIdentity } from "../src/lib/identity";
import { jamRingkas, smartStamp } from "../src/lib/time";
import { kembaliAman } from "../src/lib/kembali";
import {
  LABEL_KAMI,
  namaDitandai,
  potongMention,
  rapikanMention,
  teksMention,
  type DaftarTag,
  type Peserta,
} from "../src/lib/mention";
import type { NormalizedEvent, NormalizedMessage } from "../src/lib/gateway/types";

let lulus = 0;
let gagal = 0;
let dilewati = 0;
let adaTiket = false;

async function uji(nama: string, fn: () => Promise<unknown>) {
  try {
    const hasil = await fn();
    const ringkas = Array.isArray(hasil)
      ? `${hasil.length} baris`
      : hasil instanceof Map
        ? `${hasil.size} grup`
        : typeof hasil === "object" && hasil !== null
          ? JSON.stringify(hasil).slice(0, 72)
          : String(hasil);
    console.log(`  OK    ${nama.padEnd(34)} ${ringkas}`);
    lulus++;
  } catch (e) {
    const pesan = (e as Error).message.split("\n").slice(0, 2).join(" | ");
    console.log(`  GAGAL ${nama.padEnd(34)} ${pesan.slice(0, 140)}`);
    const sebab = (e as Error & { cause?: Error }).cause;
    if (sebab) console.log(`        sebab: ${sebab.message.slice(0, 140)}`);
    gagal++;
  }
}

/** Uji yang hanya masuk akal kalau ada tiket di database. */
async function ujiTiket(nama: string, fn: () => Promise<unknown>) {
  if (!adaTiket) {
    console.log(`  -     ${nama.padEnd(34)} dilewati (belum ada tiket)`);
    dilewati++;
    return;
  }
  await uji(nama, fn);
}

/* ------------------- 6.9 penggabungan pesan susulan ------------------- */

/**
 * Satu-satunya uji di berkas ini yang MENULIS. Alasannya: aturan penggabungan
 * tidak bisa dibuktikan dengan membaca - yang perlu dijawab adalah "pesan kedua
 * dari orang yang sama menghasilkan tiket baru atau tidak", dan itu hanya
 * kelihatan setelah keduanya benar-benar lewat ingestion.
 *
 * Semua yang dibuat memakai grup bertanda uji dan dihapus lagi di akhir, apa
 * pun hasilnya. Kalau proses mati di tengah, sisanya gampang dikenali:
 * jid-nya diawali "smoke-".
 */
const UJI_GRUP = "smoke-6-9@g.us";

function pesanUji(over: Partial<NormalizedMessage>): NormalizedEvent {
  const self = selfIdentity();
  return {
    kind: "message",
    warnings: [],
    message: {
      stanzaId: "SMOKE-" + Math.random().toString(36).slice(2, 12).toUpperCase(),
      groupJid: UJI_GRUP,
      sender: { pn: "628000000001", lid: null },
      senderPushName: "Klien Uji",
      fromMe: false,
      msgType: "text",
      body: `halo @${self.lid ?? self.pn} tolong dicek`,
      replyToStanzaId: null,
      replyToSender: { pn: null, lid: null },
      quotedSnippet: null,
      mentionedJids: [],
      mediaMeta: null,
      timestamp: new Date(),
      isEdited: false,
      ...over,
    },
  };
}

async function jumlahTiketUji(): Promise<number> {
  const r = (await db.execute(
    sql`SELECT count(*)::int AS n FROM tickets WHERE group_jid = ${UJI_GRUP}`,
  )) as unknown as { n: number }[];
  return Number(r[0]?.n ?? 0);
}

async function bersihkanUji() {
  await db.execute(sql`
    DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE group_jid = ${UJI_GRUP})
  `);
  await db.execute(sql`UPDATE messages SET ticket_id = NULL WHERE group_jid = ${UJI_GRUP}`);
  await db.execute(sql`DELETE FROM tickets WHERE group_jid = ${UJI_GRUP}`);
  await db.execute(sql`DELETE FROM triage_bucket WHERE group_jid = ${UJI_GRUP}`);
  await db.execute(sql`DELETE FROM messages WHERE group_jid = ${UJI_GRUP}`);
  await db.execute(sql`DELETE FROM groups WHERE jid = ${UJI_GRUP}`);
}

async function ujiGabung() {
  console.log("\nGABUNG PESAN SUSULAN (6.9)");

  const self = selfIdentity();
  if (!self.pn && !self.lid) {
    console.log("  -     gabung susulan                   dilewati (WA_SELF_PN/LID belum diisi)");
    dilewati++;
    return;
  }

  await bersihkanUji();
  await db.execute(sql`
    INSERT INTO groups (jid, name, is_monitored, monitor_decided_at)
    VALUES (${UJI_GRUP}, 'Grup uji smoke', true, now())
  `);

  try {
    const jalan = async (nama: string, ev: NormalizedEvent, harapTambah: number) => {
      const sebelum = await jumlahTiketUji();
      const ringkas = await ingestEvents([ev]);
      const sesudah = await jumlahTiketUji();
      const tambah = sesudah - sebelum;
      if (tambah === harapTambah) {
        console.log(`  OK    ${nama.padEnd(34)} tiket ${sebelum} -> ${sesudah}, gabung ${ringkas.merged}`);
        lulus++;
      } else {
        console.log(`  GAGAL ${nama.padEnd(34)} tiket bertambah ${tambah}, seharusnya ${harapTambah}`);
        gagal++;
      }
      return ev.kind === "message" ? ev.message.stanzaId : "";
    };

    await jalan("pesan pertama -> tiket baru", pesanUji({}), 1);
    await jalan("susulan orang sama -> menempel", pesanUji({}), 0);
    await jalan(
      "orang lain -> tiket sendiri",
      pesanUji({ sender: { pn: "628000000002", lid: null }, senderPushName: "Klien Lain" }),
      1,
    );

    /* Identitas yang TIDAK BISA DIBANDINGKAN (satu sisi PN, sisi lain LID) wajib
       jadi tiket sendiri. Kalau uji ini pernah berubah jadi 0, artinya ada yang
       melonggarkan perbandingan identitas jadi tebakan - section 3. */
    await jalan(
      "PN vs LID -> jangan ditebak",
      pesanUji({ sender: { pn: null, lid: "99999999999999" }, senderPushName: "LID saja" }),
      1,
    );

    // Begitu tiket sudah dibalas, susulan TANPA REPLY harus kembali jadi tiket
    // sendiri - kalau tidak, jam SLA pertanyaan lanjutan tidak pernah jalan.
    await db.execute(sql`
      UPDATE tickets SET first_response_at = now() WHERE group_jid = ${UJI_GRUP}
    `);
    await jalan("sudah dibalas -> tiket sendiri", pesanUji({}), 1);

    const anggota = (await db.execute(sql`
      SELECT count(*)::int AS n FROM messages WHERE group_jid = ${UJI_GRUP} AND ticket_id IS NOT NULL
    `)) as unknown as { n: number }[];
    const n = Number(anggota[0]?.n ?? 0);
    if (n === 5) {
      console.log(`  OK    ${"semua pesan punya ticket_id".padEnd(34)} ${n}/5`);
      lulus++;
    } else {
      console.log(`  GAGAL ${"semua pesan punya ticket_id".padEnd(34)} ${n}/5`);
      gagal++;
    }

    /* ---- jalur reply: kasus "on check" ---- */
    /*
     * Bentuknya persis kejadian nyata: kita kirim penahan, klien membalasnya
     * "oke ditunggu". Tiket sudah punya first_response_at (on check memang
     * mengisinya), jadi jalur berjendela sengaja TIDAK boleh menolongnya -
     * yang harus bekerja di sini jalur reply.
     */
    const tiketOnCheck = (await db.execute(sql`
      SELECT id, stanza_id FROM tickets WHERE group_jid = ${UJI_GRUP}
      ORDER BY id DESC LIMIT 1
    `)) as unknown as { id: number; stanza_id: string }[];

    const penahan = "SMOKE-ONCHECK-OUT";
    await db.execute(sql`
      INSERT INTO messages (stanza_id, group_jid, direction, msg_type, body, ticket_id, created_at)
      VALUES (${penahan}, ${UJI_GRUP}, 'out', 'text', 'Baik, kami cek dulu ya.',
              ${tiketOnCheck[0].id}, now())
    `);

    /* replyToSender WAJIB diisi identitas kita. Tanpa itu decideTicket()
       menyimpulkan "reply tapi identitas pemilik pesan tidak bisa dibandingkan"
       lalu melempar pesannya ke keranjang tinjau - tidak ada tiket, tidak ada
       gabung, dan ujinya lulus karena alasan yang salah. */
    const balasKita = (o: Partial<NormalizedMessage>) =>
      pesanUji({ replyToStanzaId: penahan, replyToSender: selfIdentity(), ...o });

    await jalan("balas pesan on check -> menempel", balasKita({ body: "oke ditunggu" }), 0);

    /* Orang LAIN membalas pesan penahan yang sama harus tetap jadi tiketnya
       sendiri. Kalau uji ini pernah berubah jadi 0, pertanyaan dua klien
       berbeda akan menumpuk di satu tiket dan salah satunya pasti terlupa. */
    await jalan(
      "orang lain balas pesan sama -> sendiri",
      balasKita({
        body: "kalau punya saya gimana",
        sender: { pn: "628000000003", lid: null },
        senderPushName: "Klien Ketiga",
      }),
      1,
    );

    /* Tiket yang sudah DITUTUP tidak boleh dibuka lagi diam-diam. Ini batas
       yang memisahkan "lanjutan perkara" dari "perkara baru". */
    /* Tiket yang SEDANG DIPEGANG agen. Ini bentuk paling sering di lapangan:
       agen klaim, kirim on check, klien menjawab. Yang diperiksa bukan cuma
       "tidak lahir tiket baru", tapi juga tiketnya TIDAK berubah status dan
       TIDAK lepas dari pemegangnya - kalau salah satu bergeser, pekerjaan
       pindah tangan diam-diam. */
    /* Peran 'agent' bisa saja belum ada di instance bersih (leader/sla boleh
       menangani sendiri, section 4.2 tidak mewajibkan peran 'agent' minimal
       satu). Yang penting ADA agen aktif untuk mengklaim - perannya bebas. */
    const agen = (await db.execute(
      sql`SELECT id FROM agents WHERE is_active LIMIT 1`,
    )) as unknown as { id: number }[];

    if (!agen[0]) {
      console.log("  -     tiket on_progress -> tetap menempel dilewati (tidak ada agen aktif)");
      dilewati++;
    } else {
      await db.execute(sql`
        UPDATE tickets SET status = 'on_progress', claimed_by = ${agen[0].id}, claimed_at = now()
        WHERE id = ${tiketOnCheck[0].id}
      `);
      await jalan("tiket on_progress -> tetap menempel", balasKita({ body: "gimana bang" }), 0);
    }

    const sesudah = (await db.execute(sql`
      SELECT status, claimed_by FROM tickets WHERE id = ${tiketOnCheck[0].id}
    `)) as unknown as { status: string; claimed_by: number | null }[];

    if (sesudah[0].status === "on_progress" && sesudah[0].claimed_by === agen[0].id) {
      console.log(`  OK    ${"on_progress tetap dipegang".padEnd(34)} status & pemegang utuh`);
      lulus++;
    } else {
      console.log(
        `  GAGAL ${"on_progress tetap dipegang".padEnd(34)} jadi ${sesudah[0].status}, dipegang ${sesudah[0].claimed_by}`,
      );
      gagal++;
    }

    await db.execute(sql`
      UPDATE tickets SET status = 'closed', closed_at = now() WHERE id = ${tiketOnCheck[0].id}
    `);
    await jalan(
      "tiket sudah ditutup -> tiket baru",
      balasKita({ body: "eh masih error bang" }),
      1,
    );

    /* Hitungan susulan di baris papan. Diuji dengan angka, bukan sekadar
       "query-nya jalan" - subquery yang salah join tetap mengembalikan 0
       tanpa error, dan 0 terlihat persis seperti "memang tidak ada susulan". */
    const papan = (await loadColumn("open")).filter((b) => b.groupJid === UJI_GRUP);
    const berSusulan = papan.filter((b) => b.susulan > 0);
    if (berSusulan.length === 1 && berSusulan[0].susulan === 1) {
      console.log(`  OK    ${"loadColumn susulan".padEnd(34)} 1 tiket dengan 1 susulan`);
      lulus++;
    } else {
      console.log(
        `  GAGAL ${"loadColumn susulan".padEnd(34)} ${JSON.stringify(papan.map((b) => b.susulan))}`,
      );
      gagal++;
    }

    /* Penanda "masih ada yang lebih baru" di dasar halaman chat grup.
       Diuji dengan dua angka yang berbeda, karena fungsi yang selalu
       mengembalikan 0 akan lulus kalau cuma diuji di ujung percakapan - dan 0
       artinya penandanya tidak pernah muncul sama sekali. */
    const semua = await loadGroupWindow(UJI_GRUP, new Date());
    const dariAwal = await hitungLebihBaru(UJI_GRUP, semua[0].createdAt);
    const dariAkhir = await hitungLebihBaru(UJI_GRUP, semua.at(-1)!.createdAt);
    if (dariAwal === semua.length - 1 && dariAkhir === 0) {
      console.log(`  OK    ${"hitungLebihBaru".padEnd(34)} awal ${dariAwal}, akhir ${dariAkhir}`);
      lulus++;
    } else {
      console.log(
        `  GAGAL ${"hitungLebihBaru".padEnd(34)} awal ${dariAwal} (harusnya ${semua.length - 1}), akhir ${dariAkhir} (harusnya 0)`,
      );
      gagal++;
    }

    const tiketPertama = berSusulan[0];

    /* Jam pesan terakhir di baris papan. Diuji dengan MEMBANDINGKAN ke pesan
       terakhir yang sungguh ada di tiket itu - bukan sekadar "bukan null".
       Query yang keliru mengambil pesan PEMICU juga menghasilkan tanggal yang
       masuk akal, dan di layar tidak ada yang bisa membedakannya. */
    const acuan = (await db.execute(sql`
      SELECT max(created_at) AS at FROM messages WHERE ticket_id = ${tiketPertama?.id ?? 0}
    `)) as unknown as { at: string }[];
    const seharusnya = acuan[0]?.at ? new Date(acuan[0].at).getTime() : null;
    const dipapan = tiketPertama?.lastMessageAt?.getTime() ?? null;
    if (seharusnya !== null && dipapan === seharusnya) {
      console.log(`  OK    ${"lastMessageAt di baris papan".padEnd(34)} cocok pesan terakhir`);
      lulus++;
    } else {
      console.log(
        `  GAGAL ${"lastMessageAt di baris papan".padEnd(34)} papan ${dipapan}, seharusnya ${seharusnya}`,
      );
      gagal++;
    }

    if (tiketPertama) {
      const a = await ticketAnchor(tiketPertama.id);
      const utas = await loadThread(a.stanzaId, a.groupJid, tiketPertama.id);
      if (utas.length === 2) {
        console.log(`  OK    ${"loadThread memuat susulan".padEnd(34)} ${utas.length} pesan`);
        lulus++;
      } else {
        console.log(`  GAGAL ${"loadThread memuat susulan".padEnd(34)} ${utas.length} pesan, harusnya 2`);
        gagal++;
      }
    }
  } finally {
    await bersihkanUji();
  }
}


/* --------------------- 12 menandai orang (mention) --------------------- */

/**
 * Murni, tanpa database - tapi justru bagian inilah yang paling gampang salah
 * diam-diam. Kalau bentuk teksnya meleset satu karakter, WhatsApp tidak
 * mengeluh: pesan tetap terkirim, tag-nya saja yang tidak jadi. Persis itu yang
 * terjadi pada percobaan pertama pemilik, "@+6281200000099".
 */
function ujiMention() {
  console.log("");
  console.log("12 MENANDAI ORANG");

  const budi: Peserta = { pn: "6281200000099", lid: "200000000000099", nama: "BudiSantoso" };
  const tanpaLid: Peserta = { pn: "628111222333", lid: null, nama: "Vendor" };
  const orang = [budi, tanpaLid];
  const kami = { pn: "6281234567890", lid: "123456789012345" };

  const cek = (nama: string, fn: () => void) => {
    try {
      fn();
      console.log(`  OK    ${nama.padEnd(34)}`);
      lulus++;
    } catch (e) {
      console.log(`  GAGAL ${nama.padEnd(34)} ${(e as Error).message.slice(0, 140)}`);
      gagal++;
    }
  };

  const sama = (dapat: unknown, mau: unknown, ket: string) => {
    const a = JSON.stringify(dapat);
    const b = JSON.stringify(mau);
    if (a !== b) throw new Error(`${ket}: dapat ${a}, mau ${b}`);
  };

  cek("plus dibuang, LID dipakai", () => {
    const r = rapikanMention("mohon dibantu pak @+6281200000099", orang);
    sama(r.teks, "mohon dibantu pak @200000000000099", "teks");
    sama(r.mentions, [{ pn: "6281200000099", lid: "200000000000099" }], "mentions");
  });

  cek("nomor lokal 08 ikut dikenali", () => {
    const r = rapikanMention("halo @081200000099", orang);
    sama(r.teks, "halo @200000000000099", "teks");
  });

  cek("LID apa adanya tetap sah", () => {
    const r = rapikanMention("halo @200000000000099 ya", orang);
    sama(r.teks, "halo @200000000000099 ya", "teks");
    sama(r.mentions.length, 1, "jumlah");
  });

  cek("tanpa LID jatuh ke PN", () => {
    const r = rapikanMention("cc @628111222333", orang);
    sama(r.teks, "cc @628111222333", "teks");
    sama(r.mentions, [{ pn: "628111222333", lid: null }], "mentions");
  });

  cek("orang sama dua kali tidak dobel", () => {
    const r = rapikanMention("@+6281200000099 dan @081200000099", orang);
    sama(r.mentions.length, 1, "jumlah mention");
  });

  cek("bukan peserta dibiarkan utuh", () => {
    const r = rapikanMention("invoice @99887766 sudah dibayar", orang);
    sama(r.teks, "invoice @99887766 sudah dibayar", "teks");
    sama(r.mentions, [], "mentions");
  });

  cek("email tidak tersentuh", () => {
    const r = rapikanMention("kirim ke budi@gmail.com", orang);
    sama(r.teks, "kirim ke budi@gmail.com", "teks");
    sama(r.mentions, [], "mentions");
  });

  cek("tampilan: LID jadi nama", () => {
    sama(teksMention("bang @200000000000099 tolong", orang, kami), "bang @BudiSantoso tolong", "teks");
  });

  cek("tampilan: nomor kita jadi label", () => {
    sama(teksMention("siang bang @123456789012345", orang, kami), `siang bang @${LABEL_KAMI}`, "teks");
  });

  cek("tampilan: tak dikenal dibiarkan", () => {
    sama(teksMention("cek @99887766", orang, kami), "cek @99887766", "teks");
  });

  /* Diminta pemilik: kalau nomornya sudah tersimpan di kontak, yang tampil
     harus nama kontaknya - bukan nama pasang-sendiri klien. */
  const buku = petaNama([
    { pn: "6281200000099", lid: "200000000000099", name: "Pak Budi - PT Anu" },
    { pn: "628111222333", lid: null, name: "Vendor Sameday" },
  ]);

  cek("kontak menang atas pushName", () => {
    sama(namaOrang(buku, { pn: "6281200000099", lid: null }, "budi ganteng"), "Pak Budi - PT Anu", "nama");
  });

  cek("kontak ketemu lewat LID juga", () => {
    sama(namaOrang(buku, { pn: null, lid: "200000000000099" }, null), "Pak Budi - PT Anu", "nama");
  });

  cek("belum tersimpan -> pushName", () => {
    sama(namaOrang(buku, { pn: "628999888777", lid: null }, "Budi"), "Budi", "nama");
  });

  cek("tak tersimpan, tanpa pushName -> nomor", () => {
    sama(namaOrang(buku, { pn: "628999888777", lid: null }, null), "+628999888777", "nama");
  });

  cek("tanpa buku kontak -> perilaku lama", () => {
    sama(namaOrang(undefined, { pn: "6281200000099", lid: null }, "budi ganteng"), "budi ganteng", "nama");
  });

  /* Diminta pemilik: "tinggal tag 1, dan mereka yg ada di grup ditag, yg ga
     ada tidak ditag." Bagian kedua itu yang gampang lolos tanpa uji. */
  const luar = { pn: "628777666555", lid: "999888777666555", nama: "Orang Luar" };
  const daftar: DaftarTag[] = [
    {
      slug: "sameday",
      label: "Tim Sameday",
      anggota: [
        { pn: budi.pn, lid: budi.lid },
        { pn: luar.pn, lid: luar.lid }, // BUKAN peserta grup
        { pn: tanpaLid.pn, lid: null },
      ],
    },
    { slug: "kosong", label: "Daftar Kosong", anggota: [{ pn: luar.pn, lid: luar.lid }] },
  ];

  cek("daftar mekar jadi anggotanya", () => {
    const r = rapikanMention("mohon dibantu @sameday", orang, daftar);
    sama(r.teks, "mohon dibantu @200000000000099 @628111222333", "teks");
    sama(r.mentions.length, 2, "jumlah mention");
    sama(r.daftarKosong, [], "daftar kosong");
  });

  cek("yang tidak ada di grup TIDAK ditag", () => {
    const r = rapikanMention("@sameday", orang, daftar);
    if (r.teks.includes(luar.lid) || r.teks.includes(luar.pn)) throw new Error(`orang luar ikut: ${r.teks}`);
    if (r.mentions.some((m) => m.pn === luar.pn || m.lid === luar.lid)) throw new Error("orang luar masuk mentions");
  });

  cek("daftar tanpa anggota di grup dilaporkan", () => {
    const r = rapikanMention("tolong @kosong", orang, daftar);
    sama(r.daftarKosong, ["Daftar Kosong"], "daftar kosong");
    sama(r.teks, "tolong @kosong", "teks dibiarkan utuh");
    sama(r.mentions, [], "mentions");
  });

  cek("nama daftar tak dikenal dibiarkan", () => {
    const r = rapikanMention("oke @siapa ya", orang, daftar);
    sama(r.teks, "oke @siapa ya", "teks");
  });

  cek("email tidak dikira nama daftar", () => {
    const r = rapikanMention("kirim ke budi@sameday.com", orang, daftar);
    sama(r.teks, "kirim ke budi@sameday.com", "teks");
  });

  cek("daftar campur orang, tanpa duplikat", () => {
    const r = rapikanMention("@sameday dan @+6281200000099", orang, daftar);
    sama(r.mentions.length, 2, "jumlah mention");
  });

  cek("pratinjau Menandai memekarkan daftar", () => {
    sama(namaDitandai("cc @sameday", orang, daftar), ["BudiSantoso", "Vendor"], "nama");
  });

  cek("tampilan: potongan berurutan", () => {
    const p = potongMention("a @200000000000099 b", orang, kami);
    sama(p, [
      { t: "teks", v: "a " },
      { t: "tag", v: "@BudiSantoso" },
      { t: "teks", v: " b" },
    ], "potongan");
  });
}

/* ----------------------- chat pribadi (japri) ----------------------- */

const UJI_DM = "628999000111@s.whatsapp.net";

/**
 * Yang diuji di sini adalah hal yang TIDAK bisa dibuktikan dengan membaca:
 * apakah pesan japri berhenti di gerbang saat setelannya mati, dan apakah ia
 * benar-benar sampai jadi tiket saat dinyalakan. Keduanya menulis, jadi
 * dibersihkan lagi di akhir apa pun hasilnya.
 */
async function ujiJapri() {
  console.log("");
  console.log("CHAT PRIBADI");

  const semula = await getSetting("ingest.dm_enabled");
  const bersih = async () => {
    await db.execute(sql`DELETE FROM ticket_events WHERE ticket_id IN
      (SELECT id FROM tickets WHERE group_jid = ${UJI_DM})`);
    await db.execute(sql`UPDATE messages SET ticket_id = NULL WHERE group_jid = ${UJI_DM}`);
    await db.execute(sql`DELETE FROM tickets  WHERE group_jid = ${UJI_DM}`);
    await db.execute(sql`DELETE FROM messages WHERE group_jid = ${UJI_DM}`);
    await db.execute(sql`DELETE FROM groups   WHERE jid = ${UJI_DM}`);
  };

  const pesanJapri = (over: Partial<NormalizedMessage>): NormalizedEvent => ({
    kind: "message",
    warnings: [],
    message: {
      stanzaId: `dm-${Math.random().toString(36).slice(2)}`,
      groupJid: UJI_DM,
      sender: { pn: "628999000111", lid: null },
      senderPushName: "Klien Japri",
      fromMe: false,
      msgType: "text",
      body: "halo bang",
      replyToStanzaId: null,
      replyToSender: { pn: null, lid: null },
      quotedSnippet: null,
      mentionedJids: [],
      mediaMeta: null,
      timestamp: new Date(),
      isEdited: false,
      ...over,
    },
  });

  const hitung = async () => {
    const r = (await db.execute(sql`
      SELECT (SELECT count(*) FROM groups   WHERE jid = ${UJI_DM})       AS grup,
             (SELECT count(*) FROM messages WHERE group_jid = ${UJI_DM}) AS pesan,
             (SELECT count(*) FROM tickets  WHERE group_jid = ${UJI_DM}) AS tiket
    `)) as unknown as { grup: string; pesan: string; tiket: string }[];
    return { grup: Number(r[0].grup), pesan: Number(r[0].pesan), tiket: Number(r[0].tiket) };
  };

  try {
    await bersih();

    await writeSetting("ingest.dm_enabled", false, null);
    await ingestEvents([pesanJapri({})]);
    await uji("mati: tidak disimpan sama sekali", async () => {
      const n = await hitung();
      if (n.grup || n.pesan || n.tiket) throw new Error(`bocor: ${JSON.stringify(n)}`);
      return "0 baris di groups/messages/tickets";
    });

    await writeSetting("ingest.dm_enabled", true, null);
    await ingestEvents([pesanJapri({})]);
    await uji("nyala: jadi tiket, ditandai japri", async () => {
      const n = await hitung();
      if (n.tiket !== 1) throw new Error(`tiket ${n.tiket}, mau 1`);
      const r = (await db.execute(sql`
        SELECT t.trigger_type, t.likely_not_ours, g.is_dm, g.name
        FROM tickets t JOIN groups g ON g.jid = t.group_jid
        WHERE t.group_jid = ${UJI_DM}
      `)) as unknown as { trigger_type: string; likely_not_ours: boolean; is_dm: boolean; name: string }[];
      if (r[0].trigger_type !== "dm") throw new Error(`trigger ${r[0].trigger_type}`);
      if (!r[0].is_dm) throw new Error("is_dm false");
      if (r[0].likely_not_ours) throw new Error("japri tidak pernah likely_not_ours");
      if (r[0].name !== "Klien Japri") throw new Error(`nama "${r[0].name}"`);
      return `trigger=dm, is_dm=true, nama="${r[0].name}"`;
    });

    await ingestEvents([pesanJapri({ body: "masih nunggu bang" })]);
    await uji("susulan japri menempel, bukan tiket kedua", async () => {
      const n = await hitung();
      if (n.tiket !== 1) throw new Error(`tiket jadi ${n.tiket}`);
      return `${n.pesan} pesan, 1 tiket`;
    });

    await uji("papan memuat japri", async () => {
      const baris = (await loadColumn("open")).filter((b) => b.groupJid === UJI_DM);
      if (baris.length !== 1) throw new Error(`${baris.length} baris`);
      if (!baris[0].isDm) throw new Error("isDm false di BoardTicket");
      return `isDm=${baris[0].isDm}, judul="${baris[0].groupName}"`;
    });
  } finally {
    await bersih();
    await writeSetting("ingest.dm_enabled", semula, null);
  }
}

/* ------------------- 9.4 satu pesan tidak boleh terkirim dua kali ------------------- */

/**
 * Ini uji yang lahir dari pertanyaan pemilik: "bisa ga pesan yang sudah kirim
 * tiba-tiba dikirim lagi?" Jawabannya dulu: BISA.
 *
 * `UPDATE ... WHERE id IN (SELECT ... WHERE status='holding')` TIDAK cukup.
 * Di READ COMMITTED, transaksi kedua yang tertahan kunci hanya memeriksa ulang
 * qual UPDATE-nya - dan predikat status bersembunyi di dalam subquery yang
 * hasilnya sudah terlanjur dihitung. Diadu ke Postgres sungguhan, dua proses
 * sama-sama mendapat baris yang sama.
 *
 * Tidak menembak WhatsApp sama sekali: yang diadu cuma langkah KLAIM-nya.
 */
/**
 * Peristiwa masuk yang MELEDAK saat diproses tidak boleh berhenti di console.
 * Gateway sudah menjawab 200 dan tidak akan pernah mengulanginya, jadi kalau
 * tidak ada yang memberi tahu, pesan klien hilang tanpa jejak yang dilihat
 * manusia. Payloadnya masih ada di var/raw dan bisa diputar ulang - yang
 * kurang cuma satu: ada yang TAHU.
 */
async function ujiGagalIngest() {
  console.log("");
  console.log("INGESTION GAGAL HARUS TERLIHAT");

  const bersih = () => db.execute(sql`DELETE FROM notifications WHERE kind = 'ingest_failed'`);
  try {
    await bersih();
    /* Timestamp yang tidak valid: bentuk kerusakan yang paling mungkin datang
       dari parser, dan ia baru meledak saat menyentuh Postgres. */
    const rusak: NormalizedEvent = {
      kind: "message",
      warnings: [],
      message: {
        ...(pesanUji({}) as { message: NormalizedMessage }).message,
        timestamp: new Date(Number.NaN),
      },
    };

    await uji("peristiwa rusak dihitung, bukan ditelan", async () => {
      const r = await ingestEvents([rusak]);
      if (r.failed !== 1) throw new Error(`failed=${r.failed}, mau 1`);
      if (r.stored !== 0) throw new Error(`stored=${r.stored}, mau 0`);
      return `failed=${r.failed}, warning: ${r.warnings[0]?.slice(0, 40)}`;
    });

    await uji("leader diberi tahu", async () => {
      const n = (await db.execute(sql`
        SELECT count(*)::int AS n FROM notifications WHERE kind='ingest_failed' AND for_role='leader'
      `)) as unknown as { n: number }[];
      if (n[0].n !== 1) throw new Error(`${n[0].n} notifikasi, mau 1`);
      return "1 notifikasi untuk leader";
    });

    await uji("tidak membanjiri: gagal kedua tidak menambah", async () => {
      await ingestEvents([rusak]);
      await ingestEvents([rusak]);
      const n = (await db.execute(sql`
        SELECT count(*)::int AS n FROM notifications WHERE kind='ingest_failed'
      `)) as unknown as { n: number }[];
      if (n[0].n !== 1) throw new Error(`jadi ${n[0].n} notifikasi - pembatas lima menit tidak jalan`);
      return "tetap 1 walau gagal 3x";
    });
  } finally {
    await bersih();
  }
}

/**
 * Satu id agen aktif, dipakai berulang di uji-uji berikut. Dulu di sini
 * tertulis literal `1` - itu kebetulan cocok selama agen pertama tidak pernah
 * dihapus. Sekali database di-reset total (section 4.2 memang melarangnya,
 * tapi instance uji boleh), id 1 tidak ada lagi dan tiap INSERT yang
 * menuliskannya gagal dengan foreign key violation. Diambil dari database
 * yang sesungguhnya supaya uji ini tidak pernah menebak id siapa pun.
 */
let _agenUjiId: number | null | undefined;
async function agenUji(): Promise<number> {
  if (_agenUjiId === undefined) {
    const r = (await db.execute(sql`SELECT id FROM agents WHERE is_active LIMIT 1`)) as unknown as {
      id: number;
    }[];
    _agenUjiId = r[0]?.id ?? null;
  }
  if (_agenUjiId === null) throw new Error("tidak ada satu pun agen aktif di database - buat dulu lewat Setelan");
  return _agenUjiId;
}

async function ujiBalapanKirim() {
  console.log("");
  console.log("9.4 KIRIM GANDA");

  const ID = "00000000-0000-4000-8000-0000000c1a1b";
  const bersih = () => db.execute(sql`DELETE FROM outbox WHERE id = ${ID}::uuid`);

  try {
    await bersih();
    await db.execute(sql`
      INSERT INTO outbox (id, idempotency_key, group_jid, agent_id, body, status, release_at)
      VALUES (${ID}::uuid, ${"smoke-race-" + ID}, ${UJI_GRUP}, ${await agenUji()}, 'uji balapan', 'holding',
              now() - interval '1 minute')`);

    /* Dua transaksi yang benar-benar tumpang tindih. Yang pertama menahan
       kuncinya sebentar supaya yang kedua PASTI menabraknya - kalau dibiarkan
       autocommit, jendelanya terlalu sempit dan uji ini akan lulus karena
       beruntung, bukan karena benar. */
    const dapat: string[] = [];
    const a = db.transaction(async (tx) => {
      const r = await claimDue(20, tx);
      r.forEach((x) => dapat.push("A:" + x.id));
      await new Promise((res) => setTimeout(res, 400));
    });
    await new Promise((res) => setTimeout(res, 120));
    const b = db.transaction(async (tx) => {
      const r = await claimDue(20, tx);
      r.forEach((x) => dapat.push("B:" + x.id));
    });
    await Promise.all([a, b]);

    await uji("dua cron berebut -> hanya satu yang dapat", async () => {
      const kena = dapat.filter((d) => d.endsWith(ID));
      if (kena.length !== 1) throw new Error(`diklaim ${kena.length} proses: ${kena.join(", ")}`);
      return kena[0];
    });
  } finally {
    await bersih();
  }

  /* Kegagalan PALSU: koneksi putus sesudah WhatsApp menerima pesannya. Percobaan
     ulang tanpa penjaga = pesan kembar di grup klien, dan itulah bentuk keluhan
     "sudah dikirim, besoknya dikirim lagi". */
  const ID2 = "00000000-0000-4000-8000-0000000c1a2c";
  const GEMA = "smoke-gema@g.us";
  const bersih2 = async () => {
    await db.execute(sql`DELETE FROM outbox   WHERE id = ${ID2}::uuid`);
    await db.execute(sql`DELETE FROM messages WHERE group_jid = ${GEMA}`);
    await db.execute(sql`DELETE FROM groups   WHERE jid = ${GEMA}`);
  };

  try {
    await bersih2();
    await db.execute(sql`
      INSERT INTO groups (jid, name, is_monitored) VALUES (${GEMA}, 'uji gema', true)`);
    /* Baris yang SUDAH pernah dicoba sekali dan dianggap gagal. */
    await db.execute(sql`
      INSERT INTO outbox (id, idempotency_key, group_jid, agent_id, body, status, release_at, attempts)
      VALUES (${ID2}::uuid, ${"smoke-gema-" + ID2}, ${GEMA}, ${await agenUji()}, 'halo ini uji gema', 'holding',
              now() - interval '1 minute', 1)`);
    /* ...padahal pesannya sudah sampai, dan gemanya sudah kembali lewat webhook. */
    await db.execute(sql`
      INSERT INTO messages (stanza_id, group_jid, direction, msg_type, body, created_at, ingested_at)
      VALUES ('GEMA-001', ${GEMA}, 'out', 'text', 'halo ini uji gema', now(), now())`);

    await uji("gagal palsu -> tidak dikirim ulang", async () => {
      const hasil = await flushDue();
      const r = (await db.execute(sql`
        SELECT status, sent_stanza_id, last_error FROM outbox WHERE id = ${ID2}::uuid
      `)) as unknown as { status: string; sent_stanza_id: string; last_error: string }[];
      if (r[0].status !== "sent") throw new Error(`status ${r[0].status}, mau sent`);
      if (r[0].sent_stanza_id !== "GEMA-001") throw new Error(`stanza ${r[0].sent_stanza_id}`);
      return `${hasil.sent} terkirim tanpa menembak gateway, dikaitkan ke ${r[0].sent_stanza_id}`;
    });
  } finally {
    await bersih2();
  }

  /* Tombol "Kirim ulang" adalah jalur pesan kembar yang paling nyata: pesan
     sebenarnya sudah sampai, tercatat gagal, lalu besoknya ditekan lagi.
     retry() dulu menolkan attempts, dan penjaga gema (attempts > 0) jadi tidak
     pernah aktif di jalur itu - penjaganya ada tapi tidak menjaga. */
  const ID3 = "00000000-0000-4000-8000-0000000c1a3d";
  const bersih3 = () => db.execute(sql`DELETE FROM outbox WHERE id = ${ID3}::uuid`);
  try {
    await bersih3();
    await db.execute(sql`
      INSERT INTO outbox (id, idempotency_key, group_jid, agent_id, body, status, release_at,
                          attempts, last_error)
      VALUES (${ID3}::uuid, ${"smoke-retry-" + ID3}, ${UJI_GRUP}, ${await agenUji()}, 'uji kirim ulang', 'failed',
              now(), 3, 'gateway tidak menjawab')`);

    await uji("kirim ulang tetap memeriksa gema", async () => {
      const ok = await retry(ID3, await agenUji());
      if (!ok) throw new Error("retry() menolak");
      const r = (await db.execute(sql`
        SELECT status, attempts FROM outbox WHERE id = ${ID3}::uuid
      `)) as unknown as { status: string; attempts: number }[];
      if (r[0].status !== "holding") throw new Error(`status ${r[0].status}`);
      if (r[0].attempts < 1) {
        throw new Error(`attempts jadi ${r[0].attempts} - penjaga gema tidak akan pernah aktif`);
      }
      return `status=${r[0].status}, attempts=${r[0].attempts} (penjaga gema aktif)`;
    });
  } finally {
    await bersih3();
  }
}

/* --------------- temuan audit: empat lubang yang terbukti nyata --------------- */

function ujiAudit() {
  console.log("");
  console.log("AUDIT: LUBANG YANG DITAMBAL");

  const cek = (nama: string, fn: () => void) => {
    try {
      fn();
      console.log(`  OK    ${nama.padEnd(38)}`);
      lulus++;
    } catch (e) {
      console.log(`  GAGAL ${nama.padEnd(38)} ${(e as Error).message.slice(0, 120)}`);
      gagal++;
    }
  };
  const sama = (dapat: unknown, mau: unknown, ket: string) => {
    if (JSON.stringify(dapat) !== JSON.stringify(mau)) {
      throw new Error(`${ket}: dapat ${JSON.stringify(dapat)}, mau ${JSON.stringify(mau)}`);
    }
  };

  /* Gateway mati -> daftar peserta kosong. Nama daftar TIDAK BOLEH lolos mentah
     ke grup klien; ia harus dilaporkan kosong supaya kiriman ditolak. */
  cek("peserta kosong -> daftar ditolak, bukan lolos", () => {
    const daftar = [{ slug: "inspector", label: "Inspector Area", anggota: [{ pn: "628111", lid: null }] }];
    const r = rapikanMention("mohon dibantu @inspector", [], daftar);
    sama(r.daftarKosong, ["Inspector Area"], "daftarKosong");
    sama(r.mentions, [], "mentions");
  });

  /* dateFmt tanpa tahun: "23 Agu" tahun lalu == "23 Agu" hari ini. */
  const kini = new Date("2026-08-23T12:00:00+07:00");
  cek("setahun lalu bukan 'hari ini'", () => {
    const setahunLalu = new Date("2025-08-23T12:00:00+07:00");
    const teks = smartStamp(setahunLalu, kini);
    if (teks.includes("hari ini")) throw new Error(`dapat "${teks}"`);
    if (!teks.includes("2025")) throw new Error(`tahun tidak ditampilkan: "${teks}"`);
  });
  cek("jamRingkas juga sadar tahun", () => {
    const setahunLalu = new Date("2025-08-23T12:00:00+07:00");
    const teks = jamRingkas(setahunLalu, kini);
    if (!teks.includes("2025")) throw new Error(`dapat "${teks}"`);
  });
  cek("hari ini tetap hari ini", () => {
    sama(jamRingkas(new Date("2026-08-23T09:05:00+07:00"), kini), "09.05", "jam");
  });
  /* Jalan pulang sesudah login dulu cuma diperiksa dengan startsWith("/"),
     dan "//situslain.com" juga diawali garis miring - peramban membacanya
     sebagai URL ke domain lain. Sekarang lewat kembaliAman(). */
  const bs = String.fromCharCode(92);
  const nl = String.fromCharCode(10);
  for (const [masuk, mau] of [
    ["/", "/"],
    ["/tiket/12?dari=%2F", "/tiket/12?dari=%2F"],
    ["//situslain.com", "/"],
    ["/" + bs + bs + "situslain.com", "/"],
    ["https://situslain.com", "/"],
    ["javascript:alert(1)", "/"],
    ["/x" + nl + "Set-Cookie: a=b", "/"],
  ] as [string, string][]) {
    cek(`jalan pulang: ${JSON.stringify(masuk).slice(0, 26)}`, () => {
      sama(kembaliAman(masuk, "/"), mau, "hasil");
    });
  }

  cek("kemarin tetap kemarin", () => {
    const teks = smartStamp(new Date("2026-08-22T09:05:00+07:00"), kini);
    if (!teks.startsWith("kemarin")) throw new Error(`dapat "${teks}"`);
  });
}

async function main() {
  const since = sinceOf("bulan");

  // Ambil satu tiket & satu grup nyata dari seed supaya ujinya tidak hampa.
  const contoh = (await db.execute(sql`
    SELECT t.id, t.group_jid AS grup, t.stanza_id AS stanza, t.triggered_at AS at
    FROM tickets t ORDER BY t.id LIMIT 1
  `)) as unknown as { id: number; grup: string; stanza: string; at: string }[];

  /* Database kosong adalah keadaan yang SAH - itu justru bentuknya setelah
     data contoh dibersihkan dan sebelum tiket asli pertama masuk. Uji yang
     butuh tiket dilewati dengan catatan, bukan menggagalkan seluruh smoke. */
  const t = contoh[0] ?? null;
  adaTiket = Boolean(t);
  if (!t) console.log("\n(database belum punya tiket - uji yang bergantung tiket dilewati)");

  console.log("\nPAPAN AGEN");
  await uji("boardCounts", () => boardCounts());
  await uji("loadColumn(open)", () => loadColumn("open"));
  await uji("loadColumn(progress)", () => loadColumn("progress"));
  await uji("loadColumn(done)", () => loadColumn("done"));
  await ujiTiket("loadTicket", () => loadTicket(t!.id));
  await ujiTiket("ticketAnchor", () => ticketAnchor(t!.id));
  await uji("personalStats", () => personalStats(1));
  await uji("gatewayHealth", () => gatewayHealth());

  console.log("\nCONTEXT UTAS");
  await ujiTiket("loadThread", () => loadThread(t!.stanza, t!.grup));
  await ujiTiket("loadGroupWindow", () => loadGroupWindow(t!.grup, new Date(t!.at)));
  await ujiTiket("resolveMissingParent", () => resolveMissingParent("invoice bulan lalu", t!.grup));
  await uji("searchMessages", () => searchMessages("invoice"));

  console.log("\nTIKET");
  await ujiTiket("otherOpenTicketsInGroup", () => otherOpenTicketsInGroup(t!.grup, t!.id));
  await ujiTiket("slaState", async () => slaState(new Date(t!.at), 15, 80, null));
  // tidak butuh tiket: pastikan query utas tetap sehat di database kosong
  await uji("loadThread (id tidak ada)", () => loadThread("TIDAK-ADA", "x@g.us"));

  console.log("\nLEADER");
  await uji("queueSummary", () => queueSummary());
  await uji("activeAgents", () => activeAgents());
  await uji("perAgent", () => perAgent(since));
  await uji("dataHealth", () => dataHealth(since));
  await uji("notForUsByAgent", () => notForUsByAgent(since));
  await uji("notForUsList", () => notForUsList(since));
  await uji("bucketItems(needs_review)", () => bucketItems("needs_review"));

  console.log("\nSETELAN");
  await uji("getSetting", () => getSetting("sla.first_response_min"));
  await uji("getAllSettings", () => getAllSettings());

  ujiMention();

  ujiAudit();

  await ujiGabung();

  await ujiJapri();

  await ujiGagalIngest();

  await ujiBalapanKirim();

  console.log("\nPEMELIHARAAN (cron tick)");
  await uji("autoReleaseStale", () => autoReleaseStale());
  await uji("flushDue", () => flushDue());

  console.log(`\n${lulus} lulus, ${gagal} gagal, ${dilewati} dilewati\n`);
  if (gagal) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getSql().end();
  });

void ts;
