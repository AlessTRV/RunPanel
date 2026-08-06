import { client, createReporter } from "../harness.mjs";

/**
 * Sessions are per device, and the login limiter is persistent.
 *
 * The panel used to keep a single `session_token` in the settings table, so
 * signing in on a phone silently signed you out on the desktop. The rate
 * limiter lived in a module-level Map, so restarting the server — routine on a
 * self-hosted panel — handed an attacker a fresh set of attempts.
 */
export const meta = { name: "sessions", needsDocker: false, drivers: ["sqlite"] };

export async function run({ base }) {
  const r = createReporter("sessions");

  const desktop = client(base);
  const phone = client(base);
  const tablet = client(base);

  await desktop.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, password: "sessions-pw-1" }),
  });
  await phone.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password: "sessions-pw-1" }),
  });

  let d = await desktop.call("/api/projects");
  let p = await phone.call("/api/projects");
  r.check("a second device does not sign out the first", d.status === 200 && p.status === 200,
    `desktop=${d.status} phone=${p.status}`);

  await phone.call("/api/auth/logout", { method: "POST" });
  d = await desktop.call("/api/projects");
  p = await phone.call("/api/projects");
  r.check("logging out one device leaves the other signed in", d.status === 200 && p.status === 401,
    `desktop=${d.status} phone=${p.status}`);

  await tablet.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password: "sessions-pw-1" }),
  });
  r.check("third device signed in", (await tablet.call("/api/projects")).status === 200);

  const changed = await desktop.call("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ currentPassword: "sessions-pw-1", newPassword: "sessions-pw-2" }),
  });
  r.check("password change accepted", changed.status === 200, JSON.stringify(changed.body));

  r.check("the device that changed the password stays signed in",
    (await desktop.call("/api/projects")).status === 200);
  r.check("every other device is signed out",
    (await tablet.call("/api/projects")).status === 401);

  // --- rate limiting -------------------------------------------------------
  const attacker = client(base);
  let limited = false;
  let last = 0;
  for (let i = 0; i < 8; i++) {
    const res = await attacker.call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "wrong-guess" }),
    });
    last = res.status;
    if (res.status === 429) { limited = true; break; }
  }
  r.check("repeated bad passwords are rate limited", limited, `last status ${last}`);

  return r.result();
}
