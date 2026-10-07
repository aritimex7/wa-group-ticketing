"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Wadah yang membuka dirinya di POSISI PALING BAWAH.
 *
 * Dipakai halaman "Lihat chat grup". Percakapan dibaca dari atas ke bawah, jadi
 * yang paling baru selalu di ujung bawah - dan itu justru yang pertama dicari
 * orang saat membukanya. Tanpa ini agen harus menggulir dulu sepanjang layar
 * cuma untuk sampai ke pesan terakhir, tiap kali.
 *
 * useLayoutEffect, bukan useEffect: keduanya sama-sama menggulir, bedanya
 * useEffect berjalan SETELAH cat pertama - jadi ada satu frame di mana halaman
 * terlihat berada di atas lalu melompat. Satu frame itu kecil, tapi terjadi
 * tiap kali halaman dibuka.
 *
 * Gulirnya langsung, bukan smooth. Animasi menggulir 2000px tidak menolong
 * siapa pun; yang dibutuhkan adalah sudah sampai, bukan perjalanannya.
 */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function GulirBawah({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;

    /* Sekali lagi di frame berikutnya. Tinggi baris bisa berubah sedikit
       setelah font selesai dimuat, dan kalau itu terjadi sesudah gulir pertama
       posisinya berhenti beberapa puluh piksel dari dasar - cukup untuk
       menyembunyikan satu pesan terakhir. */
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
