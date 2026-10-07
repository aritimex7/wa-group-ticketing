#!/usr/bin/env node
/**
 * Gateway tiruan untuk staging. Meniru Evolution API v2.3.7 secukupnya supaya
 * alur kirim bisa berjalan penuh - TANPA menyentuh WhatsApp sama sekali.
 *
 * Kenapa ini ada. Staging tidak boleh punya jalan ke instance WhatsApp yang
 * sungguhan: pesan uji akan benar-benar sampai ke nomor orang, lewat akun yang
 * sama dengan production. Tapi tanpa gateway apa pun, alur kirim berhenti di
 * `holding` dan yang teruji cuma jalur gagal. Berkas ini jalan tengahnya.
 *
 * Yang ditiru bukan tebakan. Tiga hal di bawah dibaca langsung dari
 * src/lib/gateway/evolution.ts:
 *
 *   1. POST /message/sendText/<instance> harus menjawab {"key":{"id":...}}.
 *      Baris 415: stanzaId diambil dari json.key.id, dan outbox.ts:167
 *      menandai `sent` begitu id itu ada.
 *
 *   2. GET /instance/connectionState/<instance> harus menjawab
 *      {"instance":{"state":"open"}}. mapConnectionState() memetakan "open" ->
 *      "connected", yang dipakai indikator gateway di section 10/15.
 *
 *   3. outbox.ts TIDAK PERNAH menulis ke tabel messages. Balasan agen muncul di
 *      thread hanya kalau gateway mengirimkannya balik sebagai event
 *      `send.message`. Karena itu tiruan ini menembak tiga webhook setelah
 *      setiap kirim: pesannya sendiri, lalu SERVER_ACK, lalu DELIVERY_ACK -
 *      supaya `confirmed_at` terisi seperti di production (section 9.4: status
 *      kirim datang dari KONFIRMASI, bukan dari "API sudah dipanggil").
 *
 * Jalankan lewat pembungkus staging supaya ikut membaca .env.staging:
 *   npm run staging:gateway
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

/* -------------------------------- config -------------------------------- */

const GATEWAY_URL = process.env.GATEWAY_URL ?? "";
const INSTANCE = process.env.GATEWAY_INSTANCE ?? "default";
const API_KEY = process.env.GATEWAY_API_KEY ?? "";
const WEBHOOK = process.env.WEBHOOK_TARGET ?? "";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN ?? "";
const SELF_PN = process.env.WA_SELF_PN ?? "628110000000";

let PORT;
try {
  PORT = Number(new URL(GATEWAY_URL).port || 8099);
} catch {
  console.error(`[tiruan] GATEWAY_URL tidak sah: "${GATEWAY_URL}"`);
  process.exit(1);
}

// Pagar kecil tapi penting: kalau GATEWAY_URL ternyata menunjuk gateway asli,
// berkas ini justru akan menghalanginya dan menyembunyikan kesalahan konfigurasi.
if (PORT === 8080) {
  console.error(
    `[tiruan] BERHENTI: port 8080 adalah port gateway Evolution yang sungguhan.\n` +
      `          Tiruan tidak boleh menempatinya. Periksa GATEWAY_URL di .env.staging.`,
  );
  process.exit(1);
}

/* ------------------------------- perkakas -------------------------------- */

/** Bentuk id WhatsApp: hex huruf besar. Bukan UUID - supaya terlihat wajar di log. */
const stanzaId = () => `3EB0${randomBytes(8).toString("hex").toUpperCase()}`;

const jidPn = (n) => (String(n).includes("@") ? String(n) : `${n}@s.whatsapp.net`);

async function kirimWebhook(event, data, label) {
  if (!WEBHOOK) return;
  try {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Lewat header, bukan query string - token tidak perlu ikut tercatat di URL.
        ...(WEBHOOK_TOKEN ? { "x-webhook-token": WEBHOOK_TOKEN } : {}),
      },
      body: JSON.stringify({ event, instance: INSTANCE, data }),
      signal: AbortSignal.timeout(10_000),
    });
    const teks = await res.text().catch(() => "");
    console.log(`[tiruan] -> webhook ${label} ${res.status} ${teks.slice(0, 120)}`);
  } catch (err) {
    console.error(`[tiruan] -> webhook ${label} GAGAL: ${err.message}`);
  }
}

/**
 * Urutan yang menyusul sesudah HTTP 200 dijawab.
 *
 * Jedanya bukan hiasan. `flushDue` baru menandai barisnya `sent` SESUDAH
 * panggilan HTTP kembali; kalau ack menyusul terlalu cepat, ia tiba sebelum
 * `sent_stanza_id` tertulis dan tidak menemukan barisnya.
 */
