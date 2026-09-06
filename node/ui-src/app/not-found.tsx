import { TerminalSquare } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="standalone-state" aria-labelledby="not-found-title">
      <div className="standalone-card">
        <div className="brand-symbol" aria-hidden="true"><TerminalSquare /></div>
        <h1 id="not-found-title">Page not found</h1>
        <p>Open the CRP local console from its root address.</p>
        <Link className="button button-primary" href="/overview">Open Overview</Link>
      </div>
    </main>
  );
}
