import { clientIp, getSession, ipAllowed } from "@/lib/auth";
import { subscribe } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Aliran peristiwa realtime (SSE) - section 9.1.
 *
 * Denyut tiap 25 detik dikirim supaya proxy yang memutus koneksi diam tidak
 * ikut memutus ini. Tanpa denyut, layar agen tampak hidup padahal aliran sudah
 * mati - versi kecil dari kegagalan senyap yang dikhawatirkan section 15.
 */
export async function GET(req: Request) {
  /* Pagar IP kantor berlaku DI SINI JUGA. Halaman biasa melewatinya lewat
     requireUser(); endpoint ini punya penjaganya sendiri, dan sebelumnya cuma
     memeriksa sesi - jadi satu-satunya jalur yang membocorkan aliran peristiwa
     ke luar jaringan yang diizinkan leader. */
  if (!(await ipAllowed(await clientIp()))) return new Response("forbidden", { status: 403 });

  const session = await getSession();
  if (!session) return new Response("unauthorized", { status: 401 });

  const encoder = new TextEncoder();
  let unsubscribe: (() => Promise<void>) | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          /* klien sudah pergi */
        }
      };

      send(`retry: 4000\n\n`);
      send(`: tersambung\n\n`);

      unsubscribe = await subscribe((ev) => send(`data: ${JSON.stringify(ev)}\n\n`));
      beat = setInterval(() => send(`: denyut\n\n`), 25_000);

      req.signal.addEventListener("abort", () => {
        if (beat) clearInterval(beat);
        void unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* sudah tertutup */
        }
      });
    },
    async cancel() {
      if (beat) clearInterval(beat);
      await unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
