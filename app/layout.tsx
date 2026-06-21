import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Monday Outreach Automation',
  description: 'Account-level follow-up date service for Monday.com',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, -apple-system, sans-serif',
          margin: 0,
          padding: '3rem 1.5rem',
          maxWidth: 720,
          marginInline: 'auto',
          lineHeight: 1.6,
          color: '#1a1a1a',
        }}
      >
        {children}
      </body>
    </html>
  );
}
