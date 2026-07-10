import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { patchWeixinHttpRoutes } from "../scripts/patch-weixin-http-routes.js";

function writeFixture(rootDir) {
  fs.mkdirSync(path.join(rootDir, "dist", "src", "auth"), { recursive: true });
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
  fs.writeFileSync(path.join(rootDir, "dist", "src", "auth", "login-qr.js"), `
const activeLogins = new Map();
async function pollQRStatus() { return { status: "wait" }; }
async function refreshQRCode(activeLogin, botType, qrRefreshCount, onScannedReset) {
        activeLogin.startedAt = Date.now();
        onScannedReset();
    return { success: true };
}
export async function waitForWeixinLogin(opts) {
    const activeLogin = activeLogins.get(opts.sessionKey);
    const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1000);
    const deadline = Date.now() + timeoutMs;
    let scannedPrinted = false;
    let qrRefreshCount = 1;
    while (Date.now() < deadline) {
        const currentBaseUrl = "https://ilinkai.weixin.qq.com";
        const statusResponse = await pollQRStatus(currentBaseUrl, activeLogin.qrcode, activeLogin.pendingVerifyCode);
        switch (statusResponse.status) {
            case "expired": {
                const expiredRefreshResult = await refreshQRCode(activeLogin, opts.botType || "3", qrRefreshCount, () => { scannedPrinted = false; });
                if (!expiredRefreshResult.success) return { connected: false, message: expiredRefreshResult.message };
                break;
            }
            case "verify_code_blocked": {
                const blockedRefreshResult = await refreshQRCode(activeLogin, opts.botType || "3", qrRefreshCount, () => { scannedPrinted = false; });
                if (!blockedRefreshResult.success) return { connected: false, message: blockedRefreshResult.message };
                break;
            }
        }
    }
    activeLogins.delete(opts.sessionKey);
    return { connected: false, message: "登录超时，请重试。" };
}
`);
}

test("patch injects WeChat gateway HTTP route registration into published package", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-http-route-patch-"));
  try {
    writeFixture(rootDir);

    patchWeixinHttpRoutes(rootDir);

    const index = fs.readFileSync(path.join(rootDir, "dist", "index.js"), "utf8");
    const route = fs.readFileSync(path.join(rootDir, "dist", "src", "http-routes.js"), "utf8");
    const loginQrPath = path.join(rootDir, "dist", "src", "auth", "login-qr.js");
    const loginQr = fs.readFileSync(loginQrPath, "utf8");
    assert.match(index, /import \{ registerWeixinHttpRoutes \} from "\.\/src\/http-routes\.js";/);
    assert.match(index, /registerWeixinHttpRoutes\(api\);/);
    assert.match(route, /path: "\/plugins\/openclaw-weixin"/);
    assert.match(route, /handleQrStart/);
    assert.match(route, /handleQrStop/);
    assert.match(route, /qrDataUrl: session\.qrDataUrl/);
    assert.match(route, /waiterStarted/);
    assert.match(loginQr, /opts\.isCancelled/);
    assert.match(loginQr, /opts\.deadlineAt/);
    assert.match(loginQr, /opts\.onQrRefreshed/);

    const firstIndex = index;
    const firstRoute = route;
    const firstLoginQr = loginQr;
    patchWeixinHttpRoutes(rootDir);
    assert.equal(fs.readFileSync(path.join(rootDir, "dist", "index.js"), "utf8"), firstIndex);
    assert.equal(fs.readFileSync(path.join(rootDir, "dist", "src", "http-routes.js"), "utf8"), firstRoute);
    assert.equal(fs.readFileSync(loginQrPath, "utf8"), firstLoginQr);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
