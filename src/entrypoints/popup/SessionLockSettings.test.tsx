import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { storage } from '#imports';
import { DEFAULT_BUNDLE, saveBundle } from '@/lib/config';
import { hasFeature } from '@/lib/entitlement';
import { getOrCreateSalt, type KeyValueStore } from '@/lib/fingerprint';
import { hashPin } from '@/lib/lock';
import { sessionLockEnabledItem, sessionLockPinHashItem } from '@/settings';
import { SessionLockSettings } from './SessionLockSettings';

// Session Lock is Pro-gated. Mock the entitlement check so we can drive both the
// entitled (Pro) and unentitled (free) states deterministically.
vi.mock('@/lib/entitlement', () => ({ hasFeature: vi.fn() }));
// The background owns the PIN check; route the message straight to it.
vi.mock('@/lib/lock/client', async () => {
  const { tryUnlock } = await import('@/services/sessionLockBackground');
  return { requestUnlock: (pin: string) => tryUnlock(pin) };
});

// Must match the component's store exactly so getOrCreateSalt yields the same salt.
const store: KeyValueStore = {
  get: async (k) => (await storage.getItem<string>(`local:${k}`)) ?? undefined,
  set: (k, v) => storage.setItem(`local:${k}`, v),
};

// Seed a protected, enabled lock with PIN "1234".
async function seedPin(pin = '1234') {
  const salt = await getOrCreateSalt(store);
  await sessionLockPinHashItem.setValue(await hashPin(pin, salt));
  await sessionLockEnabledItem.setValue(true);
}

// Type a PIN digit-by-digit into a segmented PinBoxes group.
function enterPin(prefix: string, pin: string) {
  for (let i = 0; i < pin.length; i++) {
    fireEvent.change(screen.getByLabelText(`${prefix} ${i + 1}`), { target: { value: pin[i] } });
  }
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.mocked(hasFeature).mockResolvedValue(true); // Pro by default
});
afterEach(() => cleanup());

describe('SessionLockSettings — Pro gating', () => {
  test('free (unentitled) shows an upgrade card, no toggle or PIN form', async () => {
    vi.mocked(hasFeature).mockResolvedValue(false);
    await seedPin(); // even with a lingering enabled+PIN config...
    render(<SessionLockSettings />);

    await screen.findByText('Upgrade to unlock');
    // ...the free user gets no way to toggle or configure it.
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByLabelText('New PIN digit 1')).toBeNull();
    expect(screen.queryByText('Change PIN')).toBeNull();
  });

  test('Pro (entitled) shows the normal config UI', async () => {
    vi.mocked(hasFeature).mockResolvedValue(true);
    await seedPin();
    render(<SessionLockSettings />);
    expect(await screen.findByRole('switch')).toBeTruthy();
    expect(screen.queryByText('Upgrade to unlock')).toBeNull();
  });
});

