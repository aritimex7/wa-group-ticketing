/**
 * Kerangka halaman Setelan: penjaga peran, judul, dan barisan tab.
 *
 * Kenapa halaman ini dipecah. Sebelumnya sembilan section ditumpuk dalam satu
 * halaman: terukur 4939px alias 7,4 layar penuh menggulir, 123 kolom input, dan
 * 11 tombol Simpan tersebar tanpa aturan. Mencari satu setelan berarti menggulir
 * sambil menebak. Sekarang tiap tab satu halaman server sendiri - dan itu bukan
 * cuma soal rapi: tiap tab hanya menjalankan query yang ia butuhkan, bukan
 * kesembilan-sembilannya sekaligus seperti dulu.
 *
 * requireLeader() dipasang di sini, satu kali, supaya tidak ada sub-halaman yang
 * bisa lupa memasangnya. Menambah tab baru berarti menambah satu berkas page.tsx
 * dan satu baris di TAB - penjaganya sudah otomatis ikut.
 */
import { redirect } from "next/navigation";
import { AccessDenied, requireLeader } from "@/lib/auth";
import { TanpaAkses } from "@/components/TanpaAkses";
import { TabSetelan } from "./TabSetelan";

export const dynamic = "force-dynamic";

export default async function SetelanLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireLeader();
  } catch (err) {
    if (err instanceof AccessDenied && err.kind === "role") {
      return <TanpaAkses />;
    }
    redirect("/masuk");
  }

  return (
    <div className="scroll-y h-full">
      <div className="mx-auto max-w-[860px] px-5 pb-20">
        <header className="pt-7 pb-4">
          <h1 className="text-[22px]">Setting</h1>
          <p className="mt-1 max-w-[62ch] text-[13px] text-ink-muted">
            Setiap perubahan di halaman ini tercatat lengkap dengan nilai sebelum dan
            sesudahnya. Target SLA yang diubah diam-diam bisa mengubah makna seluruh laporan.
          </p>
        </header>

        {/* Menempel saat menggulir: tab yang ikut hilang ke atas memaksa orang
            menggulir balik hanya untuk pindah tab. */}
        <div className="sticky top-13 z-20 bg-paper/95 backdrop-blur-[2px]">
          <TabSetelan />
        </div>

        {children}
      </div>
    </div>
  );
}
