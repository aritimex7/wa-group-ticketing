/**
 * Identitas WhatsApp: PN vs LID - SPEC section 3, "jebakan nomor satu".
 *
 * Aturan yang dikodekan di berkas ini:
 *  3.1  Setiap identitas disimpan dua kolom: *_pn dan *_lid.
 *  3.2  Setiap perbandingan identitas mengecek KEDUANYA.
 *  3.3  Konversi PN -> LID tersedia. Arah LID -> PN TIDAK dijamin.
 *       Tidak ada satu pun fungsi di sini yang mencoba membalik LID jadi nomor.
 *  3.4  LID milik akun sendiri disimpan di config.
 *
 * Catatan penting soal kegagalan senyap: kalau satu sisi hanya punya PN dan
 * sisi lain hanya punya LID, kita TIDAK BISA menyimpulkan apa pun. Itu bukan
 * "tidak cocok" - itu "tidak tahu". Dua hal itu dibedakan di sini
 * (lihat compareIdentity) supaya kasus "tidak tahu" bisa dihitung dan
 * ditampilkan di panel Kesehatan Data (section 10), bukan hilang diam-diam.
 */

export const DOMAIN_PN = "s.whatsapp.net";
export const DOMAIN_PN_ALT = "c.us"; // dipakai sebagian wrapper (WAHA)
export const DOMAIN_LID = "lid";
export const DOMAIN_GROUP = "g.us";

export type Identity = {
  /** nomor telepon, tanpa domain. contoh: "6281234567890" */
  pn: string | null;
  /** LID, tanpa domain. contoh: "123456789012345" */
  lid: string | null;
};

export const EMPTY_IDENTITY: Identity = { pn: null, lid: null };

/* ------------------------- pengenalan bentuk JID ------------------------- */

export function isGroupJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith("@" + DOMAIN_GROUP);
}

export function isLidJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith("@" + DOMAIN_LID);
}

export function isPnJid(jid: string | null | undefined): boolean {
  return !!jid && (jid.endsWith("@" + DOMAIN_PN) || jid.endsWith("@" + DOMAIN_PN_ALT));
}

/**
 * JID satu orang - lawan bicara di chat pribadi.
 *
 * Bukan sekadar "bukan grup": WhatsApp juga mengirim status, siaran, dan
 * newsletter lewat remoteJid. Kalau semua yang bukan grup dianggap chat
 * pribadi, status orang lain ikut jadi tiket.
 */
export function isDmJid(jid: string | null | undefined): boolean {
  if (!jid) return false;
  if (jid === "status@broadcast" || jid.endsWith("@broadcast")) return false;
  if (jid.endsWith("@newsletter")) return false;
  return isPnJid(jid) || isLidJid(jid);
}

/**
 * Buang akhiran device/agent yang kadang menempel:
 *   "6281234:12@s.whatsapp.net" -> "6281234@s.whatsapp.net"
 *   "6281234_1:2@s.whatsapp.net" -> "6281234@s.whatsapp.net"
 * Tanpa ini, pesan dari perangkat tertaut dianggap orang lain.
 */
export function stripDevice(jid: string): string {
  const at = jid.lastIndexOf("@");
  if (at < 0) return jid.replace(/[:_].*$/, "");
  const user = jid.slice(0, at).replace(/[:_].*$/, "");
  return user + jid.slice(at);
}

/** Bagian user saja, tanpa domain dan tanpa device. */
export function userPart(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const clean = stripDevice(jid.trim());
  const at = clean.lastIndexOf("@");
  const user = at < 0 ? clean : clean.slice(0, at);
  return user.length ? user : null;
}

/* --------------------------- membangun Identity --------------------------- */

/**
 * Terima satu atau beberapa JID mentah dan taruh masing-masing di laci yang benar.
 * Payload gateway sering mengirim pasangannya di field berbeda
 * (participant + participantAlt / senderPn / senderLid), jadi fungsi ini
 * sengaja menerima banyak masukan sekaligus.
 */
export function toIdentity(...rawJids: (string | null | undefined)[]): Identity {
  let pn: string | null = null;
  let lid: string | null = null;

  for (const raw of rawJids) {
    if (!raw) continue;
    const jid = raw.trim();
    if (!jid) continue;
    const user = userPart(jid);
    if (!user) continue;

    if (isLidJid(jid)) {
      lid ??= user;
    } else if (isPnJid(jid)) {
      pn ??= normalizeMsisdn(user);
    } else if (!jid.includes("@")) {
      // Tanpa domain: tebak dari bentuk. Nomor Indonesia diawali kode negara
      // dan panjangnya wajar; LID jauh lebih panjang dan tidak pernah diawali "62".
      if (/^\d{8,15}$/.test(user) && !/^\d{16,}$/.test(user)) pn ??= normalizeMsisdn(user);
      else lid ??= user;
    }
  }

  return { pn, lid };
}

/**
 * Normalisasi nomor: buang non-digit, ubah awalan lokal jadi kode negara.
 * "0812-3456-7890" -> "6281234567890"
 */
export function normalizeMsisdn(input: string, countryCode = "62"): string {
  let d = input.replace(/\D/g, "");
  if (!d) return input;
  if (d.startsWith("0")) d = countryCode + d.slice(1);
  return d;
}

/* --------------------------- perbandingan (3.2) --------------------------- */

export type IdentityMatch = "match" | "differ" | "unknown";

