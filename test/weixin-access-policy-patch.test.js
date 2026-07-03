import test from "node:test";
import assert from "node:assert/strict";

import { patchWeixinProcessMessageSource } from "../scripts/patch-weixin-access-policy.js";

const tsFixture = `
  const rawBody = ctx.Body?.trim() ?? "";
  ctx.CommandBody = rawBody;

  const senderId = full.from_user_id ?? "";

  const { senderAllowedForCommands, commandAuthorized } =
    await resolveSenderCommandAuthorizationWithRuntime({
      cfg: deps.config,
      rawBody,
      isGroup: false,
      dmPolicy: "pairing",
      configuredAllowFrom: [],
      configuredGroupAllowFrom: [],
      senderId,
      isSenderAllowed: (id: string, list: string[]) => list.length === 0 || list.includes(id),
      readAllowFromStore: async () => {
        const fromStore = readFrameworkAllowFromList(deps.accountId);
        if (fromStore.length > 0) return fromStore;
        const uid = loadWeixinAccount(deps.accountId)?.userId?.trim();
        return uid ? [uid] : [];
      },
      runtime: deps.channelRuntime.commands,
    });

  const directDmOutcome = resolveDirectDmAuthorizationOutcome({
    isGroup: false,
    dmPolicy: "pairing",
    senderAllowedForCommands,
  });
`;

test("patch reads WeChat access policy from channel and account config", () => {
  const patched = patchWeixinProcessMessageSource(tsFixture);

  assert.match(patched, /const channelConfig = deps\.config\.channels\?\.\["openclaw-weixin"\] \?\? \{\};/);
  assert.match(patched, /const accountConfig = channelConfig\.accounts\?\.\[deps\.accountId\] \?\? \{\};/);
  assert.match(patched, /const configuredDmPolicy = accessConfig\.dmPolicy \?\? "pairing";/);
  assert.match(patched, /const configuredAllowFrom = Array\.isArray\(accessConfig\.allowFrom\) \? accessConfig\.allowFrom : \[\];/);
  assert.doesNotMatch(patched, /dmPolicy: "pairing"/);
  assert.match(patched, /dmPolicy: configuredDmPolicy/);
  assert.match(patched, /configuredAllowFrom,/);
});

test("patch treats wildcard as public access but not empty allowlist", () => {
  const patched = patchWeixinProcessMessageSource(tsFixture);

  assert.doesNotMatch(patched, /list\.length === 0 \|\| list\.includes\(id\)/);
  assert.match(patched, /list\.includes\("\*"\) \|\| list\.includes\(id\)/);
});
