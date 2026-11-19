"""EC2 operations: one Isaac Sim instance + its own security group per user."""
import json
import os
import time
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

from common import ApiError, log

ec2 = boto3.client("ec2")
s3 = boto3.client("s3")

PROJECT = os.environ["PROJECT"]
BUCKET = os.environ["FILES_BUCKET"]
VPC_ID = os.environ["VPC_ID"]
SUBNETS = [s for s in os.environ["SUBNETS"].split(",") if s]
# Availability Zone of each subnet (same order as SUBNETS), only used for display
ZONES = dict(zip(SUBNETS, os.environ.get("SUBNET_ZONES", "").split(","))) if os.environ.get("SUBNET_ZONES") else {}
LT_ID = os.environ["LAUNCH_TEMPLATE_ID"]
LT_VERSION = os.environ["LAUNCH_TEMPLATE_VERSION"]
IMAGE = os.environ["ISAAC_IMAGE"]
REGION = os.environ["AWS_REGION"]
# Preferred type first, then fallback types (when capacity or quota is missing)
INSTANCE_TYPES = list(dict.fromkeys(t.strip() for t in os.environ["INSTANCE_TYPES"].split(",") if t.strip()))

ACTIVE_STATES = ["pending", "running", "stopping", "stopped"]
# Port 8210 = web viewer, 49100/tcp = WebRTC signaling, 47998/udp = WebRTC media
STREAM_PORTS = [("tcp", 8210), ("tcp", 49100), ("udp", 47998)]
# Errors on which we retry with the next subnet / instance type
RETRYABLE = {"InsufficientInstanceCapacity", "Unsupported", "InsufficientCapacity",
             "InsufficientHostCapacity", "InvalidParameterValue"}
QUOTA = {"VcpuLimitExceeded", "InstanceLimitExceeded"}
QUOTA_MSG = ("The vCPU quota for G instances is exhausted. "
             "Please increase 'Running On-Demand G and VT instances' in Service Quotas.")


def _tags(obj):
    return {t["Key"]: t["Value"] for t in obj.get("Tags", [])}


def list_instances(owner=None):
    filters = [
        {"Name": "tag:Project", "Values": [PROJECT]},
        {"Name": "instance-state-name", "Values": ACTIVE_STATES},
    ]
    if owner:
        filters.append({"Name": "tag:Owner", "Values": [owner]})
    out = []
    for page in ec2.get_paginator("describe_instances").paginate(Filters=filters):
        for res in page["Reservations"]:
            out.extend(res["Instances"])
    return out


def find_instance(owner):
    inst = list_instances(owner)
    return inst[0] if inst else None


def get_project_instance(instance_id):
    r = ec2.describe_instances(InstanceIds=[instance_id])
    for res in r["Reservations"]:
        for i in res["Instances"]:
            if _tags(i).get("Project") == PROJECT:
                return i
    raise ApiError(404, "Instance not found.")


# ---------------------------------------------------------------- Security Group
def ensure_sg(owner):
    r = ec2.describe_security_groups(Filters=[
        {"Name": "vpc-id", "Values": [VPC_ID]},
        {"Name": "tag:Project", "Values": [PROJECT]},
        {"Name": "tag:Owner", "Values": [owner]},
    ])
    if r["SecurityGroups"]:
        return r["SecurityGroups"][0]["GroupId"]
    sg = ec2.create_security_group(
        GroupName=f"{PROJECT}-{owner[:8]}-{int(time.time())}",
        Description="Isaac Sim streaming - user IP only",
        VpcId=VPC_ID,
        TagSpecifications=[{
            "ResourceType": "security-group",
            "Tags": [{"Key": "Project", "Value": PROJECT}, {"Key": "Owner", "Value": owner}],
        }],
    )
    return sg["GroupId"]


def allow_only_ip(sg_id, ip):
    """Replaces all inbound rules with the user's current IP (/32 or /128)."""
    sg = ec2.describe_security_groups(GroupIds=[sg_id])["SecurityGroups"][0]
    if sg["IpPermissions"]:
        ec2.revoke_security_group_ingress(GroupId=sg_id, IpPermissions=sg["IpPermissions"])
    v6 = ":" in ip
    perms = []
    for proto, port in STREAM_PORTS:
        p = {"IpProtocol": proto, "FromPort": port, "ToPort": port}
        if v6:
            p["Ipv6Ranges"] = [{"CidrIpv6": f"{ip}/128", "Description": "dashboard user"}]
        else:
            p["IpRanges"] = [{"CidrIp": f"{ip}/32", "Description": "dashboard user"}]
        perms.append(p)
    ec2.authorize_security_group_ingress(GroupId=sg_id, IpPermissions=perms)


