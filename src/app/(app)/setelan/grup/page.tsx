/**
 * Tab Grup - halaman Setelan.
 *
 * Penjaga peran, judul, dan barisan tab ada di ../layout.tsx.
 */
import { desc, sql } from "drizzle-orm";
import { db } from "@/db";
import { groups } from "@/db/schema";
import { Sec } from "../ui";
import * as A from "../actions";

export const dynamic = "force-dynamic";

export default async function Page() {
  const grupList = await db
    .select()
    .from(groups)
    // Yang belum ditinjau naik ke atas: selama belum diaktifkan, pesannya hilang.
    .orderBy(sql`${groups.acknowledgedAt} IS NULL DESC`, desc(groups.isMonitored), groups.name);

  return (
    <>
      <Sec title="Grup" anchor="grup">
        <form action={A.sinkronNamaGrup} className="mb-4">
          <button className="btn h-7 text-[12.5px]" type="submit">
            Tarik nama grup dari WhatsApp
          </button>
        </form>

        {/* Tabel, bukan enam form bertumpuk.
            Sebelumnya tiap grup adalah blok sendiri dengan labelnya sendiri, jadi
            "NAMA / LABEL KLIEN / SLA BALAS / SLA TUNTAS" tercetak ulang enam kali
            dan kolomnya tidak lurus antar baris. Terukur: 18 grid dalam satu
            bagian. Sekarang satu baris header, lalu baris-baris input yang
            kolomnya sejajar - dan itu makin penting begitu jumlah grup bertambah.

            Nama kolom tetap berakhiran indeks (nama.0, pantau.0, ...) supaya satu
            FormData membawa banyak baris; `jid.i` selalu terkirim, jadi aksinya
            bisa menelusuri baris dan membedakan checkbox tak dicentang - yang
            tidak terkirim sama sekali - dari yang dicentang. */}
        <form action={A.simpanSemuaGrup}>
          {grupList.length === 0 ? (
            <p className="text-[13px] text-ink-muted">
              Belum ada grup terdeteksi. Grup muncul di sini otomatis begitu ada pesan masuk.
            </p>
          ) : (
            <>
              {/* Lima kolom tidak akan pernah muat di layar sempit. Digulir
                  mendatar, bukan dilipat jadi kartu: kolom yang sejajar itu
                  justru alasan tabel ini ada. */}
              <div className="overflow-x-auto">
                <div className="min-w-[660px]">
                  {/* KOLOM: penanda | nama | label | sla balas | sla tuntas | pantau.
                      Template dipakai bersama header dan tiap baris - satu tempat
                      saja, jadi keduanya tidak bisa melenceng sendiri-sendiri. */}
                  <div className="rule-b grid grid-cols-[10px_minmax(0,1fr)_9rem_5rem_5rem_4.5rem] items-center gap-x-3 pb-1.5">
                    <span />
                    <span className="micro">Nama</span>
                    <span className="micro">Label klien</span>
                    <span className="micro">SLA balas</span>
                    <span className="micro">SLA tuntas</span>
                    <span className="micro">Pantau</span>
                  </div>

                  {grupList.map((g, i) => (
                    <div
                      key={g.jid}
                      className="grid grid-cols-[10px_minmax(0,1fr)_9rem_5rem_5rem_4.5rem] items-center gap-x-3 border-b border-rule/60 py-1.5"
                    >
                      <input type="hidden" name={`jid.${i}`} value={g.jid} />

                      {/* Titik, bukan teks "BARU, BELUM DITINJAU" - teks sepanjang
                          itu di setiap baris akan merusak kelurusan kolom, yang
                          justru inti tabel ini. Keterangannya pindah ke title dan
                          teks pembaca layar, sama seperti penanda di nav. */}
                      {g.acknowledgedAt === null ? (
                        <span
                          className="size-[6px] rounded-full"
                          style={{ backgroundColor: "var(--st-open)" }}
                          title="Baru, belum ditinjau"
                        >
                          <span className="sr-only">baru, belum ditinjau</span>
                        </span>
                      ) : (
                        <span />
                      )}

                      <input
                        name={`nama.${i}`}
                        defaultValue={g.name ?? ""}
                        className="field"
                        placeholder={g.jid}
                        aria-label={`Nama grup ${g.jid}`}
                      />
                      <input
                        name={`label.${i}`}
                        defaultValue={g.clientLabel ?? ""}
                        className="field"
                        aria-label={`Label klien ${g.jid}`}
                      />
                      <input
                        name={`fr.${i}`}
                        type="number"
                        min={1}
                        defaultValue={g.slaFirstResponseMin ?? ""}
                        placeholder="global"
                        className="field"
                        aria-label={`SLA balas ${g.jid}`}
                      />
                      <input
                        name={`res.${i}`}
                        type="number"
                        min={1}
                        defaultValue={g.slaResolutionMin ?? ""}
                        placeholder="global"
                        className="field"
                        aria-label={`SLA tuntas ${g.jid}`}
                      />
                      <input
                        type="checkbox"
                        name={`pantau.${i}`}
                        defaultChecked={g.isMonitored}
                        aria-label={`Pantau ${g.jid}`}
                        className="justify-self-start"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4">
                <button className="btn h-8" type="submit">
                  Simpan
                </button>
              </div>
            </>
          )}
        </form>
      </Sec>
    </>
  );
}
