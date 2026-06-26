import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Southtown Content Agent",
  description: "SEO opportunity and draft content dashboard for Southtown Dental."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
