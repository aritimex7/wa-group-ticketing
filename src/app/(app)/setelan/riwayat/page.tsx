/**
 * Tab Riwayat - halaman Setelan.
 *
 * Penjaga peran, judul, dan barisan tab ada di ../layout.tsx.
 */
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { settingsAudit } from "@/db/schema";
import { smartStamp } from "@/lib/time";
import { Sec } from "../ui";

export const dynamic = "force-dynamic";

export default async function Page() {
  const audit = await db.select().from(settingsAudit).orderBy(desc(settingsAudit.changedAt)).limit(10);

  return (
    <>
      <Sec title="Riwayat perubahan setting">
        <ol className="space-y-1">
          {audit.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 text-[12.5px]">
              <time className="tnum shrink-0 text-ink-faint">{smartStamp(a.changedAt)}</time>
              <span className="text-ink" title={a.key}>{LABEL_SETTING[a.key] ?? a.key}</span>
              <span className="text-ink-faint">{nilaiRingkas(a.fromValue)}</span>
              <span className="text-ink-faint">&rarr;</span>
              <span className="text-ink">{nilaiRingkas(a.toValue)}</span>
            </li>
          ))}
          {audit.length === 0 ? <li className="text-[13px] text-ink-muted">Belum ada perubahan.</li> : null}
        </ol>
      </Sec>
    </>
  );
}


/**
 * Nama yang tampil di riwayat, bukan kunci mentah - "ingest.dm_enabled" tidak
 * berarti apa-apa buat siapa pun yang tidak menulis kodenya. Kalau ada kunci
 * baru yang belum masuk daftar ini, kuncinya sendiri dipakai apa adanya
 * (lihat pemanggilnya) - lebih baik agak kaku daripada halaman ini error.
 */
const LABEL_SETTING: Record<string, string> = {
  "sla.first_response_min": "Target balasan pertama (menit)",
  "sla.resolution_min": "Target tuntas (menit)",
  "sla.warn_threshold_pct": "Ambang peringatan SLA (persen)",
  "trigger.mention_creates_ticket": "Mention bikin tiket",
  "trigger.reply_creates_ticket": "Swipe-reply bikin tiket",
  "ingest.dm_enabled": "Simpan chat pribadi (japri)",
  "trigger.dm_creates_ticket": "Pesan japri bikin tiket",
  "ticket.merge_window_min": "Jendela gabung pesan susulan (menit)",
  "ops.auto_release_min": "Auto-lepas tiket diam (menit)",
  "ops.undo_seconds": "Jendela batal kirim (detik)",
  "ops.session_idle_min": "Agen dianggap idle setelah (menit)",
  "ops.on_check_text": "Kalimat balasan penahan (on check)",
  "ops.auto_monitor_new_groups": "Grup baru langsung dipantau",
  "signature.prefix": "Pola tanda tangan",
  "signature.auto_insert": "Sisip tanda tangan otomatis",
  "signature.lenient_match": "Pencocokan tanda tangan longgar",
  "gateway.alert_after_min": "Alarm gateway putus setelah (menit)",
  "gateway.quiet_alert_min": "Alarm gateway sepi setelah (menit)",
  "gateway.busy_hours": "Jam ramai",
  "access.ip_allowlist": "Daftar IP kantor",

  /* Dua kolom ini sudah dihapus dari halaman, tapi labelnya SENGAJA tetap di
     sini. Riwayat setting itu permanen - kalau dulu pernah ada yang menekan
     Simpan, barisnya tetap ada selamanya, dan tanpa label ini ia berubah jadi
     kunci mentah di layar. Label lebih murah daripada riwayat yang tidak
     terbaca. */
  "alerts.leader_wa": "Nomor WhatsApp alarm leader (dihapus)",
  "alerts.email": "Email alarm (dihapus)",
};

/** boolean tampil "aktif"/"mati", bukan "true"/"false" mentah. Sisanya apa adanya. */
function nilaiRingkas(v: unknown): string {
  if (typeof v === "boolean") return v ? "aktif" : "mati";
  if (v === null || v === undefined) return "-";
  if (typeof v === "string") return v || '""';
  return JSON.stringify(v);
}
