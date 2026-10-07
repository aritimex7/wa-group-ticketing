/**
 * Peristiwa realtime - dipakai section 9.1 ("Kartu berubah realtime saat ada yang
 * mengambil, tanpa perlu refresh") dan section 6.3 ("Layar agen lama langsung
 * berubah jadi diambil alih oleh {nama} supaya dia berhenti mengetik").
 *
 * Mekanisme: Postgres LISTEN/NOTIFY -> SSE. Tidak ada Redis, tidak ada broker.
 * Satu komponen infrastruktur lebih sedikit yang bisa mati diam-diam.
 *
 * Batas yang perlu diingat: payload NOTIFY maksimum ~8000 byte. Karena itu yang
 * dikirim hanya penanda ("tiket 12 berubah"), bukan isi tiketnya. Klien
 * mengambil sendiri data barunya.
 */
import { getSql } from "@/db";

export const CHANNEL = "dashboard_wa";

export type AppEvent =
  | { t: "ticket.created"; id: number; group: string }
  | { t: "ticket.updated"; id: number; group: string; status?: string }
  | { t: "ticket.claimed"; id: number; group: string; by: number; byName: string }
  | { t: "ticket.takenover"; id: number; group: string; by: number; byName: string; from: number }
  | { t: "ticket.released"; id: number; group: string }
  | { t: "message.new"; group: string; stanzaId: string }
  | { t: "outbox.updated"; id: string; ticketId: number | null; status: string }
  | { t: "gateway"; state: string }
  | { t: "notification"; kind: string };

export async function publish(ev: AppEvent): Promise<void> {
  try {
    const payload = JSON.stringify(ev);
    if (payload.length > 7000) return;
    await getSql().notify(CHANNEL, payload);
  } catch (err) {
    // Realtime itu penyedap, bukan syarat. Kegagalan di sini tidak boleh
    // menggagalkan aksi yang sudah tersimpan di database.
    console.error("[events] gagal publish:", (err as Error).message);
  }
}

/** Kembalikan fungsi untuk berhenti mendengarkan. */
export async function subscribe(onEvent: (ev: AppEvent) => void): Promise<() => Promise<void>> {
  const sql = getSql();
  const handle = await sql.listen(CHANNEL, (raw) => {
    try {
      onEvent(JSON.parse(raw) as AppEvent);
    } catch {
      /* payload rusak - abaikan */
    }
  });
  return async () => {
    try {
      await handle.unlisten();
    } catch {
      /* koneksi sudah tutup */
    }
  };
}
