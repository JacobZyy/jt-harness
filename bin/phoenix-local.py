"""Use Phoenix's official CLI with its unused wildcard gRPC listener disabled."""

from phoenix.server.grpc_server import GrpcServer
import sys
from phoenix.server.main import main

# ponytail: Phoenix 20.14 binds gRPC to [::] and has no CLI host/disable setting.
# Reuse its existing disabled argument; remove this adapter when upstream exposes it.
original_init = GrpcServer.__init__


def http_only_init(self, *args, **kwargs):
    kwargs["disabled"] = True
    original_init(self, *args, **kwargs)


GrpcServer.__init__ = http_only_init

if __name__ == "__main__":
    sys.exit(main())
