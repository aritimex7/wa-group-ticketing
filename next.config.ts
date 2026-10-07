import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Gateway webhook mengirim payload besar (raw_payload + thumbnail base64).
  experimental: { serverActions: { bodySizeLimit: "8mb" } },
  // Jangan bocorkan versi framework ke luar.
  poweredByHeader: false,

  // Default `.next` - persis seperti sebelumnya, jadi dev dan production tidak
  // berubah sama sekali. Yang butuh ini hanya staging: dua `next dev` di folder
  // yang sama akan berebut manifest dan trace di .next/, dan gejalanya
  // menyesatkan (halaman kosong, chunk 404) karena tidak kelihatan seperti
  // masalah folder. .env.staging mengisinya dengan .next-staging.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
