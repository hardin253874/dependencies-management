import { useState } from 'react';

export function Header() {
  const [open] = useState(false);
  return <header>{String(open)}</header>;
}
