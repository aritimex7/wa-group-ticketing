/**
 * Primitif tata letak halaman Setelan.
 *
 * Dipindah ke berkas sendiri saat halaman dipecah jadi tab: enam sub-halaman
 * memakai komponen yang sama, dan menyalinnya enam kali adalah cara tercepat
 * membuat keenamnya perlahan berbeda satu per satu.
 */
import type React from "react";

export function Sec({
  title,
  note,
  children,
  anchor,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
  anchor?: string;
}) {
  return (
    <section id={anchor} className="rule-t py-7 scroll-mt-16">
      <h2 className="micro text-ink">{title}</h2>
      {note ? <p className="mt-1.5 max-w-[62ch] text-[12.5px] text-ink-muted">{note}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Form({
  action,
  children,
  className = "",
}: {
  action: (fd: FormData) => Promise<void>;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <form action={action} className={className}>
      {children}
      <button className="btn mt-3" type="submit">
        Simpan
      </button>
    </form>
  );
}

export function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="micro">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? <span className="mt-1 block text-[11.5px] text-ink-faint">{hint}</span> : null}
    </label>
  );
}

export function Check({
  name,
  defaultChecked,
  children,
}: {
  name: string;
  defaultChecked: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="mt-2 flex items-center gap-2 text-[13.5px]">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      {children}
    </label>
  );
}
