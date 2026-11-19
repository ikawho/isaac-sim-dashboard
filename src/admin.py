"""Routes /me and /admin/* - user and instance management for the 'admins' group."""
import os

import boto3
from botocore.exceptions import ClientError

import ec2ops
from common import ApiError, body, is_admin, require_admin, route, user_sub, username, wrap

POOL = os.environ["USER_POOL_ID"]
BUCKET = os.environ["FILES_BUCKET"]
cognito = boto3.client("cognito-idp")
s3 = boto3.client("s3")


def _attr(user, name):
    attrs = user.get("Attributes") or user.get("UserAttributes") or []
    return next((a["Value"] for a in attrs if a["Name"] == name), None)


def _admin_names():
    names = set()
    for page in cognito.get_paginator("list_users_in_group").paginate(UserPoolId=POOL, GroupName="admins"):
        names.update(u["Username"] for u in page["Users"])
    return names


def _list_users():
    admins = _admin_names()
    inst_by_owner = {ec2ops._tags(i).get("Owner"): i["State"]["Name"] for i in ec2ops.list_instances()}
    users = []
    for page in cognito.get_paginator("list_users").paginate(UserPoolId=POOL):
        for u in page["Users"]:
            sub = _attr(u, "sub")
            users.append({
                "username": u["Username"], "email": _attr(u, "email"), "sub": sub,
                "status": u["UserStatus"], "enabled": u["Enabled"],
                "created": u["UserCreateDate"].isoformat(),
                "admin": u["Username"] in admins,
                "instance": inst_by_owner.get(sub, "none"),
            })
    users.sort(key=lambda x: (x["email"] or "").lower())
    return users


def _delete_user_data(sub):
    inst = ec2ops.find_instance(sub)
    if inst:
        ec2ops.terminate_instance(inst)
    prefix = f"users/{sub}/"
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
        keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
        if keys:
            s3.delete_objects(Bucket=BUCKET, Delete={"Objects": keys, "Quiet": True})


def _handle(event):
    r = route(event)
    if r == "GET /me":
        return 200, {"sub": user_sub(event), "username": username(event), "admin": is_admin(event)}

    require_admin(event)
    params = event.get("pathParameters") or {}

    if r == "GET /admin/users":
        return 200, {"users": _list_users()}

    if r == "POST /admin/users":
        b = body(event)
        email = (b.get("email") or "").strip().lower()
        if "@" not in email:
            raise ApiError(400, "Please enter a valid email address.")
        try:
            u = cognito.admin_create_user(
                UserPoolId=POOL, Username=email, DesiredDeliveryMediums=["EMAIL"],
                UserAttributes=[{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"}])
        except cognito.exceptions.UsernameExistsException:
            raise ApiError(409, "This email address is already registered.")
        if b.get("admin"):
            cognito.admin_add_user_to_group(UserPoolId=POOL, Username=u["User"]["Username"], GroupName="admins")
        return 201, {"username": u["User"]["Username"], "email": email}

    if r == "POST /admin/users/{username}":
        name, b = params["username"], body(event)
        if name == username(event) and (b.get("admin") is False or b.get("enabled") is False):
            raise ApiError(400, "You cannot remove your own admin rights or disable your own account.")
        if "admin" in b:
            fn = cognito.admin_add_user_to_group if b["admin"] else cognito.admin_remove_user_from_group
            fn(UserPoolId=POOL, Username=name, GroupName="admins")
        if "enabled" in b:
            fn = cognito.admin_enable_user if b["enabled"] else cognito.admin_disable_user
            fn(UserPoolId=POOL, Username=name)
        return 200, {"updated": True}

    if r == "DELETE /admin/users/{username}":
        name = params["username"]
        if name == username(event):
            raise ApiError(400, "You cannot delete your own account.")
        try:
            u = cognito.admin_get_user(UserPoolId=POOL, Username=name)
        except ClientError:
            raise ApiError(404, "User not found.")
        sub = _attr(u, "sub")
        if sub:
            _delete_user_data(sub)
        cognito.admin_delete_user(UserPoolId=POOL, Username=name)
        return 200, {"deleted": True}

    if r == "GET /admin/instances":
        return 200, {"instances": [ec2ops.describe(i) for i in ec2ops.list_instances()]}

    if r == "POST /admin/instances/{id}/{action}":
        inst = ec2ops.get_project_instance(params["id"])
        action = params["action"]
        if action == "stop":
            ec2ops.stop_instance(inst)
        elif action == "terminate":
            ec2ops.terminate_instance(inst)
        else:
            raise ApiError(400, "Action must be 'stop' or 'terminate'.")
        return 200, {"ok": True}

    raise ApiError(404, "Unknown route.")


handler = wrap(_handle)
