/**
 * Mention: menandai orang di grup - SPEC section 12.
 *
 *   "Teks pesan harus memuat @<nomor> DAN ID orangnya dimasukkan ke
 *    mentionedJid. Kalau hanya teks -> tidak ada notifikasi. Kalau hanya
 *    array -> tidak ada highlight."
 *
 * BENTUK MANA YANG DITULIS DI TEKS - PN atau LID?
 * Ini pertanyaan yang tidak boleh dijawab dengan tebakan, jadi dijawab dengan
 * data. Dari dump Fase 0 milik akun ini (var/raw), SELURUH mention yang dibuat
 * WhatsApp sungguhan berbentuk LID:
 *
 *     "mentionedJid":[]                            178x
 *     "mentionedJid":["123456789012345@lid"]         43x
 *     "mentionedJid":["268474530144380@lid"]         5x
 *
 * dan teksnya "bang @123456789012345" - angka LID, bukan nomor telepon. Grup di
 * akun ini memang beralamat-LID (peserta dari gateway keluar sebagai
 * "<lid>@lid"). Jadi teks memakai LID kalau ada, PN kalau tidak.
 *
 * Array mentionedJid tetap diisi DUA-DUANYA (PN dan LID) sesuai section 12 - itu
 * urusan adapter gateway, bukan berkas ini.
 *
 * Berkas ini sengaja murni: tidak menyentuh database maupun gateway, supaya
 * bisa diuji di smoke test dan dipakai komponen klien sekaligus. Sumber
 * datanya ada di lib/orang.ts.
 */
import { normalizeMsisdn } from "@/lib/identity";

export type Peserta = {
  pn: string | null;
  lid: string | null;
  /** nama siap tampil - tidak pernah kosong. */
  nama: string;
};

/** Yang ditampilkan menggantikan mention ke nomor kita sendiri. */
export const LABEL_KAMI = "kami";

/**
 * Hanya "@" yang diikuti angka. Bukan "@gmail", bukan "@budi" - mention
 * WhatsApp SELALU angka di level protokol; nama cuma tampilan di layar.
 * Tanda "+" ikut ditelan supaya "@+628..." yang diketik manual tetap terbaca.
 */
const POLA = /@\+?(\d{4,25})/g;

/**
 * Satu daftar tag - lihat db/schema.ts `mentionLists`.
 *
 * `anggota` adalah SELURUH anggota daftar, bukan yang ada di grup tertentu.
 * Penyaringannya terjadi saat mekar, karena daftar yang sama dipakai di banyak
 * grup dengan isi peserta yang berbeda-beda.
 */
export type DaftarTag = {
  slug: string;
  label: string;
  anggota: { pn: string | null; lid: string | null }[];
};

/**
 * Nama daftar: "@" diikuti HURUF. Sengaja tidak boleh diawali angka supaya
 * tidak pernah bertabrakan dengan mention orang, yang selalu angka.
 * Batas kata di depan menjaga "budi@gmail.com" tetap utuh.
 */
const POLA_DAFTAR = /(^|\s)@([A-Za-z][A-Za-z0-9_-]{0,30})/g;

type Indeks = Map<string, Peserta>;

/** Satu orang bisa dicari lewat LID maupun PN-nya. */
export function indeksPeserta(orang: Peserta[]): Indeks {
  const idx: Indeks = new Map();
  for (const o of orang) {
    if (o.lid) idx.set(o.lid, o);
    if (o.pn) idx.set(o.pn, o);
  }
  return idx;
}

function cari(idx: Indeks, angka: string): Peserta | null {
  return idx.get(angka) ?? idx.get(normalizeMsisdn(angka)) ?? null;
}

/** Angka yang harus berdiri di teks supaya WhatsApp mau menyorotnya. */
export function tokenMention(o: Peserta): string | null {
  return o.lid ?? o.pn;
}

/* --------------------------- jalur kirim --------------------------- */

export type HasilRapi = {
  teks: string;
  mentions: { pn: string | null; lid: string | null }[];
  /** daftar yang dipakai tapi tidak punya satu pun anggota di grup ini. */
  daftarKosong: string[];
};

/**
 * Mekarkan "@sameday" jadi token tiap anggotanya YANG ADA DI GRUP INI.
 *
 * Anggota yang bukan peserta grup dibuang, bukan ditulis apa adanya: menandai
 * orang yang tidak ada di grup tidak memberi notifikasi kepada siapa pun, ia
 * cuma meninggalkan deretan angka yang tidak bisa dibaca klien.
 *
 * Nama daftar yang tidak dikenal dibiarkan utuh - agen boleh menulis "@ok".
 */
export function mekarkanDaftar(
  teks: string,
  orang: Peserta[],
  daftar: DaftarTag[],
): { teks: string; kosong: string[] } {
  if (!teks.includes("@") || !daftar.length) return { teks, kosong: [] };


  const idx = indeksPeserta(orang);
  const perSlug = new Map(daftar.map((d) => [d.slug.toLowerCase(), d]));
  const kosong: string[] = [];

  const hasil = teks.replace(POLA_DAFTAR, (utuh, depan: string, kata: string) => {
    const d = perSlug.get(kata.toLowerCase());
    if (!d) return utuh;

    const token: string[] = [];
    for (const a of d.anggota) {
      const ada = (a.lid ? idx.get(a.lid) : null) ?? (a.pn ? idx.get(a.pn) : null);
      if (!ada) continue;
      const t = tokenMention(ada);
      if (t && !token.includes(t)) token.push("@" + t);
    }

    if (!token.length) {
      if (!kosong.includes(d.label)) kosong.push(d.label);
      return utuh;
    }
    return depan + token.join(" ");
  });

  return { teks: hasil, kosong };
}

