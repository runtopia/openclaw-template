import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { patchWeixinHttpRoutes } from "../scripts/patch-weixin-http-routes.js";

function writeFixture(rootDir) {
  fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "dist", "index.js"), `
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { weixinPlugin } from "./src/channel.js";
import { assertHostCompatibility } from "./src/compat.js";
import { WeixinConfigSchema } from "./src/config/config-schema.js";
export default {
    id: "openclaw-weixin",
    register(api) {
        assertHostCompatibility(api.runtime?.version);
        api.registerChannel({ plugin: weixinPlugin });
    },
};
`);
}

test("patch injects WeChat gateway HTTP route registration into published package", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-http-route-patch-"));
  try {
    writeFixture(rootDir);

    patchWeixinHttpRoutes(rootDir);

    const index = fs.readFileSync(path.join(rootDir, "dist", "index.js"), "utf8");
    const route = fs.readFileSync(path.join(rootDir, "dist", "src", "http-routes.js"), "utf8");
    assert.match(index, /import \{ registerWeixinHttpRoutes \} from "\.\/src\/http-routes\.js";/);
    assert.match(index, /registerWeixinHttpRoutes\(api\);/);
    assert.match(route, /path: "\/plugins\/openclaw-weixin"/);
    assert.match(route, /handleQrStart/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
