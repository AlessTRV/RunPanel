import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * The notification settings API, without ever reaching Telegram.
 *
 * Nothing here can send a message: a valid bot token is verified against
 * `api.telegram.org` before it is stored, so the suite deliberately only uses
 * tokens that are refused before any network call, and only asks for actions
 * that answer from local state. What that leaves is the part most likely to
 * break — the route is behind the session, the token never comes back out, the
 * validation rejects what it should, and the selection round-trips.
 */
export const meta = { name: "notify", needsDocker: false, drivers: ["sqlite", "postgres"] };

export async function run({ base }) {
  const r = createReporter("notify");
  const api = client(base);

  for (const method of ["GET", "PUT", "POST"]) {
    const res = await api.call("/api/notifications", {
      method,
      ...(method === "GET" ? {} : { body: JSON.stringify({}) }),
    });
    r.check(`${method} /api/notifications needs a session`, res.status === 401, String(res.status));
  }

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "notify-suite-pw" }),
  });

  // --- The starting state ---------------------------------------------------
  let res = await api.call("/api/notifications");
  r.check("config answers 200", res.status === 200, String(res.status));
  r.check("no token yet", res.body.tokenSet === false, JSON.stringify(res.body.tokenSet));
  r.check("no chat yet", res.body.chatId === "", JSON.stringify(res.body.chatId));
  r.check("not configured", res.body.configured === false);
  r.check("a default selection is offered", Array.isArray(res.body.events) && res.body.events.length > 0,
    JSON.stringify(res.body.events));

  // --- The token never comes back ------------------------------------------
  //
  // The whole point of storing it encrypted is lost if the screen can read it
  // back, so this is asserted rather than assumed.
  r.check("the config never carries a token field", !("token" in res.body), JSON.stringify(Object.keys(res.body)));

  // --- Validation happens before anything is stored ------------------------
  for (const bad of ["nonsense", "123:short", "abc:defghijklmnopqrstuvwxyz", " "]) {
    const attempt = await api.call("/api/notifications", {
      method: "PUT",
      body: JSON.stringify({ token: bad }),
    });
    r.check(`a malformed token is refused (${bad.trim() || "blank"})`, attempt.status === 400, String(attempt.status));
  }

  for (const bad of ["not-a-chat", "12 34", "@ab", "", " "]) {
    const attempt = await api.call("/api/notifications", {
      method: "PUT",
      body: JSON.stringify({ chatId: bad }),
    });
    // The empty string is the documented way to clear it, so only the others
    // are errors.
    const expected = bad === "" ? 200 : 400;
    r.check(`chat "${bad || "(empty)"}" → ${expected}`, attempt.status === expected, String(attempt.status));
  }

  res = await api.call("/api/notifications", {
    method: "PUT",
    body: JSON.stringify({ events: ["deploy.finished", "not.an.event"] }),
  });
  r.check("an unknown event key is refused", res.status === 400, String(res.status));

  res = await api.call("/api/notifications", {
    method: "PUT",
    body: JSON.stringify({ unexpected: true }),
  });
  r.check("an unknown field is refused", res.status === 400, String(res.status));

  // --- The selection round-trips -------------------------------------------
  res = await api.call("/api/notifications", {
    method: "PUT",
    body: JSON.stringify({ events: ["deploy.finished", "backup.finished"] }),
  });
  r.check("a valid selection is accepted", res.status === 200, String(res.status));

  res = await api.call("/api/notifications");
  r.check("and is read back", JSON.stringify(res.body.events) === '["deploy.finished","backup.finished"]',
    JSON.stringify(res.body.events));

  res = await api.call("/api/notifications", { method: "PUT", body: JSON.stringify({ events: [] }) });
  r.check("turning everything off is allowed", res.status === 200, String(res.status));
  res = await api.call("/api/notifications");
  r.check("and stays off rather than reverting to the defaults",
    Array.isArray(res.body.events) && res.body.events.length === 0, JSON.stringify(res.body.events));

  // --- A chat on its own is not a configured channel ------------------------
  res = await api.call("/api/notifications", {
    method: "PUT",
    body: JSON.stringify({ chatId: "-1001234567890" }),
  });
  r.check("a group chat id is accepted", res.status === 200, String(res.status));
  res = await api.call("/api/notifications");
  r.check("the chat is stored", res.body.chatId === "-1001234567890", res.body.chatId);
  r.check("but without a token nothing is configured", res.body.configured === false);

  // --- The actions refuse politely rather than failing ---------------------
  res = await api.call("/api/notifications", { method: "POST", body: JSON.stringify({ action: "test" }) });
  r.check("a test with no bot answers 200", res.status === 200, String(res.status));
  r.check("and says what is missing", res.body.ok === false && typeof res.body.error === "string",
    JSON.stringify(res.body));

  res = await api.call("/api/notifications", { method: "POST", body: JSON.stringify({ action: "chats" }) });
  r.check("chat discovery with no bot answers 200", res.status === 200, String(res.status));
  r.check("and says to save a token first", res.body.ok === false, JSON.stringify(res.body));

  res = await api.call("/api/notifications", { method: "POST", body: JSON.stringify({ action: "nope" }) });
  r.check("an unknown action is refused", res.status === 400, String(res.status));

  return r.result();
}
