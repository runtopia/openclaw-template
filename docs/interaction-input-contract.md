# Runtime Structured Input Contract

This document locks the template-side contract consumed by `oneclaw_api`.

## Endpoint

```http
POST /repair/interactions/input
Authorization: Bearer <ONECLAW_INSTANCE_SECRET>
Content-Type: application/json
```

Browser sessions and `OPENCLAW_GATEWAY_TOKEN` are not accepted.

## Request

```json
{
  "sessionKey": "agent:main:main",
  "runId": "run-uuid",
  "toolCallId": "tool-call-uuid",
  "answers": [
    {
      "questionId": "audience",
      "selected": ["Executives"],
      "custom": "Optional free-form detail"
    }
  ]
}
```

Fields:

- `sessionKey` is optional. It may be supplied for event-envelope compatibility
  but is only validated and then ignored by the template; it is not part of
  broker lookup or idempotency. The OpenClaw tool execution contract gives the
  plugin a `toolCallId`, not a reliable session key.
- `runId` is required, non-empty, and at most 200 characters.
- `toolCallId` is required, non-empty, and at most 200 characters. It is the
  broker lookup key within one runtime instance.
- `answers` contains one to four entries with unique `questionId` values.

Each answer has this exact normalized shape:

```ts
type RuntimeInputAnswer = {
  questionId: string;  // required, 1..80 characters
  selected: string[];  // required, 0..12 unique values, each 1..160 characters
  custom?: string;     // optional, non-empty when present, max 2000 characters
  skipped?: true;      // optional; mutually exclusive with selected/custom
};
```

At least one of a non-empty `selected`, a non-empty `custom`, or
`skipped: true` is required.

The API must preserve the original order of both `answers` and each `selected`
array. It must not sort either array. The template trims and validates values
but also preserves array order; it performs the final exact-retry comparison
against those normalized ordered arrays.

## Success and idempotency

Delivery is synchronous, so success always uses HTTP `200`, never `202`.

First successful submission:

```json
{ "ok": true, "status": "submitted" }
```

An exact retry with the same `runId`, `toolCallId`, and normalized `answers` is
idempotent:

```json
{ "ok": true, "status": "already_submitted" }
```

`sessionKey` does not affect idempotency.
Reordering `answers` or any `selected` array is not an exact retry and returns
`409 INTERACTION_ALREADY_ANSWERED`.

## Errors

| HTTP | Body | Meaning |
|---|---|---|
| `400` | `{"ok":false,"error":"INVALID_REQUEST","message":"..."}` | Malformed identifiers or answers |
| `401` | `{"ok":false,"error":"unauthorized"}` | Missing or incorrect instance secret |
| `404` | `{"ok":false,"error":"INTERACTION_NOT_FOUND"}` | No active or remembered interaction for the tool call |
| `409` | `{"ok":false,"error":"INTERACTION_ALREADY_ANSWERED"}` | The tool call was answered with a different run or answer payload |
| `410` | `{"ok":false,"error":"INTERACTION_EXPIRED"}` | The known plugin wait timed out or was cancelled |
| `503` | error string | Instance-secret auth or the local broker is unavailable |

Before returning `404`, the template waits up to one second for the plugin's
loopback request to register. This absorbs the event-to-broker startup race;
the API does not need to interpret `202` or maintain an early-answer queue.

Answered and expired terminal records are in-memory and retained for one hour.
After retention expires, or after the runtime restarts, the same identifier
returns `404`. This is intentional because the original plugin wait no longer
exists.
