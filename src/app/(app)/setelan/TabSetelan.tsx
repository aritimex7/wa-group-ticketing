"use client";

/**
 * Barisan tab halaman Setelan.
 *
 * Client component hanya karena butuh tahu tab mana yang sedang aktif -
 * usePathname() tidak tersedia di layout server. Tidak ada state lain di sini;
 * navigasinya tetap Link biasa, jadi tiap tab tetap halaman server sendiri.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

export const TAB = [
  { href: "/setelan/koneksi", label: "Koneksi" },
  { href: "/setelan/grup", label: "Grup" },
  { href: "/setelan/tiket", label: "Tiket" },
  { href: "/setelan/agen", label: "Agen" },
  { href: "/setelan/operasional", label: "Operasional" },
  { href: "/setelan/riwayat", label: "Riwayat" },
] as const;

export function TabSetelan() {
  const path = usePathname();

  return (
    <nav className="rule-b -mx-5 flex gap-1 overflow-x-auto px-5">
      {TAB.map((t) => {
        const aktif = path === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={aktif ? "page" : undefined}
            /* Garis bawah tebal sebagai penanda aktif, bukan latar berwarna:
               halaman ini penuh kolom input, dan satu blok warna lagi cuma
               menambah keramaian yang justru sedang dirapikan. */
            className={
              "shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] transition-colors " +
              (aktif
                ? "border-accent text-ink"
                : "border-transparent text-ink-muted hover:text-ink")
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
