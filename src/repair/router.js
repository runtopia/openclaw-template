import express from "express";
import { mountAssistant } from "./assistant.js";
import { mountQrLogin } from "./qr-login.js";
import { mountConfigOps } from "./config-ops.js";

export function createRepairRouter(deps) {
  const router = express.Router();
  mountConfigOps(router, deps);
  mountQrLogin(router, deps);
  mountAssistant(router, deps);
  return router;
}
