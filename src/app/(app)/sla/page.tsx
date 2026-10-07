import { redirect } from "next/navigation";
import { AccessDenied, requireSlaView } from "@/lib/auth";
import { TanpaAkses } from "@/components/TanpaAkses";
import { gatewayHealth } from "@/lib/queries";
import { sinceOf } from "@/lib/leader";
import { antreanSekarang, persen, ringkasanSla, slaPerGrup, slaPerJam } from "@/lib/sla";
import { durationLabel, durationWords } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * Dashboard SLA - untuk peran "sla" dan leader.
 *
 * Isinya sengaja hanya angka TIM. Tidak ada satu pun nama agen, dan itu bukan
 * kelalaian: section 1 menaruh statistik di tangan team leader, dan yang dijaga
 * kalimat itu adalah perbandingan antar orang. Pemantau layanan tidak perlu
 * tahu siapa yang lambat - ia perlu tahu KLIEN mana yang layanannya memburuk
 * dan JAM berapa antrean menumpuk.
 */
export default async function SlaPage({
  searchParams,
}: {
  searchParams: Promise<{ tolak?: string }>;
}) {
  try {
    await requireSlaView();
  } catch (err) {
    if (err instanceof AccessDenied && err.kind === "role") {
      return <TanpaAkses />;
    }
    redirect("/masuk");
  }

  const sp = await searchParams;
  /* Halaman ini selalu HARI INI. Pemilih rentang dihapus atas permintaan
     pemilik: pemantau melihat layar ini untuk tahu keadaan hari berjalan, dan
     rekap lintas hari sudah tersedia lewat Export CSV di halaman leader. */
  const since = sinceOf("hari");

  const [r, grup, jam, antrean, health] = await Promise.all([
    ringkasanSla(since),
    slaPerGrup(since),
    slaPerJam(since),
    antreanSekarang(since),
    gatewayHealth(),
  ]);

  const med = (s: number | null) => (s === null ? "-" : durationLabel(s * 1000));
  const gwOk = health.state === "connected";

  return (
    <div className="scroll-y h-full">
      {/* section 10/section 15: kalau gateway putus, SEMUA angka di bawah ini menyesatkan -
          antrean terlihat sepi padahal pesan tidak masuk. Jadi peringatannya di
          paling atas, bukan di catatan kaki. */}
      {!gwOk ? (
        <div className="rule-b bg-tint-breach px-5 py-3">
          <p className="mx-auto max-w-[1100px] text-[13px] text-st-breach">
            Gateway sedang tidak tersambung. Angka di halaman ini tidak bisa dipercaya sampai
            sambungannya pulih - pesan yang masuk selama putus tidak tercatat sama sekali.
          </p>
        </div>
      ) : null}

      <div className="mx-auto max-w-[1100px] px-5 pb-16">
        {/* Muncul kalau pemantau mencoba membuka halaman kerja. Menjelaskan
            alasannya, bukan sekadar memantulkan tanpa kata. */}
        {sp.tolak ? (
          <p className="rule-b py-3 text-[13px]" style={{ color: "var(--st-open)" }}>
            Halaman itu untuk agen yang menangani tiket. Peran Anda memantau angka tim, tidak
            membalas pesan - jadi Anda dibawa ke sini.
          </p>
        ) : null}

        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-2 py-7">
          <h1 className="text-[22px]">Pantau SLA</h1>
          <span className="text-[12.5px] text-ink-muted">hari ini</span>
        </header>

        {/* ------------------------- sekarang ------------------------- */}
        {/* Blok ini SELALU keadaan sekarang dan sengaja MENGABAIKAN pilihan
            rentang - "berapa yang menunggu saat ini" tidak punya versi 30 hari.
            Karena angka di bawahnya justru ikut rentang, bedanya harus tertulis;
            empat angka bersebelahan yang diam-diam menuruti aturan berbeda
            adalah cara termudah membuat orang salah baca. */}
        <Bagian judul="Sedang menunggu" catatan="keadaan saat ini, tidak mengikuti pilihan rentang">
          <div className="flex flex-wrap gap-x-12 gap-y-5">
            <Angka label="Open" nilai={String(antrean.open)} />
            <Angka label="Progress" nilai={String(antrean.progress)} />
            <Angka
              label="Over SLA"
              nilai={String(antrean.lewat)}
              tone={antrean.lewat > 0 ? "var(--st-breach)" : undefined}
            />
          </div>
        </Bagian>

        {/* ------------------------- ringkasan ------------------------- */}
        <Bagian judul="Ringkasan" catatan="sejak pukul 00.00 hari ini">
          <Donat
            total={r.tiket}
            bagian={[
              { label: "Open", nilai: r.open, warna: "var(--st-open)" },
              { label: "Progress", nilai: r.progress, warna: "var(--st-progress)" },
              { label: "Closed", nilai: r.closed, warna: "var(--st-done)" },
            ]}
          />

          <div className="mt-7">
            <Angka
              label="Rata-rata respon"
              nilai={antrean.responSec === null ? "-" : durationWords(antrean.responSec * 1000)}
              ukuran="sedang"
            />
          </div>

          <div className="mt-7 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
            <Rasio
              label="Terjawab"
              bagian={r.terjawab}
              total={r.tiket}
              catatan="tiket yang sudah dapat balasan pertama"
              baik
            />
            <Rasio
              label="Belum terjawab"
              bagian={r.belumTerjawab}
              total={r.tiket}
              catatan="belum ada balasan sama sekali"
              buruk={r.belumTerjawab > 0}
            />
            <Rasio
              label="Lewat target balas"
              bagian={r.lewatBalas}
              total={r.tiket}
              catatan="balasan pertama melebihi target"
              buruk={r.lewatBalas > 0}
            />
            <Rasio
              label="Lewat target tuntas"
              bagian={r.lewatTuntas}
              total={r.tiket}
              catatan="penyelesaian melebihi target"
              buruk={r.lewatTuntas > 0}
            />
          </div>

        </Bagian>

        {/* ------------------------- per jam ------------------------- */}
        <Bagian judul="Tiket hourly">
          <JamBar data={jam} />
        </Bagian>

        {/* ------------------------- per grup ------------------------- */}
        <Bagian judul="Per grup">
          {grup.length === 0 ? (
            <p className="text-[13px] text-ink-muted">Belum ada tiket pada periode ini.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-[13px]">
                <thead>
                  <tr className="rule-b">
                    <Th kiri>Grup</Th>
                    <Th>Tiket</Th>
                    <Th>Open</Th>
                    <Th>Lewat target</Th>
                    <Th>% lewat target</Th>
                    <Th>Median balas</Th>
                  </tr>
                </thead>
                <tbody>
                  {grup.map((g) => {
                    const pct = persen(g.lewatBalas, g.tiket);
                    return (
                      <tr key={g.jid} className="rule-b">
                        <Td kiri>
                          {g.nama}
                          {g.label ? (
                            <span className="micro ml-2 text-ink-faint">{g.label}</span>
                          ) : null}
                        </Td>
                        <Td mono>{g.tiket}</Td>
                        <Td mono tone={g.masihOpen > 0 ? "var(--st-open)" : undefined}>
                          {g.masihOpen}
                        </Td>
                        <Td mono>{g.lewatBalas}</Td>
                        <Td mono tone={pct >= 20 ? "var(--st-breach)" : undefined}>
                          {pct}%
                        </Td>
                        <Td mono>{med(g.medianBalasSec)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Bagian>
      </div>
    </div>
  );
}

/* --------------------------------- potongan --------------------------------- */

function Bagian({
  judul,
  children,
  catatan,
}: {
  judul: string;
  children: React.ReactNode;
  catatan?: string;
}) {
  return (
    <section className="rule-t py-7">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3">
        <h2 className="micro text-ink">{judul}</h2>
        {catatan ? <span className="text-[11.5px] text-ink-faint">{catatan}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Angka({
  label,
  nilai,
  tone,
  catatan,
  /** "sedang" untuk nilai berupa kata ("1 jam 20 menit") - 30px terlalu lebar. */
  ukuran = "besar",
}: {
  label: string;
  nilai: string;
  tone?: string;
  catatan?: string;
  ukuran?: "besar" | "sedang";
}) {
  return (
    <div className="max-w-[22ch]">
      <div
        className={`tnum leading-none tracking-[-0.03em] ${
          ukuran === "besar" ? "text-[30px]" : "text-[21px]"
        }`}
        style={tone ? { color: tone } : undefined}
      >
        {nilai}
      </div>
      <div className="mt-1.5 text-[12px] text-ink-muted">{label}</div>
      {catatan ? <div className="mt-0.5 text-[11.5px] text-ink-faint">{catatan}</div> : null}
    </div>
  );
}

/**
 * Persentase SELALU ditemani angka mentahnya.
 * "15%" dari 4 tiket dan "15%" dari 400 tiket adalah dua kenyataan yang sangat
 * berbeda, dan persentase sendirian menyembunyikan bedanya.
 */
function Rasio({
  label,
  bagian,
  total,
  catatan,
  baik,
  buruk,
}: {
  label: string;
  bagian: number;
  total: number;
  catatan: string;
  baik?: boolean;
  buruk?: boolean;
}) {
  const pct = persen(bagian, total);
  const warna = buruk ? "var(--st-breach)" : baik ? "var(--st-done)" : undefined;

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="tnum text-[24px] leading-none" style={warna ? { color: warna } : undefined}>
          {pct}%
        </span>
        <span className="tnum text-[12.5px] text-ink-muted">
          {bagian.toLocaleString("id-ID")} dari {total.toLocaleString("id-ID")}
        </span>
      </div>
      <div className="mt-1.5 text-[12px] text-ink">{label}</div>
      <div className="mt-0.5 text-[11.5px] text-ink-faint">{catatan}</div>
    </div>
  );
}

/**
 * Cincin rincian tiket.
 *
 * SVG tulisan tangan, tanpa pustaka grafik - untuk tiga potong data, satu
 * lingkaran tidak sebanding dengan ongkos satu dependensi lagi.
 *
 * Tetap di dalam sistem visual: warna status yang sama dengan seluruh aplikasi,
 * tanpa gradien, tanpa bayangan. Angka totalnya di tengah karena itu yang
 * paling sering dicari, dan keterangan di samping SELALU memuat angka mentah -
 * cincin sendirian tidak pernah cukup untuk dibaca tepat, dan warna tidak
 * boleh jadi satu-satunya pembeda.
 */
function Donat({
  total,
  bagian,
}: {
  total: number;
  bagian: { label: string; nilai: number; warna: string }[];
}) {
  const R = 42;
  const KELILING = 2 * Math.PI * R;
  // Celah kecil antar potong supaya batasnya terbaca tanpa perlu garis pemisah.
  const CELAH = total > 0 && bagian.filter((b) => b.nilai > 0).length > 1 ? 2 : 0;

  let jalan = 0;
  const potong = bagian.map((b) => {
    const panjang = total > 0 ? (b.nilai / total) * KELILING : 0;
    const mulai = jalan;
    jalan += panjang;
    return { ...b, panjang: Math.max(0, panjang - CELAH), mulai };
  });

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-5">
      <div className="relative h-[132px] w-[132px] shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r={R} fill="none" stroke="var(--rule)" strokeWidth="9" />
          {potong.map((p) =>
            p.panjang > 0 ? (
              <circle
                key={p.label}
                cx="50"
                cy="50"
                r={R}
                fill="none"
                stroke={p.warna}
                strokeWidth="9"
                strokeDasharray={`${p.panjang} ${KELILING - p.panjang}`}
                strokeDashoffset={-p.mulai}
              />
            ) : null,
          )}
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="tnum text-[26px] leading-none tracking-[-0.03em]">
            {total.toLocaleString("id-ID")}
          </span>
          <span className="micro mt-1">tiket</span>
        </div>
      </div>

      <dl className="space-y-2.5">
        {bagian.map((b) => (
          <div key={b.label} className="flex items-baseline gap-2.5">
            <span className="dot" style={{ background: b.warna }} />
            <dt className="w-[74px] text-[13px] text-ink">{b.label}</dt>
            <dd className="tnum text-[15px]">{b.nilai}</dd>
            <dd className="tnum text-[11.5px] text-ink-faint">{persen(b.nilai, total)}%</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Volume tiket per jam.
 *
 * Sengaja satu warna dan satu makna: JUMLAH TIKET. Versi sebelumnya menumpuk
 * bagian merah untuk yang lewat target, dan itu menuntut paragraf penjelasan
 * di bawahnya - tanda bahwa grafiknya belum bisa berdiri sendiri. Grafik yang
 * perlu dijelaskan biasanya sedang mengerjakan dua tugas sekaligus.
 *
 * Angka muncul saat disorot, jadi tidak perlu label permanen yang memenuhi
 * layar untuk 24 batang.
 */
function JamBar({ data }: { data: { jam: number; tiket: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.tiket));
  return (
    <div>
      <div className="flex h-[84px] items-end gap-[3px]">
        {data.map((d) => (
          <div key={d.jam} className="group relative flex h-full flex-1 flex-col justify-end">
            {/* Label sorot. pointer-events-none supaya tidak menghalangi batang
                di sebelahnya saat kursor bergeser. */}
            <div className="pointer-events-none absolute -top-1 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-[3px] border border-rule bg-surface px-1.5 py-0.5 text-[11px] opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
              <span className="tnum">{String(d.jam).padStart(2, "0")}.00</span>
              <span className="mx-1 text-ink-faint">&middot;</span>
              <span className="tnum">{d.tiket}</span>
              <span className="ml-1 text-ink-faint">tiket</span>
            </div>

            <div
              className="w-full transition-opacity group-hover:opacity-70"
              style={{
                height: `${Math.max(d.tiket > 0 ? 2 : 1, (d.tiket / max) * 84)}px`,
                background: d.tiket > 0 ? "var(--accent)" : "var(--rule)",
              }}
            />
            <span className="sr-only">
              Pukul {d.jam}.00 - {d.tiket} tiket
            </span>
          </div>
        ))}
      </div>
      <div className="rule-t mt-1 flex gap-[3px]">
        {data.map((d) => (
          <div key={d.jam} className="flex-1 pt-1 text-center">
            {d.jam % 3 === 0 ? <span className="tnum text-[10px] text-ink-faint">{d.jam}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function Th({ children, kiri }: { children: React.ReactNode; kiri?: boolean }) {
  return <th className={`micro pb-2 font-semibold ${kiri ? "text-left" : "text-right"}`}>{children}</th>;
}

function Td({
  children,
  kiri,
  mono,
  tone,
}: {
  children: React.ReactNode;
  kiri?: boolean;
  mono?: boolean;
  tone?: string;
}) {
  return (
    <td
      className={`py-2 ${kiri ? "text-left" : "text-right"} ${mono ? "tnum" : ""}`}
      style={tone ? { color: tone } : undefined}
    >
      {children}
    </td>
  );
}
