import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { groups } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { hitungLebihBaru, loadGroupWindow } from "@/lib/thread";
import { Percakapan } from "@/components/Percakapan";
import { GulirBawah } from "@/components/GulirBawah";
import { smartStamp } from "@/lib/time";
import { denganDari, kembaliAman, labelKembali } from "@/lib/kembali";
import { kontakTersimpan, orangGrup } from "@/lib/orang";
import { namaOrang, selfIdentity, toIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * section 7.3 "Lihat chat grup".
 *
 *   "Membuka percakapan grup apa adanya di sekitar jam tiket, bisa di-scroll
 *    seperti WhatsApp. Read-only - membalas tetap harus lewat tiket supaya
 *    tercatat."
 *
 * Tidak ada kotak balas di halaman ini, dan itu disengaja. Begitu ada jalan
 * membalas tanpa tiket, atribusi dan SLA bocor lewat situ.
 */
export default async function GrupPage({
  params,
  searchParams,
}: {
  params: Promise<{ jid: string }>;
  searchParams: Promise<{ pada?: string; dari?: string }>;
}) {
  await requireAgent();

  const jid = decodeURIComponent((await params).jid);
  const sp = await searchParams;
  const kembali = kembaliAman(sp.dari);

  /* Satu nilai, sudah divalidasi, dipakai di SEMUA tempat.
     Dulu penjagaannya cuma dipasang di loadGroupWindow, sementara smartStamp
     di header tetap menerima Invalid Date - dan itulah yang melempar
     RangeError saat tanggal di URL tidak terbaca. */
  const diminta = sp.pada ? new Date(sp.pada) : null;
  const tanggalRusak = diminta !== null && Number.isNaN(diminta.getTime());
  const around = diminta && !tanggalRusak ? diminta : new Date();

  const rows = await db.select().from(groups).where(eq(groups.jid, jid)).limit(1);
  const group = rows[0];
  if (!group) notFound();

  const [messages, peserta, kontak] = await Promise.all([
    loadGroupWindow(jid, around),
    orangGrup(jid),
    kontakTersimpan(),
  ]);

  /* Jendela dibatasi jumlah baris, jadi ujung bawahnya belum tentu ujung
     percakapan. Kalau ternyata masih ada yang lebih baru, katakan - dan sediakan
     satu klik untuk lompat ke sana. */
  const terakhir = messages.at(-1)?.createdAt ?? null;
  const lebihBaru = terakhir ? await hitungLebihBaru(jid, terakhir) : 0;

  return (
    <div className="flex h-full flex-col">
      <header className="rule-b shrink-0 bg-surface px-5 py-3">
        {/* Kembali ke tempat asal, bukan selalu ke papan. Halaman ini dibuka
           dari tiket maupun dari hasil pencarian, dan dua-duanya mahal untuk
           dicari ulang. */}
        <Link href={kembali} className="text-[13px] text-ink-muted hover:text-ink">
          &larr; {labelKembali(kembali)}
        </Link>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4">
          <h1 className="text-[20px] leading-tight">
            {/* Di japri, JID-nya sendiri sudah identitas orangnya - jadi nama
                kontak tersimpan tetap menang atas pushName yang tersimpan di
                kolom name saat chat ini pertama kali muncul. */}
            {group.isDm ? namaOrang(kontak, toIdentity(jid), group.name) : (group.name ?? jid)}
          </h1>
          {group.clientLabel ? <span className="micro text-ink-faint">{group.clientLabel}</span> : null}
          <span className="ml-auto text-[12.5px] text-ink-muted">
            {/* Kalau waktu di tautan tidak terbaca, katakan - jangan diam-diam
                menampilkan "sekarang" seolah itu yang diminta. */}
            {tanggalRusak ? (
              <span style={{ color: "var(--st-open)" }}>
                waktu di tautan tidak terbaca, menampilkan yang terbaru &middot;{" "}
              </span>
            ) : null}
            sekitar {smartStamp(around)} &middot; hanya baca
          </span>
        </div>
      </header>

      {/* Terbuka di posisi paling bawah: yang dicari saat membuka halaman ini
          hampir selalu pesan terakhir, bukan pesan pertama. */}
      <GulirBawah className="scroll-y min-h-0 flex-1 bg-sunk">
        {messages.length === 0 ? (
          <p className="px-5 py-10 text-[13px] text-ink-muted">
            Tidak ada pesan tersimpan di sekitar waktu itu. Dashboard hanya melihat sejak hari
            gateway tersambung.
          </p>
        ) : (
          <Percakapan messages={messages} peserta={peserta} kami={selfIdentity()} kontak={kontak} />
        )}
      </GulirBawah>

      <div className="rule-t shrink-0 bg-surface px-5 py-3">
        {lebihBaru > 0 ? (
          <p className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
            <span style={{ color: "var(--st-open)" }}>
              Ini bukan ujung percakapan - masih ada{" "}
              <span className="tnum">{lebihBaru}</span> pesan yang lebih baru.
            </span>
            <Link
              href={denganDari(`/grup/${encodeURIComponent(jid)}`, kembali)}
              className="text-ink underline decoration-accent decoration-2 underline-offset-[5px]"
            >
              Lompat ke yang terbaru
            </Link>
          </p>
        ) : null}
        <p className="text-[12.5px] text-ink-muted">
          Halaman ini hanya baca. Balas lewat tiket supaya tercatat siapa yang menjawab.
        </p>
      </div>
    </div>
  );
}
