import Link from "next/link";
import { redirect } from "next/navigation";
import { AccessDenied, requireLeader } from "@/lib/auth";
import { TanpaAkses } from "@/components/TanpaAkses";
import { gatewayHealth } from "@/lib/queries";
import {
  activeAgents,
  bucketItems,
  dataHealth,
  notForUsByAgent,
  notForUsList,
  perAgent,
  queueSummary,
  sinceOf,
  type Rentang,
} from "@/lib/leader";
import { WIB, durationLabel, durationWords, smartStamp } from "@/lib/time";
import { belumDibaca as ambilNotif, grupBaru } from "@/lib/notifications";
import { getSetting } from "@/lib/settings";
import { aksiTandaiDibaca, aksiTandaiSemuaDibaca } from "./actions";

export const dynamic = "force-dynamic";

const RENTANG: { key: Rentang; label: string }[] = [
  { key: "hari", label: "Hari ini" },
  { key: "minggu", label: "7 hari" },
  { key: "bulan", label: "30 hari" },
];

export default async function LeaderPage({
  searchParams,
}: {
  searchParams: Promise<{ rentang?: string }>;
}) {
  try {
    await requireLeader();
  } catch (err) {
    if (err instanceof AccessDenied && err.kind === "role") {
      return <TanpaAkses />;
    }
    redirect("/masuk");
  }

  const sp = await searchParams;
  const rentang = (RENTANG.find((r) => r.key === sp.rentang)?.key ?? "hari") as Rentang;
  const since = sinceOf(rentang);

  /* Ambang "sesi tidak aktif" DIBACA dari setelan. Sebelumnya kolomnya bisa
     diubah leader di Setelan tapi tidak pernah dipakai kode mana pun -
     activeAgents() selalu memakai bawaan 15 menit. Setelan yang tidak
     mengubah apa pun lebih buruk daripada setelan yang tidak ada: ia membuat
     orang mengira sudah mengatur sesuatu. */
  const idleMin = await getSetting("ops.session_idle_min");

  const [health, queue, active, agenStats, hlt, nfuAgents, nfuList, review, notif, grupTinjau] =
    await Promise.all([
      gatewayHealth(),
      queueSummary(),
      activeAgents(idleMin),
      perAgent(since),
      dataHealth(since),
      notForUsByAgent(since),
      notForUsList(since, 20),
      bucketItems("needs_review", 15),
      ambilNotif(),
      grupBaru(),
    ]);

  /* Belum ditinjau leader, tapi is_monitored membelahnya jadi dua perkara yang
     sama sekali berbeda beratnya. Pemisahan ini WAJIB dilakukan di sini:
     grupBaru() sengaja tidak memfilter supaya tidak ada grup yang hilang dari
     pandangan leader - yang berbeda cuma kalimat yang dipakai. */
  const grupTakDisimpan = grupTinjau.filter((g) => !g.isMonitored);
  const grupOtomatis = grupTinjau.filter((g) => g.isMonitored);

  const med = (s: number | null) => (s === null ? "-" : durationLabel(s * 1000));

  /* Nilai awal form ekspor: awal bulan berjalan sampai hari ini, menurut WIB.
     Bukan UTC - kalau dihitung UTC, sebelum pukul 07.00 WIB tanggalnya mundur
     satu hari dan laporan diam-diam kehilangan hari pertama. */
  const kiniWib = new Intl.DateTimeFormat("en-CA", {
    timeZone: WIB,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const hariIniIso = kiniWib;
  const awalBulanIso = kiniWib.slice(0, 8) + "01";

  return (
    <div className="scroll-y h-full">
      {/* ---------- section 10: indikator gateway, paling atas, paling besar ---------- */}
      <GatewayBanner health={health} />

      <div className="mx-auto max-w-[1180px] px-5 pb-16">
        {/* ---------- section 5: grup baru & alarm ---------- */}
        {notif.length || grupTinjau.length ? (
          <section className="rule-b py-6">
            <div className="flex items-baseline gap-3">
              <h2 className="micro text-ink">Perlu perhatian</h2>
              {notif.length ? (
                <form action={aksiTandaiSemuaDibaca} className="ml-auto">
                  <button className="btn btn-quiet h-6 px-2 text-[12px]">Tandai semua dibaca</button>
                </form>
              ) : null}
            </div>

            {/* DUA keadaan, dan dulu keduanya dicetak dengan kalimat yang sama.
                Bedanya bukan nuansa: yang satu data sedang hilang detik ini,
                yang satu cuma administrasi. Menyebut keduanya "pesannya TIDAK
                sedang disimpan" membuat panel ini mengumumkan kehilangan yang
                tidak terjadi - dan panel yang pernah berbohong sekali akan
                dilewati orang selamanya, termasuk saat alarmnya benar. */}
            {grupTakDisimpan.length ? (
              <div className="mt-3 border-l-2 pl-3" style={{ borderColor: "var(--st-open)" }}>
                <p className="text-[13px]" style={{ color: "var(--st-open)" }}>
                  {grupTakDisimpan.length} grup terdeteksi tapi belum diaktifkan - pesannya TIDAK
                  sedang disimpan.
                </p>
                <ul className="mt-1.5 space-y-1">
                  {grupTakDisimpan.map((g) => (
                    <li key={g.jid} className="text-[12.5px]">
                      <span className="tnum text-ink">{g.name ?? g.jid.replace(/@g\.us$/, "")}</span>
                      <span className="ml-2 text-ink-faint">terdeteksi {smartStamp(g.createdAt)}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/setelan/grup"
                  className="mt-2 inline-block text-[12.5px] text-accent underline-offset-2 hover:underline"
                >
                  Buka Setting untuk memberi nama dan mengaktifkan
                </Link>
              </div>
            ) : null}

            {/* Sudah menyala sendiri, tinggal ditinjau. Tetap ditampilkan dan
                tidak dihapus begitu saja: auto-pantau bisa ikut menyalakan grup
                yang bukan grup klien, dan satu-satunya orang yang bisa tahu itu
                leader. Nadanya tenang - tidak ada yang perlu dikejar. */}
            {grupOtomatis.length ? (
              <div className="mt-3 border-l-2 border-rule pl-3">
                <p className="text-[13px] text-ink-muted">
                  {grupOtomatis.length} grup baru menyala otomatis dan pesannya{" "}
                  <span className="text-ink">sudah disimpan</span>. Tinjau kalau ada yang bukan grup
                  klien.
                </p>
                <ul className="mt-1.5 space-y-1">
                  {grupOtomatis.map((g) => (
                    <li key={g.jid} className="text-[12.5px]">
                      <span className="tnum text-ink">{g.name ?? g.jid.replace(/@g\.us$/, "")}</span>
                      <span className="ml-2 text-ink-faint">terdeteksi {smartStamp(g.createdAt)}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/setelan/grup"
                  className="mt-2 inline-block text-[12.5px] text-accent underline-offset-2 hover:underline"
                >
                  Buka Setting untuk memberi nama atau mematikan
                </Link>
              </div>
            ) : null}

            {notif.length ? (
              <ul className="mt-4 space-y-1.5">
                {notif.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-baseline gap-x-3 text-[12.5px]">
                    <time className="tnum shrink-0 text-ink-faint">{smartStamp(n.createdAt)}</time>
                    <span className="text-ink">{n.title}</span>
                    {n.groupJid ? (
                      <span className="text-ink-faint">{n.groupJid.replace(/@g\.us$/, "")}</span>
                    ) : null}
                    {n.sudahDipantau === true ? (
                      <span style={{ color: "var(--st-done)" }}>sudah diaktifkan</span>
                    ) : null}
                    <form action={aksiTandaiDibaca} className="ml-auto">
                      <input type="hidden" name="id" value={n.id} />
                      <button className="btn btn-quiet h-5 px-1.5 text-[11.5px]">tutup</button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {/* ---------- kondisi sekarang ---------- */}
        <Section title="Kondisi sekarang">
          <div className="flex flex-wrap gap-x-12 gap-y-5">
            <Big label="Belum dibalas" value={String(queue.open)} />
            <Big label="Sedang ditangani" value={String(queue.onProgress)} />
            <Big
              label="Lewat target balas pertama"
              value={String(queue.breached)}
              tone={queue.breached > 0 ? "var(--st-breach)" : undefined}
            />
            <Big
              label="Paling lama menunggu"
              value={queue.oldestWaitingMs === null ? "-" : durationLabel(queue.oldestWaitingMs)}
              href={queue.oldestTicketId ? `/tiket/${queue.oldestTicketId}` : undefined}
              tone={queue.oldestWaitingMs && queue.oldestWaitingMs > 3_600_000 ? "var(--st-breach)" : undefined}
            />
          </div>

          <div className="mt-6">
            <h3 className="micro">Sedang aktif</h3>
            {active.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-muted">Tidak ada agen yang sedang online.</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
                {active.map((a) => (
                  <li key={a.id} className="text-[13px]">
                    <span className="text-ink">{a.name}</span>
                    <span className="tnum ml-2 text-ink-muted">memegang {a.holding}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>

        {/* ---------- rentang ---------- */}
        <div className="rule-b flex flex-wrap items-center gap-4 py-3">
          <span className="micro">Rentang</span>
          {RENTANG.map((r) => (
            <Link
              key={r.key}
              href={`/leader?rentang=${r.key}`}
              className={
                r.key === rentang
                  ? "text-[13px] text-ink underline decoration-accent decoration-2 underline-offset-[6px]"
                  : "text-[13px] text-ink-muted hover:text-ink"
              }
            >
              {r.label}
            </Link>
          ))}
          {/* Export punya rentang tanggalnya SENDIRI, terpisah dari filter di
              atas. Alasannya: filter layar dipakai untuk melirik cepat, ekspor
              dipakai untuk laporan bulanan yang batas tanggalnya ditentukan
              orang lain. Memaksa keduanya sama berarti untuk mengekspor
              1-15 Agustus, seluruh layar harus ikut berubah dulu. */}
          <form method="get" action="/api/ekspor" className="ml-auto flex flex-wrap items-end gap-2">
            <label>
              <span className="micro">Dari</span>
              <input type="date" name="dari" defaultValue={awalBulanIso} className="field mt-1 h-7 w-[138px] text-[12.5px]" />
            </label>
            <label>
              <span className="micro">Sampai</span>
              <input type="date" name="sampai" defaultValue={hariIniIso} className="field mt-1 h-7 w-[138px] text-[12.5px]" />
            </label>
            <button className="btn h-7 text-[12.5px]" type="submit">
              Export CSV
            </button>
          </form>
        </div>

        {/* ---------- per agen ---------- */}
        <Section title="Per agen">
          {/* section 10 rambu: jangan pasang papan peringkat. */}
          <p className="mb-4 max-w-[62ch] text-[12.5px] text-ink-muted">
            Diurutkan menurut nama, bukan menurut angka. Begitu diperingkat, agen akan memilih
            tiket mudah dan menghindari yang rumit.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead>
                <tr className="rule-b">
                  <Th align="left">Agen</Th>
                  <Th>Tiket</Th>
                  <Th>Median balas pertama</Th>
                  <Th>Median tuntas</Th>
                  <Th>Lewat SLA</Th>
                </tr>
              </thead>
              <tbody>
                {agenStats.map((a) => (
                  <tr key={a.id} className="rule-b">
                    <Td align="left">{a.name}</Td>
                    <Td mono>{a.handled}</Td>
                    <Td mono>{med(a.medianFrSec)}</Td>
                    <Td mono>{med(a.medianResSec)}</Td>
                    <Td mono tone={a.breaches > 0 ? "var(--st-breach)" : undefined}>
                      {a.breaches}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ---------- kesehatan data ---------- */}
        <Section title="Kesehatan data">
          <p className="mb-4 max-w-[62ch] text-[12.5px] text-ink-muted">
            Bagian yang menentukan apakah angka di atas boleh dipercaya. Kalau baris mana pun di
            sini besar, perlakukan statistik per agen sebagai perkiraan kasar.
          </p>

          <dl className="grid gap-x-10 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            <Health
              label="Balasan tidak teratribusi"
              value={`${hlt.unattributedOut} dari ${hlt.totalOut}`}
              note="tanpa agent_id dan tanpa #dsp - tidak terhitung ke siapa pun"
              bad={hlt.totalOut > 0 && hlt.unattributedOut / hlt.totalOut > 0.1}
            />
            <Health
              label="Perlu ditinjau"
              value={String(hlt.bucketNeedsReview)}
              note="mirip frasa yang diabaikan, tapi tidak persis"
              bad={hlt.bucketNeedsReview > 0}
            />
            <Health
              label="Diabaikan"
              value={String(hlt.bucketIgnored)}
              note="kena filter frasa atau nomor internal - tidak dibuang, tersimpan di keranjang"
            />
            <Health
              label="Kirim gagal"
              value={String(hlt.sendFailed)}
              note="teks balasan masih tersimpan, tiket kembali ke antrean"
              bad={hlt.sendFailed > 0}
            />
            <Health
              label="Gateway terputus"
              /* Angka yang dibaca sekali, sama seperti di kepala halaman - jadi
                 kata, bukan "00:00". Kolom median di tabel Per agen tetap
                 berformat jam: yang itu dipindai berderet ke bawah, dan lebar
                 yang seragam justru yang membuatnya bisa dibandingkan. */
              value={hlt.gatewayDownSec > 0 ? durationWords(hlt.gatewayDownSec * 1000) : "tidak pernah"}
              note="total dalam rentang ini"
              bad={hlt.gatewayDownSec > 300}
            />
            <Health
              label="Pesan masuk tanpa LID"
              value={String(hlt.parseGapLid)}
              note="pencocokan identitas untuk pesan ini bertumpu pada nomor saja"
              bad={hlt.parseGapLid > 0}
            />
          </dl>

          {review.length ? (
            <div className="mt-6">
              <h3 className="micro">Antre ditinjau</h3>
              <ul className="mt-2 space-y-1.5">
                {review.map((b) => (
                  <li key={b.id} className="text-[12.5px]">
                    <span className="tnum text-ink-faint">{smartStamp(b.at)}</span>
                    <span className="mx-2 text-ink">{b.groupName}</span>
                    <span className="text-ink-muted">{(b.body ?? "").slice(0, 90)}</span>
                    <span className="ml-2 text-st-doubt">{b.rule}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>

        {/* ---------- bukan untuk kami ---------- */}
        <Section title="Tiket dibuang">
          <p className="mb-4 max-w-[62ch] text-[12.5px] text-ink-muted">
            Persentase tinggi pada satu orang <strong className="text-ink">bukan otomatis berarti curang</strong> -
            bisa jadi dia memegang grup paling ramai. Angka ini sinyal untuk ditanya, bukan vonis.
          </p>

          <table className="w-full max-w-[520px] text-[13px]">
            <thead>
              <tr className="rule-b">
                <Th align="left">Agen</Th>
                <Th>Dibuang</Th>
                <Th>Dari total</Th>
                <Th>Persen</Th>
              </tr>
            </thead>
            <tbody>
              {nfuAgents.map((a) => (
                <tr key={a.id} className="rule-b">
                  <Td align="left">{a.name}</Td>
                  <Td mono>{a.discarded}</Td>
                  <Td mono>{a.touched}</Td>
                  <Td mono>{a.touched ? `${Math.round((a.discarded / a.touched) * 100)}%` : "-"}</Td>
                </tr>
              ))}
            </tbody>
          </table>

          {nfuList.length ? (
            <ul className="mt-5 space-y-1.5">
              {nfuList.map((t) => (
                <li key={t.id} className="text-[12.5px]">
                  <Link href={`/tiket/${t.id}`} className="text-accent underline-offset-2 hover:underline">
                    #{t.id}
                  </Link>
                  <span className="mx-2 text-ink">{t.groupName}</span>
                  <span className="text-ink-muted">{(t.body ?? "").slice(0, 80)}</span>
                  {t.byName ? <span className="ml-2 text-ink-faint">oleh {t.byName}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      </div>
    </div>
  );
}

/* --------------------------------- potongan --------------------------------- */

function GatewayBanner({ health }: { health: Awaited<ReturnType<typeof gatewayHealth>> }) {
  const ok = health.state === "connected";
  const color = ok ? "var(--st-done)" : health.state === "qr_required" ? "var(--st-open)" : "var(--st-breach)";
  const label = ok
    ? "Gateway tersambung"
    : health.state === "qr_required"
      ? "Gateway minta scan QR"
      : health.state === "unknown"
        ? "Status gateway belum tercatat"
        : "Gateway terputus";

  return (
    <div className="rule-b px-5 py-5" style={{ background: ok ? "var(--surface)" : "var(--tint-breach)" }}>
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-baseline gap-x-5 gap-y-1">
        <span className="dot mt-2" style={{ background: color, width: 9, height: 9 }} />
        <h1 className="text-[24px] leading-none tracking-[-0.02em]" style={{ color: ok ? "var(--ink)" : color }}>
          {label}
        </h1>
        {health.since ? (
          <span className="text-[13px] text-ink-muted">
            sejak {durationWords(Date.now() - health.since.getTime())} lalu
          </span>
        ) : null}
        {/* Kata, bukan "00:13". Angka berformat jam menang di kolom timer yang
            dipindai berderet dan berdetak tiap detik; di sini angkanya dibaca
            SEKALI lalu dipikirkan, dan "00:13" masih harus diterjemahkan dulu
            di kepala - tiga belas menit, atau tiga belas detik?

            Nol diucapkan sebagai nol, bukan "0 detik": yang ingin diketahui
            leader dari angka itu bukan durasinya, tapi apakah hari ini pernah
            putus sama sekali. */}
        <span className="ml-auto text-[13px] text-ink-muted">
          {health.downtimeTodaySec > 0 ? (
            <>
              Terputus hari ini{" "}
              <span className="text-ink">{durationWords(health.downtimeTodaySec * 1000)}</span>
            </>
          ) : (
            <>Hari ini belum pernah terputus</>
          )}
          {health.lastMessageAt ? (
            <>
              {" "}
              &middot; pesan terakhir masuk{" "}
              <span className="text-ink">
                {durationWords(Date.now() - health.lastMessageAt.getTime())}
              </span>{" "}
              lalu
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function Section({ title, children, first }: { title: string; children: React.ReactNode; first?: boolean }) {
  return (
    <section className={first ? "py-7" : "rule-t py-7"}>
      <h2 className="micro mb-4 text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Big({ label, value, tone, href }: { label: string; value: string; tone?: string; href?: string }) {
  const inner = (
    <>
      <div className="tnum text-[30px] leading-none tracking-[-0.03em]" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      <div className="mt-1.5 text-[12px] text-ink-muted">{label}</div>
    </>
  );
  return href ? (
    <Link href={href} className="block hover:opacity-80">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}

function Health({ label, value, note, bad }: { label: string; value: string; note: string; bad?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] text-ink-muted">{label}</dt>
      <dd className="tnum mt-0.5 text-[19px] leading-none" style={bad ? { color: "var(--st-breach)" } : undefined}>
        {value}
      </dd>
      <p className="mt-1 text-[11.5px] text-ink-faint">{note}</p>
    </div>
  );
}

/**
 * Histogram jam. Batang tipis dengan garis dasar - bukan grafik penuh gradien.
 * Yang dicari leader dari panel ini cuma satu: jam berapa antreannya menumpuk.
 */

function Th({ children, align = "right" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th className={`micro pb-2 ${align === "left" ? "text-left" : "text-right"} font-semibold`}>{children}</th>
  );
}

function Td({
  children,
  align = "right",
  mono,
  tone,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  mono?: boolean;
  tone?: string;
}) {
  return (
    <td
      className={`py-2 ${align === "left" ? "text-left" : "text-right"} ${mono ? "tnum" : ""}`}
      style={tone ? { color: tone } : undefined}
    >
      {children}
    </td>
  );
}
