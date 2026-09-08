// Per-USER callback notification preferences — PURE parsing, no I/O.
//
// A rep's personal mobile number. It lives in the profile's `preferences` JSONB
// under `notify` (written via POST /api/profile from Settings, read server-side
// when an inbound call arrives), so it follows the rep across devices without a
// schema migration.
//
// TWO separate consents, deliberately not one:
//   smsOnCallback   — "text me when someone calls back"
//   forwardCallback — "and put the call through to this phone"
// A rep who wants a heads-up has not thereby agreed to have their mobile ring.
// Both default OFF, and neither does anything until a number is saved.

export interface NotifyPrefs {
  /** E.164, or "" when the rep hasn't given one. */
  phone: string;
  smsOnCallback: boolean;
  forwardCallback: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  phone: "",
  smsOnCallback: false,
  forwardCallback: false,
};

/**
 * Normalize a rep-typed number to E.164, or "" if it can't be one.
 *
 * Reps type "(817) 508-2598", "817-508-2598", "18175082598". All three are the
 * same phone; a stored value that doesn't normalize is a number that will never
 * ring, so this refuses rather than storing something unusable.
 */
export function normalizeNotifyPhone(raw: unknown): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length >= 11 && d.length <= 15) return `+${d}`;
  return "";
}

/** The `notify` node of a profile's preferences JSONB, sanitized. */
export function parseNotifyPrefs(preferences: unknown): NotifyPrefs {
  const node = (preferences as { notify?: unknown } | null | undefined)?.notify as
    | Partial<NotifyPrefs>
    | undefined;
  const phone = normalizeNotifyPhone(node?.phone);
  return {
    phone,
    // A toggle with no number behind it is a promise nothing can keep, so it
    // reads as off until a usable number is saved.
    smsOnCallback: Boolean(phone) && node?.smsOnCallback === true,
    forwardCallback: Boolean(phone) && node?.forwardCallback === true,
  };
}

/** The shape POST /api/profile stores back. Rejects an unusable number. */
export function toNotifyPrefsPatch(input: {
  phone?: unknown;
  smsOnCallback?: unknown;
  forwardCallback?: unknown;
}): { ok: true; notify: NotifyPrefs } | { ok: false; error: string } {
  const raw = String(input.phone ?? "").trim();
  const phone = raw ? normalizeNotifyPhone(raw) : "";
  if (raw && !phone) {
    return { ok: false, error: "That doesn't look like a phone number we can text or ring." };
  }
  return {
    ok: true,
    notify: {
      phone,
      smsOnCallback: Boolean(phone) && input.smsOnCallback === true,
      forwardCallback: Boolean(phone) && input.forwardCallback === true,
    },
  };
}
