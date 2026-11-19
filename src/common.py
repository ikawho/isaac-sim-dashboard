"""Shared helpers for the Lambda handlers."""
import json
import logging

log = logging.getLogger()
log.setLevel(logging.INFO)


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def claims(event):
    return event["requestContext"]["authorizer"]["jwt"]["claims"]


def user_sub(event):
    return claims(event)["sub"]


def username(event):
    c = claims(event)
    return c.get("username") or c.get("cognito:username") or c["sub"]


def groups(event):
    g = claims(event).get("cognito:groups", "")
    if isinstance(g, list):
        return g
    # The HTTP API JWT authorizer delivers arrays as a string "[admins other]"
    return [x for x in g.strip("[]").replace(",", " ").split() if x]


def is_admin(event):
    return "admins" in groups(event)


def require_admin(event):
    if not is_admin(event):
        raise ApiError(403, "Only administrators are allowed to do this.")


def source_ip(event):
    return event["requestContext"]["http"]["sourceIp"]


def body(event):
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64
        raw = base64.b64decode(raw).decode()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise ApiError(400, "Invalid JSON in request body.")


def route(event):
    """e.g. 'POST /instance/start'"""
    return event["routeKey"]


def wrap(fn):
    def handler(event, context):
        try:
            status, payload = fn(event)
            return resp(status, payload)
        except ApiError as e:
            return resp(e.status, {"error": e.message})
        except Exception as e:  # noqa: BLE001
            log.exception("Unexpected error")
            return resp(500, {"error": f"Internal error: {e.__class__.__name__}"})
    return handler
