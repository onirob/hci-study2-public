from typing import Tuple
from .config import settings
from hashlib import sha256
from fastapi import Request

def parse_cuts() -> Tuple[float,float]:
    parts = [p.strip() for p in settings.strat_cuts.split(',') if p.strip()]
    if len(parts) != 2:
        return (33.0, 66.0)
    c1, c2 = float(parts[0]), float(parts[1])
    return (c1, c2)

def client_ip(request: Request) -> str:
    xf = request.headers.get("x-forwarded-for")
    return (xf.split(",")[0].strip() if xf else request.client.host)

def ip_hash(request: Request) -> str:
    ip = client_ip(request)
    return sha256((settings.IP_HASH_SALT + ip).encode()).hexdigest()