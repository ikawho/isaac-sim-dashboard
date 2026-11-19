"""Routes /files* - private file storage per user under s3://<bucket>/users/<sub>/"""
import os
import posixpath

import boto3
from botocore.config import Config

from common import ApiError, body, route, user_sub, wrap

REGION = os.environ["AWS_REGION"]
BUCKET = os.environ["FILES_BUCKET"]
s3 = boto3.client("s3", region_name=REGION,
                  endpoint_url=f"https://s3.{REGION}.amazonaws.com",
                  config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))


def _key(owner, rel):
    rel = (rel or "").strip().lstrip("/")
    norm = posixpath.normpath(rel)
    if not rel or norm.startswith("..") or norm in (".", "") or len(norm) > 900:
        raise ApiError(400, "Invalid file name.")
    return f"users/{owner}/{norm}"


def _handle(event):
    owner = user_sub(event)
    prefix = f"users/{owner}/"
    r = route(event)
    qs = event.get("queryStringParameters") or {}

    if r == "GET /files":
        files = []
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
            for o in page.get("Contents", []):
                files.append({"name": o["Key"][len(prefix):], "size": o["Size"],
                              "lastModified": o["LastModified"].isoformat()})
        files.sort(key=lambda f: f["name"].lower())
        return 200, {"files": files}

    if r == "POST /files/upload-url":
        key = _key(owner, body(event).get("name"))
        url = s3.generate_presigned_url("put_object", Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=900)
        return 200, {"url": url}

    if r == "GET /files/download-url":
        key = _key(owner, qs.get("name"))
        fname = posixpath.basename(key).replace('"', "")
        url = s3.generate_presigned_url("get_object", ExpiresIn=900, Params={
            "Bucket": BUCKET, "Key": key,
            "ResponseContentDisposition": f'attachment; filename="{fname}"'})
        return 200, {"url": url}

    if r == "DELETE /files":
        s3.delete_object(Bucket=BUCKET, Key=_key(owner, qs.get("name")))
        return 200, {"deleted": True}

    raise ApiError(404, "Unknown route.")


handler = wrap(_handle)
