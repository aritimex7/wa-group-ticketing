"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { actCancelSend, actDiscardSend, actRetrySend } from "@/app/(app)/actions";

export type PendingItem = {
  id: string;
  body: string;
  status: "holding" | "sending" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
  releaseAt: string;
  agentName: string | null;
};

/**
 * Balasan yang SUDAH ditekan kirim tapi BELUM tuntas sampai ke WhatsApp.
 *
 * section 9.4: "Kirim gagal -> tiket kembali ke antrean dengan tanda merah dan teks
 * balasan masih utuh. Jangan pernah hilang diam-diam."
 *
 * Komponen ini lahir dari pelanggaran nyata terhadap kalimat itu: agen menekan
 * kirim, teksnya hilang dari layar, dan tidak ada satu pun tempat yang
 * menunjukkan pesannya masih tertahan. Dari kursi agen, "tertahan selamanya"
 * dan "sudah terkirim" terlihat persis sama - dan itu yang paling berbahaya.
 *
 * Rel kiri sengaja PUTUS-PUTUS, bukan penuh seperti pesan tim yang sudah
 * dikonfirmasi WhatsApp. Bedanya harus terbaca tanpa membaca labelnya.
 */
export function PendingOutbox({ items, ticketId }: { items: PendingItem[]; ticketId: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!items.length) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [items.length]);

  if (!items.length) return null;

  return (
    <ol className="px-5 pb-4">
      {items.map((it) => (
        <Item key={it.id} it={it} ticketId={ticketId} />
      ))}
    </ol>
  );
}

function Item({ it, ticketId }: { it: PendingItem; ticketId: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const sisaDetik = Math.max(0, Math.ceil((new Date(it.releaseAt).getTime() - Date.now()) / 1000));
  const masihBisaBatal = it.status === "holding" && sisaDetik > 0;
  const gagal = it.status === "failed";

  const warna = gagal ? "var(--st-breach)" : masihBisaBatal ? "var(--accent)" : "var(--st-open)";

  const keterangan = gagal
    ? `Gagal terkirim setelah ${it.attempts} percobaan`
    : masihBisaBatal
      ? `Ditahan ${sisaDetik} detik lagi - belum dikirim ke grup`
      : it.status === "sending"
        ? "Sedang dikirim..."
        : it.status === "sent"
          ? "Sudah dilempar, menunggu konfirmasi WhatsApp"
          : it.attempts > 0
            ? `Antre dikirim ulang - percobaan ke-${it.attempts} gagal`
            : "Progress kirim";

  const jalankan = (fn: () => Promise<{ ok: boolean }>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  return (
    <li
      className="relative -ml-3 mt-4 border-l-2 border-dashed pl-3"
      style={{ borderColor: warna }}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="micro" style={{ color: warna }}>
          {it.agentName ?? "Anda"}
        </span>
        <span className="text-[11.5px]" style={{ color: warna }}>
          {keterangan}
        </span>
      </div>

      <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{it.body}</p>

      {gagal && it.lastError ? (
        <p className="tnum mt-1 text-[11.5px] text-ink-faint">{it.lastError}</p>
      ) : null}

      <div className="mt-1.5 flex gap-2">
        {masihBisaBatal ? (
          <button
            className="btn btn-danger h-6 px-2 text-[12px]"
            disabled={pending}
            onClick={() => jalankan(() => actCancelSend(it.id, ticketId))}
          >
            Batalkan
          </button>
        ) : null}

        {gagal ? (
          <>
            <button
              className="btn h-6 px-2 text-[12px]"
              disabled={pending}
              onClick={() => jalankan(() => actRetrySend(it.id, ticketId))}
            >
              Coba kirim lagi
            </button>
            <button
              className="btn btn-quiet h-6 px-2 text-[12px]"
              disabled={pending}
              onClick={() => jalankan(() => actDiscardSend(it.id, ticketId))}
            >
              Buang
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}