def allowed_ips(sg_id):
    try:
        sg = ec2.describe_security_groups(GroupIds=[sg_id])["SecurityGroups"][0]
    except ClientError:
        return []
    ips = set()
    for p in sg["IpPermissions"]:
        ips.update(r["CidrIp"].split("/")[0] for r in p.get("IpRanges", []))
        ips.update(r["CidrIpv6"].split("/")[0] for r in p.get("Ipv6Ranges", []))
    return sorted(ips)


# ---------------------------------------------------------------- Lifecycle
def _user_data(owner):
    path = os.path.join(os.path.dirname(__file__), "userdata.sh")
    with open(path, encoding="utf-8") as f:
        script = f.read()
    for k, v in {"__OWNER__": owner, "__BUCKET__": BUCKET, "__REGION__": REGION, "__IMAGE__": IMAGE}.items():
        script = script.replace(k, v)
    return script


# ---------------------------------------------------------------- Capacity search log
# Every instance-type / zone combination that is tried is recorded, so the dashboard can show
# which ones were checked and what the result was (live, while the search is running).
RESULT_TEXT = {
    "InsufficientInstanceCapacity": "no_capacity", "InsufficientCapacity": "no_capacity",
    "InsufficientHostCapacity": "no_capacity",
    "Unsupported": "not_offered", "InvalidParameterValue": "not_offered",
    "VcpuLimitExceeded": "quota", "InstanceLimitExceeded": "quota",
}


class Search:
    """Collects the attempts of one start and writes them to the launch status in S3."""

    def __init__(self, owner, zones, types):
        self.owner = owner
        self.data = {"phase": "requesting", "detail": "Looking for free GPU capacity",
                     "ts": time.time(), "zones": zones, "types": types, "attempts": {}}

    def mark(self, itype, zone, result, code=None, save=True):
        self.data["attempts"][f"{itype}|{zone}"] = {"result": result, "code": code}
        self.data["ts"] = time.time()
        if save:
            self.save()

    def finish(self, phase, detail):
        # combinations that were never reached are shown as "not needed" / "skipped"
        for t in self.data["types"]:
            for z in self.data["zones"]:
                self.data["attempts"].setdefault(f"{t}|{z}", {"result": "not_tried", "code": None})
        self.data.update(phase=phase, detail=detail, ts=time.time())
        self.save()

    def save(self):
        try:
            s3.put_object(Bucket=BUCKET, Key=_launch_key(self.owner), ContentType="application/json",
                          Body=json.dumps(self.data))
        except ClientError as e:  # display only - never block the start because of it
            log.warning("Could not save search status: %s", e.response["Error"]["Code"])


class _NoSearch(Search):
    def __init__(self):
        super().__init__("", [], [])

    def save(self):
        pass


def launch(owner, email, search=None):
    search = search or _NoSearch()
    sg_id = ensure_sg(owner)
    tags = [
        {"Key": "Name", "Value": f"isaac-sim-{email or owner[:8]}"},
        {"Key": "Project", "Value": PROJECT},
        {"Key": "Owner", "Value": owner},
        {"Key": "OwnerEmail", "Value": email or ""},
    ]
    errors = []
    for itype in INSTANCE_TYPES:
        for i, subnet in enumerate(SUBNETS):
            zone = ZONES.get(subnet, subnet)
            search.mark(itype, zone, "trying")
            try:
                r = ec2.run_instances(
                    LaunchTemplate={"LaunchTemplateId": LT_ID, "Version": str(LT_VERSION)},
                    InstanceType=itype,
                    MinCount=1, MaxCount=1,
                    SubnetId=subnet,
                    SecurityGroupIds=[sg_id],
                    UserData=_user_data(owner),
                    TagSpecifications=[
                        {"ResourceType": "instance", "Tags": tags},
                        {"ResourceType": "volume", "Tags": tags},
                    ],
                )
                log.info("Instance launched: %s in %s", itype, zone)
                search.mark(itype, zone, "launched", save=False)
                return r["Instances"][0]
            except ClientError as e:
                code = e.response["Error"]["Code"]
                log.warning("run_instances %s in %s failed: %s", itype, zone, code)
                errors.append(code)
                search.mark(itype, zone, RESULT_TEXT.get(code, "error"), code)
                if code in QUOTA:
                    # quota is region-wide -> skip the other zones, try the next (possibly smaller) type
                    for other in SUBNETS[i + 1:]:
                        search.mark(itype, ZONES.get(other, other), "skipped_quota", save=False)
                    break
                if code not in RETRYABLE:
                    raise
    _raise_no_capacity(errors)


