import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { mentionListMembers, mentionLists } from "@/db/schema";
import { gateway, type GroupPerson } from "@/lib/gateway";
import { displayIdentity, isDmJid, petaNama, selfIdentity, type PetaNama } from "@/lib/identity";
import type { DaftarTag, Peserta } from "@/lib/mention";

/**
 * Siapa saja yang bisa ditandai di sebuah grup - SPEC section 12.
 *
 * Dua sumber, digabung, karena masing-masing sendirian tidak cukup:
 *
 *   gateway   daftar peserta LENGKAP (termasuk yang belum pernah bicara) plus
 *             nama dari kontak tersimpan di HP. Tapi namanya jarang ada -
 *             terukur di grup klien sungguhan cuma 1 dari 10 dan 16 dari 59
 *             nomor yang tersimpan.
 *   messages  pushName orang yang pernah bicara di grup ini. Bukan nama
 *             kontak, tapi nama yang mereka pasang sendiri - dan justru
 *             tersedia untuk orang yang paling sering kita ajak bicara.
 *
 * Kalau gateway sedang mati, daftar dari messages saja tetap dikembalikan.
 * Halaman tiket TIDAK BOLEH gagal dibuka cuma karena daftar tag tidak terambil;
 * kehilangan fitur tag jauh lebih ringan daripada kehilangan tiketnya.
 */
export type OrangGrup = Peserta & {
  /** namanya cuma nomor - belum tersimpan di kontak dan belum pernah bicara. */
  anonim: boolean;
};

/* Umur cache. Peserta grup berubah dalam hitungan minggu, bukan detik; yang
   penting adalah tidak memanggil gateway tiap kali halaman tiket digambar.
   Saat gateway gagal, cache dipasang pendek supaya pulih sendiri tanpa
   restart. */
const UMUR_OK = 10 * 60_000;
const UMUR_GAGAL = 60_000;

const cache = new Map<string, { sampai: number; isi: OrangGrup[] }>();

export function lupakanOrangGrup(groupJid?: string): void {
  if (groupJid) cache.delete(groupJid);
  else cache.clear();
  if (!groupJid) cacheKontak = null;
}

/* Kontak tersimpan berlaku lintas grup, jadi satu cache untuk seluruh aplikasi.
   Ukurannya wajar - terukur 884 entri di akun ini, dua entri per orang (satu
   di sumbu PN, satu di sumbu LID). */
let cacheKontak: { sampai: number; isi: PetaNama } | null = null;

/**
 * Nama dari buku alamat HP gateway, untuk dipakai DI MANA PUN nama orang
 * ditampilkan - bukan cuma di mention.
 *
 * Gagal mengambilnya bukan alasan halaman gagal: petanya kosong, dan semua
 * pemanggil jatuh ke pushName seperti sebelum fitur ini ada.
 */
export async function kontakTersimpan(): Promise<PetaNama> {
  const sekarang = Date.now();
  if (cacheKontak && cacheKontak.sampai > sekarang) return cacheKontak.isi;

  const daftar = await gateway()
    .fetchContacts()
    .catch(() => null);
  const isi = petaNama(daftar ?? []);
  cacheKontak = { sampai: sekarang + (daftar ? UMUR_OK : UMUR_GAGAL), isi };
  return isi;
}

export async function orangGrup(groupJid: string): Promise<OrangGrup[]> {
  const sekarang = Date.now();
  const simpan = cache.get(groupJid);
  if (simpan && simpan.sampai > sekarang) return simpan.isi;

  /* Chat pribadi tidak punya peserta - endpoint grup pasti gagal untuk JID ini,
     dan memanggilnya cuma menambah satu perjalanan jaringan yang sudah pasti
     sia-sia tiap sepuluh menit. Lawan bicaranya diambil dari pesan yang ada. */
  const dm = isDmJid(groupJid);

  const [peserta, pernahBicara] = await Promise.all([
    dm ? Promise.resolve(null) : gateway().fetchPeople(groupJid).catch(() => null),
    namaDariPesan(groupJid),
  ]);

  const isi = gabung(peserta, pernahBicara);
  cache.set(groupJid, { sampai: sekarang + (peserta || dm ? UMUR_OK : UMUR_GAGAL), isi });
  return isi;
}

