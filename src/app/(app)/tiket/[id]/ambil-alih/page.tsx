import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAgent } from "@/lib/auth";
import { loadTicket } from "@/lib/queries";
import { takeoverTicket } from "@/lib/tickets";

export const dynamic = "force-dynamic";

/**
 * section 6.3 Takeover.
 *
 *   "Tombol tersedia bebas, tidak perlu izin.
 *    Wajib konfirmasi: 'Tiket ini sedang ditangani Rio. Yakin ambil alih?'
 *    Dicatat di ticket_events.
 *    Layar agen lama langsung berubah jadi 'diambil alih oleh {nama}' supaya
 *    dia berhenti mengetik."
 *
 * Poin terakhir ditangani lewat peristiwa realtime: takeoverTicket() menyiarkan
 * ticket.takenover, dan halaman tiket agen lama menyegarkan diri lalu memasuki
 * keadaan terkunci.
 *
 * Konfirmasi dibuat sebagai halaman tersendiri, bukan dialog: kalau ada dua klik
 * beruntun karena layar basi, yang kedua mendarat di halaman yang sudah
 * menampilkan keadaan terbaru - bukan pada dialog yang isinya sudah kedaluwarsa.
 */
export default async function TakeoverPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAgent();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();

  const t = await loadTicket(id);
  if (!t) notFound();

  // Sudah bebas? Tidak perlu konfirmasi apa pun.
  if (t.claimedBy === null) redirect(`/tiket/${id}`);

  async function konfirmasi() {
    "use server";
    const me = await requireAgent();
    await takeoverTicket(id, me.id);
    redirect(`/tiket/${id}`);
  }

  return (
    <div className="grid h-full place-items-center px-6">
      <div className="max-w-[420px]">
        <h1 className="text-[20px]">Ambil alih tiket ini?</h1>
        <p className="mt-2 text-[13.5px] text-ink-muted">
          Tiket ini sedang ditangani <strong className="text-ink">{t.claimedByName}</strong> di grup{" "}
          <strong className="text-ink">{t.groupName ?? t.groupJid}</strong>.
        </p>
        <p className="mt-2 text-[13px] text-ink-faint">
          Layarnya akan langsung berubah jadi &ldquo;diambil alih&rdquo; supaya dia berhenti mengetik.
          Tindakan ini tercatat di riwayat tiket.
        </p>

        <div className="mt-6 flex gap-2">
          <form action={konfirmasi}>
            <button className="btn btn-primary" type="submit">
              Ya, ambil alih
            </button>
          </form>
          <Link href={`/tiket/${id}`} className="btn">
            Batal
          </Link>
        </div>
      </div>
    </div>
  );
}
