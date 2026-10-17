import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "YaFI Coffee & Gelato — A little joy, made to order",
  description: "Coffee, South Asian-inspired sips, and small-batch gelato. Order ahead for café pickup.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
