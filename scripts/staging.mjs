#!/usr/bin/env node
/**
 * Menjalankan perintah apa pun dengan environment staging.
 *
 * Kenapa ini ada, bukan sekadar `.env.local`. Next.js memuat `.env.local`
 * secara otomatis untuk SEMUA mode, termasuk `npm run dev` yang biasa. Kalau
 * setelan staging ditaruh di sana, environment kerja lokal ikut tersedot ke
 * staging tanpa ada yang mengetik apa pun. `.env.staging` justru dipilih
 * karena Next TIDAK mengenalnya: satu-satunya cara memuatnya adalah lewat
 * berkas ini, dan itu selalu eksplisit.
 *
 * Efek samping yang menguntungkan: drizzle.config.ts tidak perlu diubah sama
 * sekali. Berkas itu memanggil `import "dotenv/config"` yang memuat `.env`,
 * tapi dotenv tidak menimpa process.env yang sudah terisi - jadi DATABASE_URL
 * staging yang kita set di sini tetap yang menang.
 *
 * Pemakaian:
 *   node scripts/staging.mjs <perintah> [argumen...]
 *
 * Lihat script staging:* di package.json.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";

const ROOT = path.resolve(import.meta.dirname, "..");
const ENV_FILE = path.join(ROOT, ".env.staging");

function mati(pesan) {
  console.error(`\n[staging] BERHENTI: ${pesan}\n`);
  process.exit(1);
}

/* --------------------------------- env ---------------------------------- */

if (!existsSync(ENV_FILE)) {
  mati(
    `.env.staging tidak ada.\n` +
      `          Salin dari contohnya lalu isi:  cp .env.staging.example .env.staging`,
  );
}

// override: true - nilai di .env.staging harus mengalahkan apa pun yang sudah
// ada di shell. Tanpa ini, DATABASE_URL yang kebetulan ter-export di terminal
// akan menang dan kita bisa menunjuk database yang salah.
const { error } = config({ path: ENV_FILE, override: true, quiet: true });
if (error) mati(`gagal membaca .env.staging - ${error.message}`);

/* ------------------------------- pagar ---------------------------------- */
/**
 * Ini inti berkas ini. "Staging tidak memakai database production" harus jadi
 * aturan yang dipaksakan mesin, bukan janji yang diingat manusia. Perintah di
 * bawah - termasuk `drizzle-kit migrate` dan `db:seed` - tidak akan pernah
 * jalan kalau DATABASE_URL bukan database staging di port staging.
 *
 * Dicek dua-duanya, nama DAN port, karena masing-masing sendirian tidak cukup:
 * nama yang benar di port 5432 berarti menumpang cluster lokal, dan port yang
 * benar dengan nama lain berarti database yang salah di server yang benar.
 */
const DB_WAJIB = "dashboard_wa_staging";
const PORT_WAJIB = "5433";

const url = process.env.DATABASE_URL ?? "";
if (!url) mati("DATABASE_URL kosong setelah memuat .env.staging.");

const namaCocok = url.includes(`/${DB_WAJIB}`);
const portCocok = url.includes(`:${PORT_WAJIB}/`);

if (!namaCocok || !portCocok) {
  // Sensor sandi sebelum menampilkan URL-nya.
  const aman = url.replace(/:\/\/([^:/@]+):[^@]*@/, "://$1:***@");
  mati(
    `DATABASE_URL bukan database staging.\n` +
      `          terbaca : ${aman}\n` +
      `          wajib   : nama database "${DB_WAJIB}" di port ${PORT_WAJIB}\n` +
      `          ${namaCocok ? "" : `-> nama database tidak cocok\n          `}` +
      `${portCocok ? "" : "-> port tidak cocok\n          "}` +
      `Tidak ada perintah yang dijalankan. Periksa DATABASE_URL di .env.staging.`,
  );
}

/* ------------------------------ jalankan -------------------------------- */

const [perintah, ...argumen] = process.argv.slice(2);
if (!perintah) {
  mati("tidak ada perintah.\n          contoh: node scripts/staging.mjs drizzle-kit migrate");
}

// Satu baris yang selalu menyebut sasarannya. Murah, dan membuat "salah
// environment" jadi kelihatan sebelum sesuatu terjadi, bukan sesudah.
console.log(
  `[staging] db=${DB_WAJIB} port=${PORT_WAJIB} ticker=${process.env.INTERNAL_TICKER} ` +
    `dump=${process.env.FASE0_DUMP} -> ${perintah} ${argumen.join(" ")}`.trimEnd(),
);

// node_modules/.bin dipasang ke PATH sendiri, tidak menumpang npm. Gunanya
// supaya `node scripts/staging.mjs drizzle-kit migrate` juga jalan kalau
// dipanggil langsung, bukan hanya lewat `npm run staging:*` (npm yang biasanya
// menambahkan folder itu ke PATH).
//
// Catatan lingkungan: node_modules di folder ini terpasang untuk Linux
// (@esbuild/linux-x64), jadi tsx dan drizzle-kit HANYA jalan dari dalam WSL,
// bukan dari PowerShell. Semua perintah staging dijalankan dari WSL.
const BIN = path.join(ROOT, "node_modules", ".bin");
const env = { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ""}` };

const anak = spawn(perintah, argumen, {
  stdio: "inherit",
  cwd: ROOT,
  env,
  // Kalau suatu saat node_modules dipasang ulang dari Windows, binari di
  // .bin jadi shim .cmd yang tidak bisa di-spawn tanpa shell.
  shell: process.platform === "win32",
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => anak.kill(sig));
}

anak.on("error", (err) => mati(`gagal menjalankan "${perintah}" - ${err.message}`));
anak.on("exit", (code, signal) => {
  // Teruskan hasil anak apa adanya, supaya `npm run staging:*` gagal kalau
  // perintahnya gagal.
  process.exit(signal ? 1 : (code ?? 0));
});
