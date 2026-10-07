"use client";

import { useEffect, useState } from "react";
import { durationLabel, durationWords, tickIntervalMs } from "@/lib/time";

type Props = {
  /** kapan hitungan mulai - untuk tiket, waktu pesan klien masuk. */
  from: Date;
  /** kalau terisi, timer berhenti di titik ini (tiket sudah selesai). */
  until?: Date | null;
  /** target SLA dalam menit - dipakai menggambar garis di bawah angka. */
  targetMin?: number;
  /**
   * Stempel waktu dari SERVER, diambil sekali per render halaman.
   *
   * Tanpa ini, render server memakai jam server dan hidrasi klien memakai jam
   * klien - selisih beberapa milidetik saja sudah cukup membuat lebar garis SLA
   * berbeda, dan React melaporkannya sebagai kegagalan hidrasi. Yang hilang
   * bukan cuma kerapian log: sekali gagal, React membuang lalu menggambar ulang
   * seluruh cabang itu di klien.
   *
   * Dengan angka yang SAMA dipakai dua-duanya, render pertama identik. Jam
   * hidup baru mengambil alih sesudah komponen terpasang.
   */
  now?: number;
  warnPct?: number;
  size?: "lg" | "sm";
  showTrack?: boolean;
};

/**
 * Angka berjalan - SPEC section 9.1: "menunggu 12 menit jauh lebih menggerakkan
 * daripada masuk 14.03".
 *
 * Dua keputusan kecil yang berpengaruh besar di layar yang ditatap 8 jam:
 *
 *  - Detik hanya berdetak selama tiket masih di bawah satu jam. Lewat dari itu
 *    angka diperbarui tiap 30 detik. Angka yang berkedip terus selama tiga jam
 *    berhenti dibaca dan mulai mengganggu.
 *  - Garis SLA 2px di bawah angka menggantikan tulisan persen. Posisi isian
 *    terbaca dalam sekali lirik; "80%" harus dipikir dulu.
 */
export function Elapsed({
  from,
  until = null,
  targetMin,
  warnPct = 80,
  size = "lg",
  showTrack = true,
  now: awal,
}: Props) {
  const frozen = until ? until.getTime() : null;
  const [now, setNow] = useState(() => frozen ?? awal ?? Date.now());

  useEffect(() => {
    if (frozen !== null) {
      setNow(frozen);
      return;
    }
    let id: ReturnType<typeof setTimeout>;
    const loop = () => {
      const t = Date.now();
      setNow(t);
      id = setTimeout(loop, tickIntervalMs(t - from.getTime()));
    };
    loop();
    return () => clearTimeout(id);
  }, [frozen, from]);

  const elapsed = Math.max(0, now - from.getTime());
  const pct = targetMin ? Math.min(100, (elapsed / (targetMin * 60_000)) * 100) : 0;
  const rawPct = targetMin ? (elapsed / (targetMin * 60_000)) * 100 : 0;

  const level = !targetMin ? "idle" : rawPct >= 100 ? "breach" : rawPct >= warnPct ? "warn" : "ok";
  const color =
    level === "breach"
      ? "var(--st-breach)"
      : level === "warn"
        ? "var(--st-open)"
        : frozen !== null
          ? "var(--st-done)"
          : "var(--ink)";

  return (
    <div className="select-none">
      <div
        className={size === "lg" ? "timer" : "tnum text-[13px] leading-none"}
        style={{ color }}
        title={`${durationWords(elapsed)}${targetMin ? ` - target ${targetMin} menit` : ""}`}
        suppressHydrationWarning
      >
        {durationLabel(elapsed)}
      </div>

      {showTrack && targetMin ? (
        <div className="sla-track mt-1.5" style={{ color }} aria-hidden>
          <div className="sla-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}

      <span className="sr-only">
        {frozen !== null ? "selesai dalam" : "menunggu"} {durationWords(elapsed)}
      </span>
    </div>
  );
}