/**
 * Bandingkan dua identitas dengan mengecek KEDUA sumbu.
 *
 *  - "match"   : ada minimal satu sumbu yang sama-sama terisi dan nilainya sama.
 *  - "differ"  : ada sumbu yang sama-sama terisi, dan semuanya berbeda.
 *  - "unknown" : tidak ada sumbu yang sama-sama terisi. Kita TIDAK TAHU.
 *
 * Yang terakhir itu justru kasus yang paling sering bikin bug senyap:
 * satu sisi cuma punya LID, sisi lain cuma punya PN.
 */
export function compareIdentity(a: Identity, b: Identity): IdentityMatch {
  let comparable = false;

  if (a.lid && b.lid) {
    comparable = true;
    if (a.lid === b.lid) return "match";
  }
  if (a.pn && b.pn) {
    comparable = true;
    if (a.pn === b.pn) return "match";
  }

  return comparable ? "differ" : "unknown";
}

/** Ringkasan boolean. "unknown" diperlakukan sebagai BUKAN cocok - jangan menebak. */
export function sameIdentity(a: Identity, b: Identity): boolean {
  return compareIdentity(a, b) === "match";
}

/* --------------------------- identitas akun kita --------------------------- */

/** 3.4 LID + PN milik akun sendiri, dibaca dari environment. */
export function selfIdentity(): Identity {
  return toIdentity(
    process.env.WA_SELF_PN ? process.env.WA_SELF_PN + "@" + DOMAIN_PN : null,
    process.env.WA_SELF_LID ? process.env.WA_SELF_LID + "@" + DOMAIN_LID : null,
  );
}

export function isSelf(who: Identity, self: Identity = selfIdentity()): boolean {
  return sameIdentity(who, self);
}

/**
 * Apakah salah satu entri di daftar mention menunjuk ke kita?
 * mentionedJid bisa berisi campuran LID dan PN dalam satu array.
 */
export function mentionsSelf(
  mentionedJids: (string | null | undefined)[] | null | undefined,
  self: Identity = selfIdentity(),
): boolean {
  if (!mentionedJids?.length) return false;
  return mentionedJids.some((jid) => (jid ? sameIdentity(toIdentity(jid), self) : false));
}

/**
 * Cadangan: cari mention ke kita DI DALAM TEKS pesan.
 *
 * Ditemukan lewat Fase 0 pada data sungguhan, dan ini bukan kasus langka -
 * di grup uji pertama SEMUA mention datang seperti ini:
 *
 *   body           : "bang @123456789012345"
 *   mentionedJid   : null
 *
 * Jadi WhatsApp menuliskan mention sebagai teks "@<LID>" tanpa mengisi array
 * terstrukturnya sama sekali. Kalau hanya mengandalkan mentionedJid, tiket
 * TIDAK PERNAH terbentuk - persis kegagalan senyap yang diperingatkan section 3,
 * dalam bentuk yang tidak diduga spesifikasi.
 *
 * Ini BUKAN pelanggaran section 13 ("menebak reply tanpa tag"). Tidak ada tebakan:
 * ada tanda "@" eksplisit, dan angkanya dibandingkan SAMA PERSIS dengan PN atau
 * LID kita. Yang ditebak itu tidak ada.
 */
export function mentionsSelfInText(
  body: string | null | undefined,
  self: Identity = selfIdentity(),
): boolean {
  if (!body) return false;
  if (!self.pn && !self.lid) return false;

  for (const m of body.matchAll(/@(\d{5,20})/g)) {
    const angka = m[1];
    if (self.lid && angka === self.lid) return true;
    if (self.pn && normalizeMsisdn(angka) === self.pn) return true;
  }
  return false;
}

/* ------------------------- nama orang untuk UI ------------------------- */

/** Nama kontak tersimpan, dapat dicari lewat LID maupun PN. */
export type PetaNama = Map<string, string>;

export function petaNama(
  daftar: { pn: string | null; lid: string | null; name: string }[],
): PetaNama {
  const peta: PetaNama = new Map();
  for (const k of daftar) {
    if (!k.name) continue;
    if (k.lid) peta.set(k.lid, k.name);
    if (k.pn) peta.set(k.pn, k.name);
  }
  return peta;
}

export function namaTersimpan(peta: PetaNama | undefined, id: Identity): string | null {
  if (!peta) return null;
  return (id.lid ? peta.get(id.lid) : null) ?? (id.pn ? peta.get(id.pn) : null) ?? null;
}

/**
 * Nama satu orang untuk ditampilkan, urutan sengaja begini:
 *
 *   1. nama KONTAK TERSIMPAN - diminta pemilik. Yang dikenal tim adalah nama
 *      yang mereka simpan sendiri ("Pak Budi - PT Anu"), bukan nama pasang-
 *      sendiri klien yang bisa berubah kapan saja dan kadang cuma emoji.
 *   2. pushName - untuk yang belum tersimpan; lebih baik daripada angka.
 *   3. nomor, lalu LID. Lihat displayIdentity().
 */
export function namaOrang(
  peta: PetaNama | undefined,
  id: Identity,
  pushName?: string | null,
): string {
  return namaTersimpan(peta, id) ?? displayIdentity(id, pushName);
}

/** Cocokkan satu identitas ke sekumpulan identitas (mis. daftar nomor internal). */
export function matchesAny(who: Identity, list: Identity[]): boolean {
  return list.some((candidate) => sameIdentity(who, candidate));
}

/** Untuk ditampilkan di UI. LID tidak bisa dibalik jadi nomor, jadi apa adanya. */
export function displayIdentity(id: Identity, pushName?: string | null): string {
  if (pushName?.trim()) return pushName.trim();
  if (id.pn) return "+" + id.pn;
  if (id.lid) return "LID " + id.lid.slice(0, 6) + "...";
  return "tidak dikenal";
}
