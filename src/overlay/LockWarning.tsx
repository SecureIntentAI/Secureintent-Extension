import { useEffect, useState } from 'react';

export interface LockWarningProps {
  /** Seconds until the lock engages. Displayed as a live countdown. */
  seconds: number;
}

/**
 * Small pre-lock toast: warns the user a few seconds before the console locks
 * so it never slams shut mid-task. Any activity (handled by the orchestrator)
 * dismisses it. Display-only — the orchestrator owns the actual lock timer.
 */
export function LockWarning({ seconds }: LockWarningProps) {
  const [n, setN] = useState(seconds);

  useEffect(() => {
    const id = setInterval(() => setN((v) => (v > 1 ? v - 1 : 1)), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="si-lockwarn" role="status">
      <span className="si-lockwarn-dot" />
      <span>Locking in {n}s. Move to stay active.</span>
    </div>
  );
}
