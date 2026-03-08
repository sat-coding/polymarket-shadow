import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Polymarket Shadow Portfolio',
  description: 'Paper trading dashboard with LLM market analysis',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-green-400 antialiased">{children}</body>
    </html>
  );
}