def _raise_no_capacity(errors):
    if errors and all(c in QUOTA for c in errors):
        raise ApiError(409, QUOTA_MSG)
    raise ApiError(503, f"No GPU capacity available right now (tried: {', '.join(INSTANCE_TYPES)}). "
                        "Please try again in a few minutes.")


def _start_stopped(inst, search=None):
    """Starts a stopped instance; switches to another instance type if there is no capacity.
    The instance stays in its Availability Zone (root volume), only the type changes."""
    search = search or _NoSearch()
    iid, current = inst["InstanceId"], inst["InstanceType"]
    zone = inst.get("Placement", {}).get("AvailabilityZone", "")
    errors = []
    for itype in _stopped_order(current):
        search.mark(itype, zone, "trying")
        try:
            if itype != current:
                ec2.modify_instance_attribute(InstanceId=iid, InstanceType={"Value": itype})
                current = itype
            ec2.start_instances(InstanceIds=[iid])
            log.info("Instance %s started as %s", iid, itype)
            search.mark(itype, zone, "launched", save=False)
            return
        except ClientError as e:
            code = e.response["Error"]["Code"]
            log.warning("Starting %s as %s failed: %s", iid, itype, code)
            errors.append(code)
            search.mark(itype, zone, RESULT_TEXT.get(code, "error"), code)
            if code not in RETRYABLE and code not in QUOTA:
                raise
    _raise_no_capacity(errors)


def _stopped_order(current):
    return [current] + [t for t in INSTANCE_TYPES if t != current]


# ---------------------------------------------------------------- Start (asynchronous)
# API Gateway HTTP APIs cut every request off after 30 s ("Service Unavailable"). Trying several
# instance types in several zones can take longer, so POST /instance/start only records a launch
# request and invokes this Lambda again asynchronously; start_worker() then does the actual work.
# The progress/result of that request lives in s3://<files>/_status/launch-<owner>.json.
LAUNCH_TIMEOUT = 600   # a request older than this counts as stale (worker crashed / timed out)
RESULT_VISIBLE = 3600  # how long the result of a start (success or failure) is shown


def _launch_key(owner):
    return f"_status/launch-{owner}.json"


def _get_launch(owner):
    try:
        data = json.loads(s3.get_object(Bucket=BUCKET, Key=_launch_key(owner))["Body"].read())
    except ClientError:
        return None
    age = time.time() - data.get("ts", 0)
    if data.get("phase") == "requesting" and age > LAUNCH_TIMEOUT:
        data.update(phase="error", detail="Starting the machine timed out. Please try again.")
    elif data.get("phase") != "requesting" and age > RESULT_VISIBLE:
        return None
    return data


def start(owner, email, ip):
    inst = find_instance(owner)
    state = inst["State"]["Name"] if inst else "none"
    if state == "stopping":
        raise ApiError(409, "The instance is currently stopping. Please wait a moment and start it again.")
    if state in ("pending", "running"):
        allow_only_ip(inst["SecurityGroups"][0]["GroupId"], ip)
        return status(owner)
    req = _get_launch(owner)
    if req and req.get("phase") == "requesting":
        return status(owner)  # a start is already in progress
    if inst:  # a stopped machine can only be started in its own zone
        zones, types = [inst.get("Placement", {}).get("AvailabilityZone", "")], _stopped_order(inst["InstanceType"])
    else:
        zones, types = [ZONES.get(sn, sn) for sn in SUBNETS], INSTANCE_TYPES
    Search(owner, zones, types).save()
    boto3.client("lambda").invoke(
        FunctionName=os.environ["AWS_LAMBDA_FUNCTION_NAME"], InvocationType="Event",
        Payload=json.dumps({"worker": "start", "owner": owner, "email": email, "ip": ip}).encode())
    return status(owner)


def start_worker(owner, email, ip):
    """Runs asynchronously (no API timeout): launches or restarts the instance with fallbacks."""
    inst = find_instance(owner)
    if inst:
        search = Search(owner, [inst.get("Placement", {}).get("AvailabilityZone", "")],
                        _stopped_order(inst["InstanceType"]))
    else:
        search = Search(owner, [ZONES.get(sn, sn) for sn in SUBNETS], INSTANCE_TYPES)
    try:
        if inst is None:
            inst = launch(owner, email, search)
        elif inst["State"]["Name"] == "stopped":
            _start_stopped(inst, search)
        allow_only_ip(inst["SecurityGroups"][0]["GroupId"], ip)
        search.finish("launched", "Machine found and started")
    except ApiError as e:
        search.finish("error", e.message)
    except Exception as e:  # noqa: BLE001 - never let the async invoke retry (it would launch twice)
        log.exception("Start worker failed")
        search.finish("error", f"Internal error while starting: {e.__class__.__name__}")