/**
 * Daftar tag beserta anggotanya (section 12).
 *
 * Tidak di-cache: isinya kecil, satu query, dan justru ini yang paling sering
 * diubah orang lalu langsung dicoba. Cache sepuluh menit di sini cuma akan
 * membuat leader mengira daftarnya tidak tersimpan.
 */
export async function daftarTag(): Promise<DaftarTag[]> {
  const rows = await db
    .select({
      slug: mentionLists.slug,
      label: mentionLists.label,
      pn: mentionListMembers.pn,
      lid: mentionListMembers.lid,
    })
    .from(mentionLists)
    .leftJoin(mentionListMembers, eq(mentionListMembers.listId, mentionLists.id))
    .where(eq(mentionLists.isActive, true))
    .orderBy(mentionLists.slug);

  const peta = new Map<string, DaftarTag>();
  for (const r of rows) {
    let d = peta.get(r.slug);
    if (!d) {
      d = { slug: r.slug, label: r.label, anggota: [] };
      peta.set(r.slug, d);
    }
    if (r.pn || r.lid) d.anggota.push({ pn: r.pn, lid: r.lid });
  }
  return [...peta.values()];
}

/** pushName terakhir tiap orang yang pernah mengirim pesan di grup ini. */
async function namaDariPesan(groupJid: string): Promise<Peserta[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (coalesce(m.sender_lid, m.sender_pn))
           m.sender_pn AS pn, m.sender_lid AS lid, m.sender_push_name AS nama
    FROM messages m
    WHERE m.group_jid = ${groupJid}
      AND m.direction = 'in'
      AND m.sender_push_name IS NOT NULL
      AND coalesce(m.sender_lid, m.sender_pn) IS NOT NULL
    ORDER BY coalesce(m.sender_lid, m.sender_pn), m.created_at DESC
  `)) as unknown as { pn: string | null; lid: string | null; nama: string }[];

  return rows.map((r) => ({ pn: r.pn, lid: r.lid, nama: r.nama }));
}

function gabung(peserta: GroupPerson[] | null, bicara: Peserta[]): OrangGrup[] {
  const kami = selfIdentity();
  const namaBicara = new Map<string, string>();
  for (const b of bicara) {
    if (b.lid) namaBicara.set(b.lid, b.nama);
    if (b.pn) namaBicara.set(b.pn, b.nama);
  }

  /* Peserta dari gateway jadi kerangkanya kalau ada; kalau tidak, yang pernah
     bicara sajalah daftarnya. */
  const dasar = peserta?.length
    ? peserta.map((p) => ({ pn: p.pn, lid: p.lid, kontak: p.name }))
    : bicara.map((b) => ({ pn: b.pn, lid: b.lid, kontak: null as string | null }));

  const out: OrangGrup[] = [];
  for (const d of dasar) {
    // Nomor sendiri tidak pernah jadi pilihan - menandai diri sendiri di grup
    // klien tidak ada gunanya dan cuma memanjangkan daftar.
    if ((kami.lid && d.lid === kami.lid) || (kami.pn && d.pn === kami.pn)) continue;

    const dariBicara = (d.lid ? namaBicara.get(d.lid) : null) ?? (d.pn ? namaBicara.get(d.pn) : null);
    const nama = d.kontak?.trim() || dariBicara?.trim() || null;
    out.push({
      pn: d.pn,
      lid: d.lid,
      nama: nama ?? displayIdentity({ pn: d.pn, lid: d.lid }),
      anonim: !nama,
    });
  }

  /* Yang punya nama duluan. Di grup 59 orang, 43 di antaranya tampil sebagai
     nomor mentah - kalau diurut apa adanya, orang yang benar-benar dicari
     tenggelam di antara deretan angka. */
  out.sort((a, b) => {
    if (a.anonim !== b.anonim) return a.anonim ? 1 : -1;
    return a.nama.localeCompare(b.nama, "id");
  });
  return out;
}
