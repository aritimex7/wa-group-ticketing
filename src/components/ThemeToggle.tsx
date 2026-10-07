"use client";

import { useEffect, useState } from "react";

type Mode = "system" | "light" | "dark";
const KEY = "wa-tema";

/**
 * Operasional 24 jam, jadi tema bukan soal selera - agen shift malam memang
 * butuh ground gelap. Pilihan disimpan per-perangkat (localStorage), bukan per
 * akun, karena satu PC kantor dipakai bergantian antar shift dan yang menentukan
 * adalah kondisi ruangan, bukan siapa yang login.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");

  useEffect(() => {
    setMode((localStorage.getItem(KEY) as Mode) ?? "system");
  }, []);

  const apply = (next: Mode) => {
    setMode(next);
    localStorage.setItem(KEY, next);
    const dark =
      next === "dark" ||
      (next === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  };

  const label: Record<Mode, string> = { system: "Sistem", light: "Terang", dark: "Gelap" };
  const next: Record<Mode, Mode> = { system: "light", light: "dark", dark: "system" };

  return (
    <button
      type="button"
      className="btn btn-quiet h-7 px-2 micro"
      onClick={() => apply(next[mode])}
      title={`Tampilan: ${label[mode]}. Klik untuk ganti.`}
    >
      {label[mode]}
    </button>
  );
}
