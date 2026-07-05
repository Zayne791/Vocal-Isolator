import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Neville's Song Stripper",
  description: "Paste a song link, get it back with the lead singer removed.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
