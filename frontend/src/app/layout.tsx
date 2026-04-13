import type { Metadata } from "next";
import "./globals.css";
import ServiceWorker from "../components/ServiceWorker";

export const metadata: Metadata = {
  title: "DispatchBoard",
  description: "Order management and fulfillment board",
  manifest: "/manifest.webmanifest"
};

export const viewport = {
  themeColor: "#1b1b1b"
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans" suppressHydrationWarning>
        <ServiceWorker />
        {children}
      </body>
    </html>
  );
}
