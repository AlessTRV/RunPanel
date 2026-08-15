/**
 * How often the panel asks GitHub whether a branch moved.
 *
 * This lives in `lib` rather than next to the poller because three places need
 * it and one of them runs in the browser: the settings schema validates against
 * the list, the poller reads the interval, and the account screen offers it as
 * a choice. `services/deploy-poll.ts` imports the database, GitHub and the
 * settings store at module scope, so a client component importing the list from
 * there would pull all of that into the bundle.
 *
 * The default is here for the same reason it is a constant at all: the account
 * screen used to initialise its picker to "5" — a value from the *other*
 * interval control on the same page, and not one of these — so on any panel
 * that had never saved the setting the control rendered with nothing selected
 * at all, despite being a "pick one" that disallows an empty selection.
 */

/** The intervals the panel offers, in seconds. */
export const POLL_INTERVALS = ["30", "60", "120", "300", "600", "900", "1800"] as const;

export type PollInterval = (typeof POLL_INTERVALS)[number];

/**
 * Five minutes: slow enough to be free against GitHub's rate limit, fast enough
 * to feel automatic. Must stay a member of POLL_INTERVALS — the type enforces
 * it — because the picker shows nothing selected for a value off the list.
 */
export const DEFAULT_POLL_INTERVAL: PollInterval = "300";

/** The settings key the chosen interval is stored under. */
export const POLL_INTERVAL_SETTING = "deploy_poll_interval";

/** Narrow a stored or fetched value to one the picker can actually show. */
export function isPollInterval(value: unknown): value is PollInterval {
  return POLL_INTERVALS.includes(value as PollInterval);
}
