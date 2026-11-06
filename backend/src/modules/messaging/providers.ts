/**
 * SMS provider abstraction.
 *
 * - `sim` (primary): the Android companion app sends from the admin's own
 *   SIM. There is nothing to "send" server-side — the message_queue IS the
 *   handoff; the device polls it. dispatchViaSim() therefore just confirms
 *   the row is queued for the device.
 * - `gateway` (optional fallback): Twilio-compatible HTTP stub. It is a STUB
 *   until SMS_GATEWAY_URL + SMS_GATEWAY_KEY are set — it throws a clear
 *   error otherwise, and never pretends a message was sent.
 *
 * The Fee/Scheduler agent's auto-send path calls dispatchMessage() for rows
 * whose school uses the gateway; SIM rows are left for the device.
 */

export interface GatewayConfig {
  url?: string;
  key?: string;
  from?: string;
}

export function gatewayConfigFromEnv(): GatewayConfig {
  return {
    url: process.env.SMS_GATEWAY_URL,
    key: process.env.SMS_GATEWAY_KEY,
    from: process.env.SMS_GATEWAY_FROM,
  };
}

export interface GatewayResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

/**
 * Send one SMS via the configured gateway (Twilio-compatible JSON API).
 * STUB: replace the endpoint/payload mapping with the real provider's API
 * when credentials are provisioned. Throws if not configured.
 */
export async function sendViaGateway(
  to: string,
  body: string,
  config: GatewayConfig = gatewayConfigFromEnv(),
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayResult> {
  if (!config.url || !config.key) {
    throw new Error(
      'SMS gateway not configured (stub): set SMS_GATEWAY_URL and SMS_GATEWAY_KEY',
    );
  }
  const res = await fetchImpl(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({ to, body, from: config.from }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `gateway HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: true,
    providerMessageId:
      typeof data.sid === 'string'
        ? data.sid
        : typeof data.id === 'string'
          ? data.id
          : undefined,
  };
}

/** SIM path: no server-side send — the device owns delivery. */
export function dispatchViaSim(): { queued: true } {
  return { queued: true };
}
