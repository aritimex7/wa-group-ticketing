"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * section 9.1 "Kartu berubah realtime saat ada yang mengambil, tanpa perlu refresh."
 *
 * Perubahan digabung dalam jendela pendek sebelum menyegarkan. Di grup ramai,
 * satu balasan bisa memicu lima peristiwa beruntun; tanpa penggabungan, layar
 * digambar ulang lima kali dan posisi scroll agen ikut terguncang.
 *
 * Kalau aliran peristiwa putus, komponen ini menampilkan pita peringatan.
 * Layar yang diam padahal koneksinya mati adalah versi kecil dari mimpi buruk
 * di section 15 - antrean terlihat sepi padahal sebenarnya kita buta.
 */
export function Realtime({ quiet = false }: { quiet?: boolean }) {
  const router = useRouter();
  const [lost, setLost] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      es = new EventSource("/api/stream");

      es.onopen = () => setLost(false);

      es.onmessage = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => router.refresh(), 300);
      };

      es.onerror = () => {
        setLost(true);
        es?.close();
        if (!closed) retry = setTimeout(connect, 4000);
      };
    };

    connect();

    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [router]);

  if (!lost || quiet) return null;

  return (
    <div
      role="status"
      className="rule-b bg-tint-breach px-4 py-2 text-[13px] text-st-breach"
    >
      Aliran pembaruan langsung terputus. Layar ini mungkin tidak menampilkan tiket terbaru
      <span className="text-ink-muted"> - menyambung ulang...</span>
    </div>
  );
}
