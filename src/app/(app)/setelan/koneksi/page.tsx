/**
 * Tab Koneksi - halaman Setelan.
 *
 * Penjaga peran, judul, dan barisan tab ada di ../layout.tsx.
 */
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { gatewayEvents } from "@/db/schema";
import { getAllSettings } from "@/lib/settings";
import { smartStamp } from "@/lib/time";
import { Sec, Form, Grid, Field } from "../ui";
import * as A from "../actions";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [s, koneksi] = await Promise.all([
    getAllSettings(),
    db.select().from(gatewayEvents).orderBy(desc(gatewayEvents.createdAt)).limit(12),
  ]);
  const busy = s["gateway.busy_hours"] as [number, number];

  return (
    <>
      <Sec title="Koneksi">
        <ol className="space-y-1">
          {koneksi.map((e) => (
            <li key={e.id} className="flex items-baseline gap-3 text-[12.5px]">
              <time className="tnum shrink-0 text-ink-faint">{smartStamp(e.createdAt)}</time>
              <span style={{ color: e.state === "connected" ? "var(--st-done)" : "var(--st-breach)" }}>
                {e.state}
              </span>
              <span className="text-ink-faint">{e.instance}</span>
            </li>
          ))}
          {koneksi.length === 0 ? (
            <li className="text-[13px] text-ink-muted">
              Riwayat sambungan masih kosong. Baris pertama muncul dalam beberapa detik
              setelah detak berkala berjalan - kalau tidak muncul juga, periksa
              GATEWAY_URL dan GATEWAY_INSTANCE di berkas .env.
            </li>
          ) : null}
        </ol>

        <Form action={A.simpanAlarm} className="mt-6">
          <Grid>
            <Field label="Alarm kalau terputus lebih dari (menit)">
              <input name="after" type="number" min={1} defaultValue={s["gateway.alert_after_min"] as number} className="field" />
            </Field>
            <Field label="Alarm kalau sepi lebih dari (menit)" hint="section 15: sepi beneran vs sepi karena rusak">
              <input name="quiet" type="number" min={5} defaultValue={s["gateway.quiet_alert_min"] as number} className="field" />
            </Field>
            <Field label="Jam ramai mulai">
              <input name="busyFrom" type="number" min={0} max={23} defaultValue={busy[0]} className="field" />
            </Field>
            <Field label="Jam ramai sampai">
              <input name="busyTo" type="number" min={1} max={24} defaultValue={busy[1]} className="field" />
            </Field>
          </Grid>
          {/* Kolom "Alarm ke WhatsApp leader" dan "Alarm ke email" dihapus, bukan
              disembunyikan. Keduanya menyimpan nilai tapi tidak ada satu pun kode
              yang membacanya - dan setelan yang berbohong lebih berbahaya daripada
              setelan yang belum ada: leader mengira sudah dijaga, lalu tidak ada
              yang memberi tahu saat gateway mati tengah malam. Kalau nanti alarm
              keluar benar-benar dibuat, kolomnya ditambahkan bersama kodenya. */}
          <p className="mt-3 max-w-[62ch] text-[12.5px] text-ink-muted">
            Alarm muncul sebagai notifikasi di dashboard - di pita merah halaman ini
            dan di daftar notifikasi. Belum ada alarm yang keluar lewat WhatsApp atau
            email.
          </p>
        </Form>
      </Sec>
    </>
  );
}
