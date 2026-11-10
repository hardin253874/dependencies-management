import type { JSX } from 'react';
import { AppShell } from '@/components/AppShell';
import { AppProvider } from '@/components/AppContext';

export default function Page(): JSX.Element {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
