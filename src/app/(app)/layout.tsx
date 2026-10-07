import Link from "next/link";
import { redirect } from "next/navigation";
import { AccessDenied, requireUser } from "@/lib/auth";
import { gatewayHealth } from "@/lib/queries";
import { jumlahBelumDibaca } from "@/lib/notifications";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Realtime } from "@/components/Realtime";
import { durationWords } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AccessDenied && err.kind === "ip") {
      return <Blocked title="Akses ditolak" body="Dashboard ini hanya bisa dibuka dari jaringan kantor." />;
    }
    redirect("/masuk");
  }

  const health = await gatewayHealth();
  // section 5: notifikasi grup baru ditujukan ke leader. Agen tidak perlu melihatnya.
  const belumDibaca = user.role === "leader" ? await jumlahBelumDibaca() : 0;
  // Peran "sla" hanya memantau - menu kerja tidak ditampilkan sama sekali.
  const pemantau = user.role === "sla";

  return (
    <div className="flex h-dvh flex-col">
      <header className="rule-b sticky top-0 z-30 flex h-13 shrink-0 items-center gap-6 bg-paper/95 px-4 backdrop-blur-[2px]">
        {/* Wordmark: huruf kecil berspasi renggang. Tidak ada logo, tidak ada
            ikon - ini alat kerja internal, bukan produk yang perlu berteriak. */}
        <Link
          href={pemantau ? "/sla" : "/"}
          className="micro shrink-0 text-ink"
          style={{ letterSpacing: "0.16em" }}
        >
          DISPATCH&nbsp;WHATSAPP
        </Link>

        <nav className="flex items-center gap-5 text-[13px]">
          {!pemantau ? <NavLink href="/">Chat</NavLink> : null}
          {!pemantau ? <NavLink href="/cari">Cari</NavLink> : null}
          {pemantau || user.role === "leader" ? <NavLink href="/sla">Pantau SLA</NavLink> : null}
          {user.role === "leader" ? (
            <Link
              href="/leader"
              title={belumDibaca > 0 ? `${belumDibaca} grup baru menunggu ditinjau` : undefined}
              className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink-muted underline-offset-[6px] transition-colors hover:text-ink hover:underline hover:decoration-accent hover:decoration-2"
            >
              Leader
              {/* Dulu di sini tertulis angkanya ("2 baru"), dengan alasan leader
                  perlu tahu SEBERAPA banyak yang menunggu. Alasan itu masih benar,
                  tapi teksnya membungkus ke baris kedua di lebar nav yang sempit
                  dan membuat seluruh barisan terlihat rusak.

                  Angkanya tidak dibuang, dipindah ke title dan ke teks pembaca
                  layar. Yang hilang cuma "terbaca sekali pandang" - dan itu tukar
                  yang sepadan, karena titiknya tetap menjawab pertanyaan pertama
                  ("ada yang perlu saya lihat?"), sementara jumlah persisnya toh
                  selalu terlihat begitu halamannya dibuka. */}
              {belumDibaca > 0 ? (
                <>
                  <span
                    aria-hidden
                    className="size-[6px] shrink-0 rounded-full"
                    style={{ backgroundColor: "var(--st-open)" }}
                  />
                  <span className="sr-only">{belumDibaca} baru</span>
                </>
              ) : null}
            </Link>
          ) : null}
          {user.role === "leader" ? <NavLink href="/setelan">Setting</NavLink> : null}
        </nav>

        <div className="ml-auto flex items-center gap-4">
          <GatewayPill state={health.state} since={health.since} />
          <span className="text-[13px] text-ink-muted">
            {user.name}
            {pemantau ? (
              <span className="micro ml-2 text-ink-faint">pemantau</span>
            ) : (
              <span className="tnum ml-2 text-ink-faint">#dsp {user.signatureCode}</span>
            )}
          </span>
          <ThemeToggle />
          <form action="/api/keluar" method="post">
            <button className="btn btn-quiet h-7 px-2 micro" type="submit">
              Keluar
            </button>
          </form>
        </div>
      </header>

      <Realtime />

      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="text-ink-muted underline-offset-[6px] transition-colors hover:text-ink hover:underline hover:decoration-accent hover:decoration-2"
    >
      {children}
    </Link>
  );
}

/**
 * section 10 menempatkan indikator gateway paling atas dan paling besar di layar
 * leader. Di layar agen versinya kecil - tapi tetap ada, karena section 15 menyebut
 * ini "mimpi buruknya": dashboard terlihat normal, antrean sepi, tim santai,
 * padahal pesan masuk terus.
 */
function GatewayPill({ state, since }: { state: string; since: Date | null }) {
  const ok = state === "connected";
  const color = ok ? "var(--st-done)" : state === "qr_required" ? "var(--st-open)" : "var(--st-breach)";
  const label =
    state === "connected"
      ? "Gateway tersambung"
      : state === "qr_required"
        ? "Perlu scan QR"
        : state === "unknown"
          ? "Status gateway belum tercatat"
          : "Gateway terputus";

  return (
    <span
      className="inline-flex items-center gap-2 text-[12.5px]"
      style={{ color: ok ? "var(--ink-muted)" : color }}
      title={since ? `sejak ${durationWords(Date.now() - since.getTime())} lalu` : undefined}
    >
      <span className="dot" style={{ background: color }} />
      {label}
    </span>
  );
}

function Blocked({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-sm text-center">
        <h1 className="text-[20px]">{title}</h1>
        <p className="mt-2 text-[13px] text-ink-muted">{body}</p>
      </div>
    </div>
  );
}
