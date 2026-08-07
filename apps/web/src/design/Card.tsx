import type { ReactNode } from "react";

/* 32px radius, white surface, no shadow — flat is the default in this system. */
export function Card({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-lg bg-canvas p-xxl">
      {children}
    </section>
  );
}