describe('SessionLockSettings — PIN-gated disable', () => {
  test('turning the lock off requires the PIN; stays enabled until verified', async () => {
    await seedPin();
    render(<SessionLockSettings />);
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));

    fireEvent.click(toggle); // request disable
    await screen.findByLabelText('Current PIN digit 1');

    // wrong PIN → still enabled, error shown
    enterPin('Current PIN digit', '9999');
    await screen.findByText(/Incorrect PIN/);
    expect(await sessionLockEnabledItem.getValue()).toBe(true);

    // correct PIN → auto-submits and disables
    enterPin('Current PIN digit', '1234');
    await waitFor(async () => expect(await sessionLockEnabledItem.getValue()).toBe(false));
  });

  test('Remove PIN requires the PIN before clearing', async () => {
    await seedPin();
    render(<SessionLockSettings />);
    fireEvent.click(await screen.findByText('Remove PIN'));
    await screen.findByLabelText('Current PIN digit 1');

    enterPin('Current PIN digit', '0000');
    await screen.findByText(/Incorrect PIN/);
    expect(await sessionLockPinHashItem.getValue()).not.toBeNull();

    enterPin('Current PIN digit', '1234');
    await waitFor(async () => expect(await sessionLockPinHashItem.getValue()).toBeNull());
  });

  test('Change PIN requires the current PIN before showing the new-PIN form', async () => {
    await seedPin();
    render(<SessionLockSettings />);
    fireEvent.click(await screen.findByText('Change PIN'));

    enterPin('Current PIN digit', '1234');
    await screen.findByLabelText('New PIN digit 1'); // gate passed → set-new-PIN form
  });

  test('collapses the body when disabled with a PIN saved', async () => {
    const salt = await getOrCreateSalt(store);
    await sessionLockPinHashItem.setValue(await hashPin('1234', salt));
    await sessionLockEnabledItem.setValue(false);

    const { container } = render(<SessionLockSettings />);
    await screen.findByText('Session Lock');
    // Body is collapsed (no is-open) when the lock is off.
    await waitFor(() => {
      const body = container.querySelector('.si-lockcfg-body');
      expect(body?.classList.contains('is-open')).toBe(false);
    });
  });

  test('expands the body when enabled with a PIN saved', async () => {
    await seedPin(); // enabled + PIN
    const { container } = render(<SessionLockSettings />);
    await waitFor(() => {
      const body = container.querySelector('.si-lockcfg-body');
      expect(body?.classList.contains('is-open')).toBe(true);
    });
  });

  test('regression: with no team policy there is no "Team policy" tag', async () => {
    await seedPin();
    render(<SessionLockSettings />);
    await screen.findByRole('switch');
    expect(screen.queryByText('Team policy')).toBeNull();
    expect(screen.getByText('Remove PIN')).toBeTruthy();
  });

  test('enabling (off → on) does not require the PIN', async () => {
    const salt = await getOrCreateSalt(store);
    await sessionLockPinHashItem.setValue(await hashPin('1234', salt));
    await sessionLockEnabledItem.setValue(false); // has PIN but currently off

    render(<SessionLockSettings />);
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));

    fireEvent.click(toggle); // enable — no gate
    await waitFor(async () => expect(await sessionLockEnabledItem.getValue()).toBe(true));
    expect(screen.queryByLabelText('Current PIN digit 1')).toBeNull();
  });
});

describe('SessionLockSettings — enforced by team policy', () => {
  // Only a signature-verified bundle is ever persisted, so seeding the active
  // bundle stands in for "the team admin pushed requireSessionLock".
  const enforce = () =>
    saveBundle({
      ...DEFAULT_BUNDLE,
      policy: {
        blockInsteadOfWarn: false,
        requireSessionLock: true,
        extraPatterns: [],
        blockedSites: [],
      },
    });

  test('shows the lock as on and labelled, even with a stale off in storage', async () => {
    const salt = await getOrCreateSalt(store);
    await sessionLockPinHashItem.setValue(await hashPin('1234', salt));
    await sessionLockEnabledItem.setValue(false); // stale local state
    await enforce();

    render(<SessionLockSettings />);
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByText('Team policy')).toBeTruthy();
    expect(screen.getByText(/Required by your team policy/)).toBeTruthy();
  });

  test('a click to switch it off is answered, not silently ignored', async () => {
    await seedPin();
    await enforce();
    render(<SessionLockSettings />);
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));

    fireEvent.click(toggle);

    // Explained, no PIN gate opened, and still on — in the UI and in storage.
    await screen.findByText(/Your team requires Session Lock/);
    expect(screen.queryByLabelText('Current PIN digit 1')).toBeNull();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(await sessionLockEnabledItem.getValue()).toBe(true);
  });

  test('the PIN cannot be removed (that would disable the lock)', async () => {
    await seedPin();
    await enforce();
    render(<SessionLockSettings />);
    await screen.findByText('Change PIN'); // configured state rendered
    expect(screen.queryByText('Remove PIN')).toBeNull();
  });

  test('an enforced member can still set a PIN even if the entitlement lags', async () => {
    vi.mocked(hasFeature).mockResolvedValue(false); // cached entitlement says free
    await enforce();
    render(<SessionLockSettings />);

    // Not the upgrade wall: the team requires the lock, so setup must be reachable.
    await screen.findByLabelText('New PIN digit 1');
    expect(screen.queryByText('Upgrade to unlock')).toBeNull();
  });
});
