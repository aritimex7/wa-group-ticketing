/**
 * Tab Operasional - halaman Setelan.
 *
 * Penjaga peran, judul, dan barisan tab ada di ../layout.tsx.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { quickReplies } from "@/db/schema";
import { getAllSettings } from "@/lib/settings";
import { Sec, Form, Grid, Field, Check } from "../ui";
import * as A from "../actions";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [s, templateList] = await Promise.all([
    getAllSettings(),
    db.select().from(quickReplies).where(eq(quickReplies.isActive, true)).orderBy(quickReplies.sortOrder),
  ]);

  return (
    <>
      <Sec title="SLA" note="Target disalin ke tiket saat dibuat, jadi mengubah angka di sini tidak mengubah laporan lama.">
        <Form action={A.simpanSla}>
          <Grid>
            <Field label="Target balasan pertama (menit)">
              <input name="fr" type="number" min={1} defaultValue={s["sla.first_response_min"] as number} className="field" />
            </Field>
            <Field label="Target tuntas (menit)">
              <input name="res" type="number" min={1} defaultValue={s["sla.resolution_min"] as number} className="field" />
            </Field>
            <Field label="Ambang peringatan (%)">
              <input name="warn" type="number" min={1} max={100} defaultValue={s["sla.warn_threshold_pct"] as number} className="field" />
            </Field>
          </Grid>
        </Form>
      </Sec>

      <Sec title="Operasional">
        <Form action={A.simpanOperasional}>
          <Grid>
            <Field label="Auto-release claim (menit)" hint="mencegah tiket nyangkut saat pergantian shift">
              <input name="release" type="number" min={1} defaultValue={s["ops.auto_release_min"] as number} className="field" />
            </Field>
            <Field label="Durasi undo (detik)" hint="pesan ditahan di server selama ini">
              <input name="undo" type="number" min={0} max={60} defaultValue={s["ops.undo_seconds"] as number} className="field" />
            </Field>
            <Field label="Sesi dianggap tidak aktif setelah (menit)">
              <input name="idle" type="number" min={1} defaultValue={s["ops.session_idle_min"] as number} className="field" />
            </Field>
            <Field
              label="Kalimat On check"
              hint="dipakai kalau agen menekan On check tanpa mengetik apa pun"
            >
              <input name="oncheck" defaultValue={s["ops.on_check_text"] as string} className="field" />
            </Field>
          </Grid>
          <Check
            name="autopantau"
            defaultChecked={s["ops.auto_monitor_new_groups"] as boolean}
          >
            Grup baru langsung dipantau begitu ada pesan pertama
          </Check>
          <p className="mt-1 max-w-[62ch] text-[11.5px] text-ink-faint">
            Menyimpang dari perilaku bawaan (grup baru nonaktif sampai ditinjau). Kalau
            dinyalakan, isi SEMUA grup ikut tersimpan - termasuk grup pribadi yang memakai
            nomor yang sama. Grup yang muncul dari tombol &ldquo;Tarik nama grup&rdquo; tetap
            nonaktif; hanya grup yang benar-benar menerima pesan yang ikut menyala.
          </p>
        </Form>

        <h3 className="micro mt-7">Balasan cepat</h3>
        <ul className="mt-2 space-y-1">
          {templateList.map((q) => (
            <li key={q.id} className="flex items-baseline gap-3 text-[13px]">
              <span className="w-32 shrink-0 truncate">{q.title}</span>
              <span className="truncate text-ink-muted">{q.body}</span>
              <form action={A.hapusTemplate} className="ml-auto">
                <input type="hidden" name="id" value={q.id} />
                <button className="btn btn-quiet h-6 px-2 text-[12px]">Hapus</button>
              </form>
            </li>
          ))}
        </ul>
        <form action={A.tambahTemplate} className="mt-2 flex flex-wrap gap-2">
          <input name="judul" placeholder="Judul" className="field w-36" />
          <input name="isi" placeholder="Isi balasan" className="field w-80" />
          <button className="btn">Tambah</button>
        </form>
      </Sec>
    </>
  );
}