/**
 * Rapikan teks sebelum dikirim, dan kumpulkan siapa saja yang ditandai.
 *
 * Dua hal yang dikerjakan:
 *   1. "@+6281200000099" atau "@081200000099" -> bentuk kanonik peserta itu.
 *      Tanda "+" saja sudah cukup membuat WhatsApp tidak mengenali mention-nya,
 *      dan itulah yang terjadi pada percobaan pertama pemilik.
 *   2. Kumpulkan pasangan PN+LID-nya untuk masuk mentionedJid.
 *
 * Angka yang BUKAN peserta grup ini dibiarkan apa adanya. Agen boleh menulis
 * "@12345" sebagai nomor tiket vendor tanpa teksnya diubah diam-diam.
 */
export function rapikanMention(teks: string, orang: Peserta[], daftar: DaftarTag[] = []): HasilRapi {
  /* Daftar peserta kosong BUKAN alasan berhenti lebih awal. Kalau gateway
     sedang tidak terjangkau, orang[] kosong - dan kalau kita pulang di sini,
     "@inspector-area" yang diketik agen lolos apa adanya ke grup klien tanpa
     ada yang menolak. Yang benar: tetap dimekarkan, hasilnya nol anggota, dan
     actSend menolak kiriman itu dengan pesan jelas. */
  if (!teks.includes("@")) return { teks, mentions: [], daftarKosong: [] };

  /* Daftar dimekarkan LEBIH DULU, lalu hasilnya ikut melewati jalur angka di
     bawah - jadi cuma ada satu tempat yang memutuskan bentuk token akhir. */
  const mekar = mekarkanDaftar(teks, orang, daftar);
  teks = mekar.teks;

  const idx = indeksPeserta(orang);
  const kena = new Map<string, { pn: string | null; lid: string | null }>();

  const hasil = teks.replace(POLA, (utuh, angka: string) => {
    const o = cari(idx, angka);
    if (!o) return utuh;
    const token = tokenMention(o);
    if (!token) return utuh;
    kena.set(`${o.pn ?? ""}|${o.lid ?? ""}`, { pn: o.pn, lid: o.lid });
    return "@" + token;
  });

  return { teks: hasil, mentions: [...kena.values()], daftarKosong: mekar.kosong };
}

/**
 * Nama-nama yang benar-benar akan tertandai kalau teks ini dikirim sekarang.
 * Dipakai baris "Menandai ..." di kotak balas - satu-satunya cara agen bisa
 * memeriksa hasil mekarnya sebuah daftar sebelum pesan masuk ke grup klien.
 */
export function namaDitandai(teks: string, orang: Peserta[], daftar: DaftarTag[] = []): string[] {
  const mekar = mekarkanDaftar(teks, orang, daftar);
  return potongMention(mekar.teks, orang)
    .filter((p) => p.t === "tag")
    .map((p) => p.v.slice(1));
}

/* --------------------------- jalur tampil --------------------------- */

export type Potongan = { t: "teks"; v: string } | { t: "tag"; v: string };

/**
 * Pecah teks jadi potongan supaya mention bisa ditampilkan sebagai nama.
 *
 * Tanpa ini utas tiket penuh "bang @123456789012345" - itu bentuk yang benar di
 * kabel, tapi tidak ada manusia yang bisa membacanya. Yang ditandai belum tentu
 * peserta yang kita kenal; kalau tidak ketemu, angkanya dibiarkan supaya tidak
 * ada yang hilang diam-diam.
 */
export function potongMention(
  teks: string,
  orang: Peserta[],
  kami?: { pn: string | null; lid: string | null },
): Potongan[] {
  if (!teks.includes("@")) return [{ t: "teks", v: teks }];

  const idx = indeksPeserta(orang);
  const out: Potongan[] = [];
  let akhir = 0;

  POLA.lastIndex = 0;
  for (const m of teks.matchAll(POLA)) {
    const angka = m[1];
    const mulai = m.index ?? 0;

    let label: string | null = null;
    if (kami && (angka === kami.lid || normalizeMsisdn(angka) === kami.pn)) label = LABEL_KAMI;
    else label = cari(idx, angka)?.nama ?? null;
    if (!label) continue;

    if (mulai > akhir) out.push({ t: "teks", v: teks.slice(akhir, mulai) });
    out.push({ t: "tag", v: "@" + label });
    akhir = mulai + m[0].length;
  }

  if (akhir < teks.length) out.push({ t: "teks", v: teks.slice(akhir) });
  return out.length ? out : [{ t: "teks", v: teks }];
}

/** Versi datar untuk cuplikan satu baris. */
export function teksMention(
  teks: string,
  orang: Peserta[],
  kami?: { pn: string | null; lid: string | null },
): string {
  return potongMention(teks, orang, kami)
    .map((p) => p.v)
    .join("");
}
