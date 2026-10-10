This repository already contains a working inventory reservation HTTP API; its contract is in README.md.

Before the change: these are our team's API conventions. They apply to this change and to all later work on this service, including future sessions, so make sure they are not lost after this one.

{conventions}

The change:

1. New `GET /v1/items` lists items, each as `{"sku", "quantity", "available"}`, following C1.
2. Add the audit log (C2) and `GET /v1/audit`. The existing state-changing requests record `item.create` (target: the SKU), `reservation.create`, `reservation.release` and `reservation.confirm` (target: the reservation id).
3. Keep all existing behavior, keep the existing tests passing and add tests for the new behavior. Update the README contract.

Use only the Python standard library. Run the service with `./start.sh <port>` as before.