function susulan({ id, remoteJid, text }) {
  const ts = Math.floor(Date.now() / 1000);

  setTimeout(
    () =>
      kirimWebhook(
        "SEND_MESSAGE",
        {
          // fromMe = true dan TANPA key.participant - persis bentuk pesan kita
          // sendiri di Evolution (lihat catatan di evolution.ts:141).
          key: { id, remoteJid, fromMe: true },
          message: { conversation: text },
          messageTimestamp: ts,
          pushName: null,
        },
        "send.message",
      ),
    1000,
  );

  setTimeout(
    () => kirimWebhook("SEND_MESSAGE_UPDATE", { key: { id, remoteJid }, status: "SERVER_ACK" }, "ack=1 SERVER_ACK"),
    1800,
  );

  setTimeout(
    () => kirimWebhook("SEND_MESSAGE_UPDATE", { key: { id, remoteJid }, status: "DELIVERY_ACK" }, "ack=2 DELIVERY_ACK"),
    2800,
  );
}

function bacaBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const balas = (res, kode, obj) => {
  res.writeHead(kode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

/* -------------------------------- server -------------------------------- */

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // Evolution memeriksa header `apikey`. Ditiru supaya salah konfigurasi
  // ketahuan di staging, bukan nanti di production.
  if (API_KEY && req.headers.apikey !== API_KEY) {
    console.warn(`[tiruan] ${req.method} ${pathname} -> 401 apikey salah`);
    return balas(res, 401, { status: 401, error: "Unauthorized" });
  }

  const cocok = (pola) => pathname === `${pola}/${INSTANCE}`;

  /* ---- status sambungan: selalu "open" ---- */
  if (req.method === "GET" && cocok("/instance/connectionState")) {
    return balas(res, 200, { instance: { instanceName: INSTANCE, state: "open" } });
  }

  /* ---- kirim teks & media ---- */
  if (req.method === "POST" && (cocok("/message/sendText") || cocok("/message/sendMedia"))) {
    const body = await bacaBody(req);
    const id = stanzaId();
    const remoteJid = jidPn(body.number ?? "");
    const teks = body.text ?? body.caption ?? body.fileName ?? "(media)";

    console.log(
      `[tiruan] kirim -> ${remoteJid}  id=${id}` +
        (body.mentioned?.length ? `  mention=${body.mentioned.join(",")}` : "") +
        (body.quoted ? `  quoted=${body.quoted?.key?.id}` : "") +
        `\n           "${String(teks).replace(/\n/g, " / ").slice(0, 90)}"`,
    );

    balas(res, 200, {
      key: { id, remoteJid, fromMe: true },
      message: { conversation: teks },
      messageTimestamp: String(Math.floor(Date.now() / 1000)),
      status: "PENDING",
    });

    susulan({ id, remoteJid, text: teks });
    return;
  }

  /* ---- daftar grup ----
     Fixture, karena tiruan ini tidak punya akses database. JID-nya sengaja
     sama dengan grup hasil seed supaya tombol "Tarik nama grup" bisa diuji,
     dan `subject`-nya sengaja BERBEDA dari nama tersimpan untuk membuktikan
     handleGroupMeta tidak menimpa nama yang sudah diketik leader.
     Bentuknya {id, subject} - lihat evolution.ts:480 yang membaca g.id/g.jid. */
  if (req.method === "GET" && cocok("/group/fetchAllGroups")) {
    return balas(res, 200, [
      { id: "6281100000001-1600000001@g.us", subject: "subject dari WhatsApp 1" },
      { id: "6281100000002-1600000002@g.us", subject: "subject dari WhatsApp 2" },
      { id: "6281100000003-1600000003@g.us", subject: "subject dari WhatsApp 3" },
      { id: "6281100000004-1600000004@g.us", subject: "subject dari WhatsApp 4" },
      { id: "6281100000005-1600000005@g.us", subject: "subject dari WhatsApp 5" },
      { id: "smoke-6-9@g.us", subject: "Grup Uji Smoke" },
    ]);
  }
  if (req.method === "GET" && pathname.startsWith("/group/participants")) {
    return balas(res, 200, { participants: [] });
  }
  if (req.method === "POST" && cocok("/chat/findContacts")) return balas(res, 200, []);

  console.warn(`[tiruan] ${req.method} ${pathname} -> 404 (tidak ditiru)`);
  return balas(res, 404, { status: 404, error: "Not Found", response: { message: ["tidak ditiru"] } });
});

// MOCK_BIND_HOST=0.0.0.0 lets other containers reach the mock (docker-compose.demo.yml).
const BIND_HOST = process.env.MOCK_BIND_HOST ?? "127.0.0.1";

server.listen(PORT, BIND_HOST, () => {
  console.log(
    `[tiruan] Gateway TIRUAN siap di http://127.0.0.1:${PORT}\n` +
      `[tiruan]   instance : ${INSTANCE}\n` +
      `[tiruan]   webhook  : ${WEBHOOK || "(tidak diisi - ack tidak akan dikirim)"}\n` +
      `[tiruan]   akun     : ${SELF_PN}\n` +
      `[tiruan] TIDAK ada satu pun pesan yang keluar ke WhatsApp.`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n[tiruan] berhenti (${sig}).`);
    server.close(() => process.exit(0));
  });
}