def stop(owner):
    inst = find_instance(owner)
    if not inst:
        raise ApiError(404, "No instance exists.")
    if inst["State"]["Name"] in ("running", "pending"):
        stop_instance(inst)
    return status(owner)


def _delete_status(*keys):
    for key in keys:
        try:
            s3.delete_object(Bucket=BUCKET, Key=key)
        except ClientError:
            pass


def _reset_search(inst):
    """Stopping or deleting a machine resets the capacity search shown in the dashboard."""
    owner = _tags(inst).get("Owner")
    if owner:
        _delete_status(_launch_key(owner))


def stop_instance(inst):
    ec2.stop_instances(InstanceIds=[inst["InstanceId"]])
    _reset_search(inst)


def terminate_instance(inst):
    iid = inst["InstanceId"]
    ec2.terminate_instances(InstanceIds=[iid])
    _delete_status(f"_status/{iid}.json", f"_status/{iid}.log")
    _reset_search(inst)
    # The security group is deleted by the AutoStop job once it is free.


def terminate(owner):
    inst = find_instance(owner)
    if not inst:
        raise ApiError(404, "No instance exists.")
    terminate_instance(inst)
    return {"state": "shutting-down"}


def allow_ip(owner, ip):
    inst = find_instance(owner)
    if not inst:
        raise ApiError(404, "No instance exists.")
    allow_only_ip(inst["SecurityGroups"][0]["GroupId"], ip)
    return status(owner)


def _boot_status(inst):
    """Phase from the status object the instance itself writes to S3."""
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=f"_status/{inst['InstanceId']}.json")
        data = json.loads(obj["Body"].read())
    except ClientError:
        return {"phase": "booting", "detail": "Operating system is starting"}
    launched = inst["LaunchTime"].timestamp()
    if data.get("ts", 0) < launched:  # status is from an earlier start
        return {"phase": "booting", "detail": "Operating system is starting"}
    return {"phase": data.get("phase"), "detail": data.get("detail"), "phaseSince": data.get("ts")}


def boot_log(owner):
    """Last lines of the boot log the instance uploads to S3 every 15 s."""
    inst = find_instance(owner)
    if not inst:
        raise ApiError(404, "No instance exists.")
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=f"_status/{inst['InstanceId']}.log")
    except ClientError:
        return {"log": "", "updated": None}
    if obj["LastModified"] < inst["LaunchTime"]:  # log is from an earlier start
        return {"log": "", "updated": None}
    return {"log": obj["Body"].read().decode("utf-8", "replace"), "updated": obj["LastModified"].isoformat()}


def describe(inst):
    state = inst["State"]["Name"]
    t = _tags(inst)
    out = {
        "state": state,
        "instanceId": inst["InstanceId"],
        "instanceType": inst["InstanceType"],
        "zone": inst.get("Placement", {}).get("AvailabilityZone"),
        "publicIp": inst.get("PublicIpAddress"),
        "launchTime": inst["LaunchTime"].isoformat(),
        "owner": t.get("Owner"),
        "ownerEmail": t.get("OwnerEmail"),
        "runningHours": None,
    }
    if state == "running":
        out["runningHours"] = round(
            (datetime.now(timezone.utc) - inst["LaunchTime"]).total_seconds() / 3600, 2)
        out.update(_boot_status(inst))
        if out.get("phase") == "ready" and out["publicIp"]:
            out["viewerUrl"] = f"http://{out['publicIp']}:8210"
    return out


def status(owner):
    inst = find_instance(owner)
    state = inst["State"]["Name"] if inst else "none"
    req = _get_launch(owner)
    search = None
    if req and req.get("attempts") is not None:
        search = {k: req.get(k) for k in ("phase", "detail", "ts", "zones", "types", "attempts")}
    if req and req.get("phase") == "requesting" and state in ("none", "stopped"):
        return {"state": "requesting", "detail": req.get("detail"), "search": search,
                "instanceType": inst["InstanceType"] if inst else None,
                "maxSessionHours": float(os.environ.get("MAX_SESSION_HOURS", "8"))}
    last_error = req.get("detail") if req and req.get("phase") == "error" and state in ("none", "stopped") else None
    if not inst:
        return {"state": "none", "lastError": last_error, "search": search}
    out = describe(inst)
    out["lastError"] = last_error
    out["search"] = search
    out["allowedIps"] = allowed_ips(inst["SecurityGroups"][0]["GroupId"])
    out["signalPort"], out["streamPort"] = 49100, 47998
    out["maxSessionHours"] = float(os.environ.get("MAX_SESSION_HOURS", "8"))
    return out
