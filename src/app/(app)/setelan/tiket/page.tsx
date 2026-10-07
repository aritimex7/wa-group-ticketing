/**
 * Tab Tiket - halaman Setelan.
 *
 * Penjaga peran, judul, dan barisan tab ada di ../layout.tsx.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { ignoredPhrases, internalNumbers, mentionListMembers, mentionLists } from "@/db/schema";
import { getAllSettings } from "@/lib/settings";
import { Sec, Form, Grid, Field, Check } from "../ui";
import * as A from "../actions";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [s, nomorList, frasaList, tagList] = await Promise.all([
    getAllSettings(),
    db.select().from(internalNumbers).where(eq(internalNumbers.isActive, true)),
    db.select().from(ignoredPhrases).where(eq(ignoredPhrases.isActive, true)),
    db
      .select({
        id: mentionLists.id,
        slug: mentionLists.slug,
        label: mentionLists.label,
        anggotaId: mentionListMembers.id,
        pn: mentionListMembers.pn,
        lid: mentionListMembers.lid,
        anggotaLabel: mentionListMembers.label,
      })
      .from(mentionLists)
      .leftJoin(mentionListMembers, eq(mentionListMembers.listId, mentionLists.id))
      .where(eq(mentionLists.isActive, true))
      .orderBy(mentionLists.slug, mentionListMembers.id),
  ]);

  /* Satu query dengan join, dikelompokkan di sini - bukan N+1 query per daftar. */
  const daftarTagList = new Map<
    number,
    { id: number; slug: string; label: string; anggota: { id: number; pn: string | null; lid: string | null; label: string | null }[] }
  >();
  for (const r of tagList) {
    let d = daftarTagList.get(r.id);
    if (!d) {
      d = { id: r.id, slug: r.slug, label: r.label, anggota: [] };
      daftarTagList.set(r.id, d);
    }
    if (r.anggotaId !== null) {
      d.anggota.push({ id: r.anggotaId, pn: r.pn, lid: r.lid, label: r.anggotaLabel });
    }
  }

  return (
    <>
      <Sec title="Pemicu tiket">
        <Form action={A.simpanPemicu}>
          <Check name="mention" defaultChecked={s["trigger.mention_creates_ticket"] as boolean}>
            Pesan yang mention akun kita jadi tiket
          </Check>
          <Check name="reply" defaultChecked={s["trigger.reply_creates_ticket"] as boolean}>
            Pesan yang swipe-reply pesan kita jadi tiket
          </Check>

          <div className="mt-5 rule-t pt-4">
            <Check name="dm" defaultChecked={s["ingest.dm_enabled"] as boolean}>
              Simpan chat pribadi (japri), bukan cuma grup
            </Check>
            <p className="mt-1 max-w-[62ch] text-[12.5px] text-ink-muted">
              Satu nomor WhatsApp membawa <span className="text-ink">seluruh</span> percakapan
              pribadi pemiliknya. Menyalakan ini berarti isi chat keluarga dan teman ikut
              tersimpan di database tim, dan ikut terbaca semua agen lewat halaman Cari. Selama
              mati, japri tidak disimpan sama sekali - bukan disimpan lalu disembunyikan.
            </p>
            <div className="mt-2">
              <Check name="dmTiket" defaultChecked={s["trigger.dm_creates_ticket"] as boolean}>
                Pesan japri masuk jadi tiket
              </Check>
              <p className="mt-1 max-w-[62ch] text-[12.5px] text-ink-muted">
                Di japri tidak ada mention - tiap pesan yang datang memang ditujukan ke kita.
                Matikan kalau japri cuma mau bisa dibaca dan dicari, tanpa memenuhi antrean.
              </p>
            </div>
          </div>

          <div className="mt-4 max-w-[24rem]">
            <Field label="Gabungkan pesan susulan (menit)">
              <input
                name="gabung"
                type="number"
                min={0}
                defaultValue={s["ticket.merge_window_min"] as number}
                className="field"
              />
            </Field>
          </div>
          <p className="mt-1.5 max-w-[62ch] text-[12.5px] text-ink-muted">
            Orang yang sama menyapa lagi sebelum tiketnya dibalas akan menempel ke tiket yang
            sudah ada, bukan membuat tiket kedua. Berlaku hanya selama tiket itu{" "}
            <span className="text-ink">belum dibalas sama sekali</span> - begitu ada balasan,
            pesan berikutnya kembali jadi tiket sendiri supaya jam SLA-nya ikut jalan. Isi{" "}
            <span className="tnum">0</span> untuk mematikan.
          </p>
        </Form>

        <h3 className="micro mt-7">Nomor internal yang diabaikan</h3>
        <ul className="mt-2 space-y-1">
          {nomorList.map((n) => (
            <li key={n.id} className="flex items-baseline gap-3 text-[13px]">
              <span className="tnum">{n.pn ?? "-"}</span>
              <span className="tnum text-ink-faint">{n.lid ? `lid ${n.lid}` : "lid belum diketahui"}</span>
              <span className="text-ink-muted">{n.label}</span>
              <form action={A.hapusNomorInternal} className="ml-auto">
                <input type="hidden" name="id" value={n.id} />
                <button className="btn btn-quiet h-6 px-2 text-[12px]">Hapus</button>
              </form>
            </li>
          ))}
        </ul>
        <form action={A.tambahNomorInternal} className="mt-2 flex flex-wrap gap-2">
          <input name="nomor" placeholder="08123456789" className="field w-44" />
          <input name="lid" placeholder="LID (kalau tahu)" className="field w-44" />
          <input name="label" placeholder="keterangan" className="field w-44" />
          <button className="btn">Tambah</button>
        </form>

        <h3 className="micro mt-7">Frasa yang diabaikan</h3>
        <p className="mt-1 max-w-[62ch] text-[12.5px] text-ink-muted">
          Setelan paling berbahaya di halaman ini. Pesan yang kena filter tidak dibuang - masuk
          keranjang &ldquo;diabaikan&rdquo; di dashboard leader supaya salah isi bisa ketahuan.
        </p>
        <ul className="mt-2 space-y-1">
          {frasaList.map((f) => (
            <li key={f.id} className="flex items-baseline gap-3 text-[13px]">
              <span>{f.phrase}</span>
              <span className="micro text-ink-faint">{f.matchMode}</span>
              <form action={A.hapusFrasa} className="ml-auto">
                <input type="hidden" name="id" value={f.id} />
                <button className="btn btn-quiet h-6 px-2 text-[12px]">Hapus</button>
              </form>
            </li>
          ))}
        </ul>
        <form action={A.tambahFrasa} className="mt-2 flex flex-wrap gap-2">
          <input name="frasa" placeholder="ok" className="field w-44" />
          <select name="mode" className="field w-44">
            <option value="exact">sama persis</option>
            <option value="prefix">diawali frasa ini</option>
          </select>
          <button className="btn">Tambah</button>
        </form>
      </Sec>

      <Sec
        title="Daftar tag"
        note="Satu nama untuk beberapa orang. Agen mengetik @nama, dan yang ditandai hanya anggota yang memang ada di grup itu - sisanya dilewati."
      >
        <ul className="mt-1 space-y-5">
          {[...daftarTagList.values()].map((d) => (
            <li key={d.id}>
              <div className="flex items-baseline gap-3">
                <span className="text-[14px] font-semibold">
                  <span className="text-ink-faint">@</span>
                  {d.slug}
                </span>
                <span className="text-[13px] text-ink-muted">{d.label}</span>
                <span className="micro text-ink-faint">
                  {d.anggota.length === 0 ? "belum ada anggota" : `${d.anggota.length} anggota`}
                </span>
                <form action={A.hapusDaftarTag} className="ml-auto">
                  <input type="hidden" name="id" value={d.id} />
                  <button className="btn btn-quiet h-6 px-2 text-[12px]">Hapus daftar</button>
                </form>
              </div>

              <ul className="mt-1.5 space-y-1 border-l border-rule pl-3">
                {d.anggota.map((a) => (
                  <li key={a.id} className="flex items-baseline gap-3 text-[13px]">
                    <span className="tnum">{a.pn ? `+${a.pn}` : "-"}</span>
                    <span className="tnum text-[11.5px] text-ink-faint">
                      {a.lid ? `lid ${a.lid}` : "lid belum diketahui"}
                    </span>
                    <span className="text-ink-muted">{a.label}</span>
                    <form action={A.hapusAnggotaDaftar} className="ml-auto">
                      <input type="hidden" name="id" value={a.id} />
                      <button className="btn btn-quiet h-6 px-2 text-[12px]">Hapus</button>
                    </form>
                  </li>
                ))}
                <li>
                  <form action={A.tambahAnggotaDaftar} className="mt-1 flex flex-wrap gap-2">
                    <input type="hidden" name="listId" value={d.id} />
                    <input name="nomor" placeholder="08123456789" className="field w-44" />
                    <input name="lid" placeholder="LID (kalau tahu)" className="field w-44" />
                    <input name="label" placeholder="nama" className="field w-40" />
                    <button className="btn">Tambah anggota</button>
                  </form>
                </li>
              </ul>
            </li>
          ))}
        </ul>

        <h3 className="micro mt-7">Daftar baru</h3>
        <form action={A.tambahDaftarTag} className="mt-2 flex flex-wrap gap-2">
          <input name="slug" placeholder="sameday" className="field w-44" />
          <input name="label" placeholder="Tim Sameday" className="field w-56" />
          <button className="btn">Buat daftar</button>
        </form>
        <p className="mt-2 max-w-[62ch] text-[12.5px] text-ink-muted">
          Nama daftar harus diawali huruf. Spasi dan tanda baca diubah jadi tanda hubung, karena
          WhatsApp memutus mention di spasi.
        </p>
      </Sec>
    </>
  );
}
