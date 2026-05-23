import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Dependencies Agent',
  description: 'Locally-run dependencies analysis agent.',
  robots: 'noindex,nofollow'
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <html lang="en" data-theme="light">
      <body>
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
