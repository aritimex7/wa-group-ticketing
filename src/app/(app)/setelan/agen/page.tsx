/**
 * Tab Agen - halaman Setelan.
 *
 * Tanda tangan ikut di sini, bukan jadi tab sendiri: bagian itu menampilkan kode
 * tanda tangan PER AGEN, jadi datanya sama dan tempatnya memang bersama agen.
 *
 * Penjaga peran, judul, dan barisan tab ada di ../layout.tsx.
 */
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getAllSettings } from "@/lib/settings";
import { Sec, Form, Grid, Field, Check } from "../ui";
import * as A from "../actions";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [s, agenList] = await Promise.all([
    getAllSettings(),
    db.select().from(agents).orderBy(agents.name),
  ]);
  const ipList = (s["access.ip_allowlist"] as string[]).join("\n");

  return (
    <>
      <Sec title="Agen & akses" note="Agen dinonaktifkan, tidak pernah dihapus - menghapus akan merusak statistik lama.">
        <div className="space-y-2">
          {agenList.map((a) => (
            <form key={a.id} action={A.ubahAgen} className="rule-b flex flex-wrap items-end gap-2 pb-3">
              <input type="hidden" name="id" value={a.id} />
              <div className="min-w-[140px] flex-1">
                <span className="micro">Nama</span>
                <p className="mt-1 text-[14px]">{a.name}</p>
                <p className="text-[11.5px] text-ink-faint">{a.username}</p>
              </div>
              <label>
                <span className="micro">Kode</span>
                <input name="kode" defaultValue={a.signatureCode} className="field mt-1 w-24" />
              </label>
              <label>
                <span className="micro">Peran</span>
                <select name="role" defaultValue={a.role} className="field mt-1 w-32">
                  <option value="agent">agent</option>
                  <option value="leader">leader</option>
                  <option value="sla">pemantau SLA</option>
                </select>
              </label>
              <label className="flex h-8 items-center gap-2 text-[13px]">
                <input type="checkbox" name="aktif" defaultChecked={a.isActive} />
                Aktif
              </label>
              <button className="btn h-8">Simpan</button>
            </form>
          ))}
        </div>

        <h3 className="micro mt-7">Tambah agen</h3>
        <form action={A.tambahAgen} className="mt-2 flex flex-wrap gap-2">
          <input name="nama" placeholder="Nama lengkap" className="field w-44" required />
          <input name="username" placeholder="username" className="field w-36" required />
          <input name="sandi" type="password" placeholder="kata sandi (min 8)" className="field w-44" required />
          <input name="kode" placeholder="kode #dsp" className="field w-28" required />
          <select name="role" className="field w-32">
            <option value="agent">agent</option>
            <option value="leader">leader</option>
            <option value="sla">pemantau SLA</option>
          </select>
          <button className="btn btn-primary">Tambah</button>
        </form>

        <h3 className="micro mt-7">Reset kata sandi</h3>
        <form action={A.resetSandi} className="mt-2 flex flex-wrap gap-2">
          <select name="id" className="field w-44">
            {agenList.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <input name="sandi" type="password" placeholder="kata sandi baru" className="field w-44" />
          <button className="btn">Reset</button>
        </form>

        <h3 className="micro mt-7">IP kantor</h3>
        <p className="mt-1 max-w-[62ch] text-[12.5px] text-ink-muted">
          Satu per baris. Boleh IP tunggal atau CIDR (contoh <span className="tnum">203.0.113.0/24</span>).
          Kosongkan untuk tidak membatasi. Ini lapisan kedua - pembatasan yang sebenarnya sebaiknya
          dipasang di reverse proxy atau firewall VPS.
        </p>
        <form action={A.simpanIpAllowlist} className="mt-2">
          <textarea name="daftar" defaultValue={ipList} rows={4} className="field font-mono text-[13px]" />
          <button className="btn mt-2">Simpan</button>
        </form>
      </Sec>

      <Sec title="Tanda tangan">
        <Form action={A.simpanTandaTangan}>
          <Grid>
            <Field label="Pola" hint="kode agen ditambahkan setelah spasi">
              <input name="prefix" defaultValue={s["signature.prefix"] as string} className="field" />
            </Field>
          </Grid>
          <Check name="auto" defaultChecked={s["signature.auto_insert"] as boolean}>
            Sisip otomatis saat kirim dari dashboard
          </Check>
          <Check name="lenient" defaultChecked={s["signature.lenient_match"] as boolean}>
            Pencocokan longgar (huruf besar-kecil bebas, spasi bebas)
          </Check>
        </Form>

        <h3 className="micro mt-7">Kode per agen</h3>
        <p className="mt-1 text-[12.5px] text-ink-muted">
          Kode wajib unik. Kode kembar ditolak - dua orang dengan kode sama berarti statistik
          keduanya tidak bisa dipercaya.
        </p>
        <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
          {agenList.map((a) => (
            <li key={a.id} className="text-[13px]">
              <span className="tnum text-ink">#dsp {a.signatureCode}</span>
              <span className="ml-2 text-ink-muted">{a.name}</span>
              {!a.isActive ? <span className="ml-1.5 text-[11.5px] text-ink-faint">nonaktif</span> : null}
            </li>
          ))}
        </ul>
      </Sec>
    </>
  );
}
