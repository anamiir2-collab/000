import type { Metadata, Viewport } from "next";
import "./globals.css";

// Base path for GitHub Pages subpath deployment ('' in dev, '/Agrima' in the GH Pages build)
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const metadata: Metadata = {
  title: "Agrima ERP — إدارة المخزون والبكر وأذون الصرف",
  description:
    "نظام محلي كامل لإدارة المخزون والرولات والبكر والإنتاج وأذون الصرف وحجوزات العملاء — يعمل بدون إنترنت وبدون أي خدمات سحابية.",
  applicationName: "Agrima",
  manifest: `${BASE}/manifest.webmanifest`,
  icons: {
    icon: [{ url: `${BASE}/icon.svg`, type: "image/svg+xml" }],
    apple: `${BASE}/icon.svg`,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0F2B4C",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
