"""Routes /instance/* - every user manages their own Isaac Sim instance."""
import os

import boto3
from botocore.exceptions import ClientError

import ec2ops
from common import ApiError, route, source_ip, user_sub, username, wrap

cognito = boto3.client("cognito-idp")


def _email(event):
    try:
        u = cognito.admin_get_user(UserPoolId=os.environ["USER_POOL_ID"], Username=username(event))
        return next((a["Value"] for a in u["UserAttributes"] if a["Name"] == "email"), "")
    except ClientError:
        return ""


def _handle(event):
    owner = user_sub(event)
    r = route(event)
    if r == "GET /instance":
        return 200, ec2ops.status(owner)
    if r == "GET /instance/log":
        return 200, ec2ops.boot_log(owner)
    if r == "POST /instance/start":
        return 200, ec2ops.start(owner, _email(event), source_ip(event))
    if r == "POST /instance/stop":
        return 200, ec2ops.stop(owner)
    if r == "POST /instance/terminate":
        return 200, ec2ops.terminate(owner)
    if r == "POST /instance/allow-ip":
        return 200, ec2ops.allow_ip(owner, source_ip(event))
    raise ApiError(404, "Unknown route.")


_api_handler = wrap(_handle)


def handler(event, context):
    if event.get("worker") == "start":  # asynchronous self-invocation from ec2ops.start()
        ec2ops.start_worker(event["owner"], event.get("email", ""), event["ip"])
        return {"ok": True}
    return _api_handler(event, context)
