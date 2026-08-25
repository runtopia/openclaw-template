#!/usr/bin/env python3
"""Deterministic OneClaw Gmail workflow client."""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request


PROXY_URL = os.environ.get(
    "ONECLAW_GMAIL_PROXY_URL",
    "http://127.0.0.1:8080/internal/integrations/gmail/invoke",
)
METHODS = {
    "latest_emails",
    "search_emails",
    "search_email_ids",
    "read_email",
    "get_attachment",
}


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("method", choices=sorted(METHODS))
    value.add_argument("--query")
    value.add_argument("--max-results", type=int, dest="max_results")
    value.add_argument("--message-id", dest="message_id")
    value.add_argument("--attachment-id", dest="attachment_id")
    value.add_argument("--file-name", dest="file_name")
    return value


def request_payload(arguments: argparse.Namespace) -> dict:
    params = {
        key: value
        for key, value in {
            "query": arguments.query,
            "max_results": arguments.max_results,
            "message_id": arguments.message_id,
            "attachment_id": arguments.attachment_id,
            "file_name": arguments.file_name,
        }.items()
        if value is not None
    }
    return {"method": arguments.method, "params": params}


def invoke(payload: dict) -> tuple[int, dict]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        PROXY_URL,
        data=body,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=70) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {"error": "gmail_request_failed"}
    except (urllib.error.URLError, TimeoutError, OSError):
        return 502, {"error": "gmail_proxy_unavailable"}


def error_code(result: dict) -> str:
    error = result.get("error")
    if isinstance(error, dict):
        return str(error.get("code") or "")
    return str(error or "")


def main() -> int:
    arguments = parser().parse_args()
    status, result = invoke(request_payload(arguments))
    if 200 <= status < 300:
        print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
        return 0

    code = error_code(result)
    if status in {404, 409} or code in {
        "integration_not_found",
        "integration_default_agent_required",
        "integration_expired",
    }:
        output = {
            "ok": False,
            "code": "authorization_required",
            "message": "Gmail is not connected to the default agent. Request Gmail authorization through OneClaw, then retry the same command.",
        }
    elif status == 400:
        output = {
            "ok": False,
            "code": "invalid_request",
            "message": "The Gmail workflow parameters are invalid.",
        }
    else:
        output = {
            "ok": False,
            "code": "temporarily_unavailable",
            "message": "The Gmail service is temporarily unavailable. Retry once later.",
        }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
