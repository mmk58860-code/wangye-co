#!/usr/bin/env python3
import argparse
import json
import sys


def make_subtensor(endpoint):
    import bittensor as bt

    cls = getattr(bt, "Subtensor", None) or getattr(bt, "subtensor")
    return cls(network=endpoint)


def as_number(value):
    if value is None:
        return None
    if hasattr(value, "tao"):
        return float(value.tao)
    if hasattr(value, "value"):
        return as_number(value.value)
    try:
        return float(value)
    except Exception:
        try:
            return float(str(value).replace(",", ""))
        except Exception:
            return None


def human_name(dynamic):
    ident = getattr(dynamic, "subnet_identity", None)
    if ident and getattr(ident, "subnet_name", None):
        return ident.subnet_name
    return getattr(dynamic, "subnet_name", None) or f"Subnet {getattr(dynamic, 'netuid', '')}"


def rpc_request(sub, method, params=None):
    try:
        result = sub.substrate.rpc_request(method=method, params=params or [])
        if isinstance(result, dict) and "result" in result:
            return result["result"]
        return result
    except Exception:
        return None


def first_attr(obj, names):
    for name in names:
        if hasattr(obj, name):
            value = getattr(obj, name)
            if value is not None:
                return value
    return None


def get_immunity_period(sub, netuid):
    try:
        return int(sub.immunity_period(netuid))
    except Exception:
        pass
    for method_name in ("get_subnet_hyperparameters", "get_subnet_hyperparams"):
        try:
            method = getattr(sub, method_name)
            params = method(netuid)
            value = first_attr(params, ("immunity_period", "immunityPeriod"))
            if value is not None:
                return int(as_number(value))
        except Exception:
            pass
    try:
        value = sub.substrate.query("SubtensorModule", "ImmunityPeriod", [netuid])
        if value is not None:
            return int(as_number(value))
    except Exception:
        pass
    return None


def get_network_immunity_period(sub):
    for storage_name in ("NetworkImmunityPeriod", "SubnetImmunityPeriod"):
        try:
            value = sub.substrate.query("SubtensorModule", storage_name)
            if value is not None:
                parsed = as_number(value)
                if parsed is not None:
                    return int(parsed)
        except Exception:
            pass
    for method in ("subnetInfo_getNetworkImmunityPeriod", "subnetInfo_getSubnetImmunityPeriod"):
        value = rpc_request(sub, method)
        parsed = as_number(value)
        if parsed is not None:
            return int(parsed)
    # Network subnet deregistration immunity is distinct from miner immunity.
    # Current Bittensor docs describe this as a four-month protection window.
    return 864000


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--block-time-ms", type=int, default=12000)
    args = parser.parse_args()

    try:
        sub = make_subtensor(args.endpoint)
        current_block = int(sub.block)
        try:
            registration_cost = as_number(sub.get_subnet_burn_cost())
        except Exception:
            registration_cost = as_number(rpc_request(sub, "subnetInfo_getLockCost"))

        dynamic = sub.all_subnets() or []
        network_immunity_period = get_network_immunity_period(sub)
        next_prune = rpc_request(sub, "subnetInfo_getSubnetToPrune")
        if isinstance(next_prune, str):
            try:
                next_prune = int(next_prune, 16) if next_prune.startswith("0x") else int(next_prune)
            except Exception:
                pass

        subnets = []
        immunity_cache = {}
        for item in dynamic:
            netuid = int(getattr(item, "netuid"))
            if netuid == 0:
                continue
            if netuid not in immunity_cache:
                immunity_cache[netuid] = get_immunity_period(sub, netuid)
            registration_block = first_attr(item, (
                "network_registered_at",
                "registration_block",
                "registrationBlock",
                "registered_at",
                "created_at_block",
                "createdAtBlock",
            ))
            subnets.append({
                "netuid": netuid,
                "name": human_name(item),
                "alphaPrice": as_number(getattr(item, "price", None)),
                "emaPrice": as_number(getattr(item, "moving_price", None)),
                "registrationCost": registration_cost,
                "registrationBlock": as_number(registration_block),
                "immunityPeriod": network_immunity_period,
                "minerImmunityPeriod": immunity_cache[netuid],
                "rawVolume": as_number(getattr(item, "subnet_volume", None)),
                "volume24h": None,
                "volume1h": None,
                "symbol": getattr(item, "symbol", None),
                "tempo": as_number(getattr(item, "tempo", None)),
                "lastStep": as_number(getattr(item, "last_step", None)),
                "alphaIn": as_number(getattr(item, "alpha_in", None)),
                "alphaOut": as_number(getattr(item, "alpha_out", None)),
                "taoIn": as_number(getattr(item, "tao_in", None))
            })

        output = {
            "currentBlock": current_block,
            "registrationCost": registration_cost,
            "immunityPeriod": network_immunity_period,
            "nextPruneCandidate": next_prune,
            "subnets": sorted(subnets, key=lambda x: x["netuid"])
        }
        print(json.dumps(output, ensure_ascii=False))
        try:
            sub.close()
        except Exception:
            pass
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
