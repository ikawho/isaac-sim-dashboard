"""Scheduled (every 15 min): stops instances that have run too long and cleans up orphaned security groups."""
import os
from datetime import datetime, timezone

from botocore.exceptions import ClientError

import ec2ops
from common import log

MAX_HOURS = float(os.environ.get("MAX_SESSION_HOURS", "8"))


def handler(event, context):
    now = datetime.now(timezone.utc)
    stopped = []
    owners_active = set()
    for inst in ec2ops.list_instances():
        owners_active.add(ec2ops._tags(inst).get("Owner"))
        if inst["State"]["Name"] == "running":
            hours = (now - inst["LaunchTime"]).total_seconds() / 3600
            if hours >= MAX_HOURS:
                ec2ops.stop_instance(inst)
                stopped.append(inst["InstanceId"])

    deleted = []
    sgs = ec2ops.ec2.describe_security_groups(Filters=[
        {"Name": "vpc-id", "Values": [ec2ops.VPC_ID]},
        {"Name": "tag:Project", "Values": [ec2ops.PROJECT]},
    ])["SecurityGroups"]
    for sg in sgs:
        if ec2ops._tags(sg).get("Owner") in owners_active:
            continue
        try:
            ec2ops.ec2.delete_security_group(GroupId=sg["GroupId"])
            deleted.append(sg["GroupId"])
        except ClientError as e:  # e.g. still attached to a terminating instance
            log.info("SG %s cannot be deleted yet: %s", sg["GroupId"], e.response["Error"]["Code"])

    log.info("stopped=%s deleted_sgs=%s", stopped, deleted)
    return {"stopped": stopped, "deletedSecurityGroups": deleted}
