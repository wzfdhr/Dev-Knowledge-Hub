type CookieResponse = {
  headers: Record<string, string | string[] | number | undefined>;
};

export function authenticatedCookie(response: CookieResponse): string {
  const raw = response.headers["set-cookie"];
  const values = (Array.isArray(raw) ? raw : [raw]).map((value) => String(value));
  const session = values.find((value) => value.startsWith("devkh_session="));
  const csrf = values.find((value) => value.startsWith("devkh_csrf="));
  if (!session || !csrf) throw new Error("Expected session and CSRF cookies");
  return `${session.split(";", 1)[0]}; ${csrf.split(";", 1)[0]}`;
}

export function csrfHeaders(cookie: string): Record<"x-devkh-csrf", string> {
  const csrf = cookie.split(";").map((item) => item.trim())
    .find((item) => item.startsWith("devkh_csrf="));
  if (!csrf) throw new Error("Expected a CSRF cookie");
  return { "x-devkh-csrf": csrf.slice("devkh_csrf=".length) };
}
