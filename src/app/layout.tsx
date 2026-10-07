import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dispatch WhatsApp",
  description: "Dashboard tiket WhatsApp grup",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  // Warna bilah browser mengikuti ground halaman di kedua tema.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f7" },
    { media: "(prefers-color-scheme: dark)", color: "#15140f" },
  ],
};

/**
 * Tema dipasang SEBELUM cat pertama. Tanpa ini, agen shift malam melihat
 * kilatan putih penuh layar tiap kali pindah halaman - hal kecil yang jadi
 * besar kalau terjadi ratusan kali semalam.
 */
const noFlash = `
(function () {
  try {
    var m = localStorage.getItem('wa-tema') || 'system';
    var dark = m === 'dark' || (m === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
