/**
 * Detak internal.
 *
 * Kenapa ini ada. Dua pekerjaan di sistem ini WAJIB berjalan berkala, dan
 * dua-duanya gagal secara diam-diam kalau tidak:
 *
 *   section 9.4  melempar pesan dari outbox setelah jendela undo habis
 *   section 6.3  melepas claim yang nyangkut saat pergantian shift
 *   section 15   memantau sambungan gateway dan membunyikan alarmnya
 *   section 15   membedakan "sepi beneran" dari "sepi karena rusak"
 *
 * Semula keduanya hanya dipanggil /api/cron/tick, dan README menyuruh pemakai
 * menjalankan loop curl sendiri. Yang terjadi di praktik persis seperti dugaan
 * terburuk: tidak ada yang menjalankannya, empat balasan agen mengendap di
 * outbox berjam-jam, dan tidak ada satu pun tanda di layar.
 *
 * Sekarang proses web menggerakkannya sendiri. Aman untuk dijalankan bersamaan
 * dengan cron eksternal maupun beberapa instance: flushDue() mengambil barisnya
 * dengan UPDATE atomik, jadi tidak ada baris yang terkirim dua kali.
 *
 * Matikan dengan INTERNAL_TICKER=off kalau memang mau memakai systemd timer.
 */

const INTERVAL_MS = 10_000;

export async function register() {
  // Hanya di runtime Node. Runtime edge tidak bisa menyentuh Postgres.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if ((process.env.INTERNAL_TICKER ?? "on").toLowerCase() === "off") return;

  // Pekerjaan yang sama persis dengan /api/cron/tick - satu sumber, lib/tick.ts.
  const { jalankanDetak } = await import("@/lib/tick");

  let berjalan = false;

  const detak = async () => {
    // Jangan menumpuk kalau satu putaran lebih lama dari intervalnya.
    if (berjalan) return;
    berjalan = true;
    try {
      const h = await jalankanDetak();
      if (h.released || h.sent || h.failed || h.quietAlert) {
        console.log(
          `[detak] lepas=${h.released} terkirim=${h.sent} gagal=${h.failed} gateway=${h.gateway}`,
        );
      }
    } catch (err) {
      // Database belum siap saat boot itu wajar. Jangan menjatuhkan server.
      console.error("[detak]", (err as Error).message);
    } finally {
      berjalan = false;
    }
  };

  const timer = setInterval(detak, INTERVAL_MS);
  // Jangan menahan proses tetap hidup hanya karena timer ini.
  timer.unref?.();

  console.log(`[detak] aktif tiap ${INTERVAL_MS / 1000} detik (matikan: INTERNAL_TICKER=off)`);
}
