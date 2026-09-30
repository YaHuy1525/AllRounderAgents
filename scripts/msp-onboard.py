"""Wire a fresh MSP tenant: the connection row, client refs and vendors.

Writes the same three tables the console edits through the API
(``msp_connections``, ``msp_clients`` and ``msp_vendors``), then reads them
back so the summary reflects what the desk can actually see. Vendor rows are
what the bills lane checks senders against and what its bank-detail change
detection compares extractions to. The tenant itself and its first console
user live in Supabase Auth: create those in the dashboard and stamp
``tenant_id`` plus ``roles`` into ``app_metadata`` before running this.
Fields you omit keep their stored value; pass an empty string to clear one.

Usage (repo root, .env with DATABASE_URL):
    python scripts/msp-onboard.py --tenant mspco --domain in.mspco.example
    python scripts/msp-onboard.py --tenant mspco --domain in.mspco.example \
        --name "MSP desk" --client acme --client-name "Acme Support" \
        --client-project ACME --client-email help@acme.example \
        --vendor acmepower --vendor-name "Acme Power Pty Ltd" \
        --vendor-email billing@acmepower.example --vendor-bsb 012-345 \
        --vendor-account 12345678
"""

from __future__ import annotations

import argparse
import re
import sys

import psycopg
from allrounder_api.settings import Settings

# Mirrors the migration's constraints and the API's field caps, so anything
# this script accepts stays editable in Settings afterwards.
_DOMAIN_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$")
_CLIENT_REF_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,63}$")
_VENDOR_REF_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Wire an MSP tenant: connection, client refs and vendors."
    )
    parser.add_argument("--tenant", required=True, help="tenant id, as stamped into app_metadata")
    parser.add_argument(
        "--domain", required=True, help="inbound mail domain, e.g. in.mspco.example"
    )
    parser.add_argument("--name", default=None, help="display name for the connection")
    parser.add_argument("--client", default="", help="client ref to register, e.g. acme")
    parser.add_argument("--client-name", default=None, help="client display name")
    parser.add_argument("--client-project", default=None, help="desk ticket project, e.g. ACME")
    parser.add_argument("--client-email", default=None, help="client contact email")
    parser.add_argument("--vendor", default="", help="vendor ref to register, e.g. acmepower")
    parser.add_argument("--vendor-name", default=None, help="vendor display name")
    parser.add_argument(
        "--vendor-email",
        action="append",
        default=None,
        help="vendor sender address; repeatable, required with --vendor",
    )
    parser.add_argument("--vendor-account", default=None, help="bank account name")
    parser.add_argument("--vendor-bsb", default=None, help="bank BSB")
    parser.add_argument("--vendor-account-number", default=None, help="bank account number")
    args = parser.parse_args()

    tenant = args.tenant.strip()
    domain = args.domain.strip().lower()
    name = None if args.name is None else args.name.strip()
    client_ref = args.client.strip().lower()
    client_name = None if args.client_name is None else args.client_name.strip()
    client_project = None if args.client_project is None else args.client_project.strip()
    client_email = None if args.client_email is None else args.client_email.strip()
    vendor_ref = args.vendor.strip().lower()
    vendor_name = None if args.vendor_name is None else args.vendor_name.strip()
    vendor_account = None if args.vendor_account is None else args.vendor_account.strip()
    vendor_bsb = None if args.vendor_bsb is None else args.vendor_bsb.strip()
    vendor_number = (
        None if args.vendor_account_number is None else args.vendor_account_number.strip()
    )
    vendor_emails: list[str] = []
    for raw in args.vendor_email or []:
        candidate = raw.strip().lower()
        if "@" not in candidate or len(candidate) > 320:
            print(f"vendor email looks wrong: {raw!r}", file=sys.stderr)
            return 1
        if candidate not in vendor_emails:
            vendor_emails.append(candidate)

    if tenant == "" or re.search(r"\s", tenant) is not None:
        print("tenant looks wrong: one id without spaces", file=sys.stderr)
        return 1
    if "." not in domain or _DOMAIN_RE.fullmatch(domain) is None:
        print(
            f"domain looks wrong: {args.domain!r}, expected a lowercase hostname "
            "like in.mspco.example",
            file=sys.stderr,
        )
        return 1
    if name is not None and len(name) > 100:
        print("connection name looks wrong: max 100 characters", file=sys.stderr)
        return 1
    if client_ref != "" and _CLIENT_REF_RE.fullmatch(client_ref) is None:
        print(
            f"client ref looks wrong: {args.client!r}, expected lowercase letters, "
            "digits, dots and dashes (max 64)",
            file=sys.stderr,
        )
        return 1
    for value, cap, label in (
        (client_name, 100, "name"),
        (client_email, 320, "email"),
        (client_project, 60, "project"),
    ):
        if value is not None and len(value) > cap:
            print(f"client {label} looks wrong: max {cap} characters", file=sys.stderr)
            return 1
    if client_email is not None and client_email != "" and "@" not in client_email:
        print(f"client email looks wrong: {args.client_email!r}", file=sys.stderr)
        return 1
    if client_ref == "" and any(
        value is not None for value in (client_name, client_project, client_email)
    ):
        print("client fields need --client: nothing to attach them to", file=sys.stderr)
        return 1
    if vendor_ref != "" and (
        len(vendor_ref) > 40 or _VENDOR_REF_RE.fullmatch(vendor_ref) is None
    ):
        print(
            f"vendor ref looks wrong: {args.vendor!r}, expected lowercase letters, "
            "digits and dashes (max 40)",
            file=sys.stderr,
        )
        return 1
    if vendor_ref != "" and not vendor_emails:
        print(
            "vendor needs at least one --vendor-email: the bills lane "
            "matches senders on it",
            file=sys.stderr,
        )
        return 1
    if vendor_ref == "" and (
        vendor_name is not None
        or vendor_account is not None
        or vendor_bsb is not None
        or vendor_number is not None
        or vendor_emails
    ):
        print("vendor fields need --vendor: nothing to attach them to", file=sys.stderr)
        return 1
    for value, cap, label in (
        (vendor_name, 200, "name"),
        (vendor_account, 200, "account name"),
        (vendor_bsb, 20, "bsb"),
        (vendor_number, 40, "account number"),
    ):
        if value is not None and len(value) > cap:
            print(f"vendor {label} looks wrong: max {cap} characters", file=sys.stderr)
            return 1

    database_url = Settings().database_url.get_secret_value()
    if database_url == "":
        print("DATABASE_URL missing: set it in .env before onboarding", file=sys.stderr)
        return 1

    try:
        with psycopg.connect(database_url, connect_timeout=15) as connection:
            connection.execute(
                """
                insert into public.msp_connections (tenant_id, inbound_domain, display_name)
                values (%s, %s, coalesce(%s, ''))
                on conflict (tenant_id) do update
                set inbound_domain = excluded.inbound_domain,
                    display_name = coalesce(%s, public.msp_connections.display_name),
                    updated_at = now()
                """,
                (tenant, domain, name, name),
            )
            if client_ref != "":
                connection.execute(
                    """
                    insert into public.msp_clients
                        (tenant_id, client_ref, display_name, contact_email, desk_project)
                    values (%s, %s, coalesce(%s, ''), coalesce(%s, ''), coalesce(%s, ''))
                    on conflict (tenant_id, client_ref) do update
                    set display_name = coalesce(%s, public.msp_clients.display_name),
                        contact_email = coalesce(%s, public.msp_clients.contact_email),
                        desk_project = coalesce(%s, public.msp_clients.desk_project),
                        updated_at = now()
                    """,
                    (
                        tenant,
                        client_ref,
                        client_name,
                        client_email,
                        client_project,
                        client_name,
                        client_email,
                        client_project,
                    ),
                )
            if vendor_ref != "":
                # Emails are always re-sent (the lane matches senders on
                # them); the other fields follow the client pattern and keep
                # their stored value when omitted.
                connection.execute(
                    """
                    insert into public.msp_vendors
                        (tenant_id, vendor_ref, name, emails, account_name, bsb, account_number)
                    values (%s, %s, coalesce(%s, ''), %s, coalesce(%s, ''),
                            coalesce(%s, ''), coalesce(%s, ''))
                    on conflict (tenant_id, vendor_ref) do update
                    set name = coalesce(%s, public.msp_vendors.name),
                        emails = excluded.emails,
                        account_name = coalesce(%s, public.msp_vendors.account_name),
                        bsb = coalesce(%s, public.msp_vendors.bsb),
                        account_number = coalesce(%s, public.msp_vendors.account_number),
                        updated_at = now()
                    """,
                    (
                        tenant,
                        vendor_ref,
                        vendor_name,
                        vendor_emails,
                        vendor_account,
                        vendor_bsb,
                        vendor_number,
                        vendor_name,
                        vendor_account,
                        vendor_bsb,
                        vendor_number,
                    ),
                )
            stored_domain, stored_name = connection.execute(
                """
                select inbound_domain, display_name
                from public.msp_connections
                where tenant_id = %s
                """,
                (tenant,),
            ).fetchone()
            clients = connection.execute(
                """
                select client_ref, display_name, desk_project
                from public.msp_clients
                where tenant_id = %s
                order by client_ref
                """,
                (tenant,),
            ).fetchall()
            vendors = connection.execute(
                """
                select vendor_ref, name, emails, (bsb <> '' and account_number <> '')
                from public.msp_vendors
                where tenant_id = %s
                order by vendor_ref
                """,
                (tenant,),
            ).fetchall()
    except psycopg.Error as error:
        print(f"database write failed: {error}", file=sys.stderr)
        return 1

    print(f"tenant {tenant} wired")
    print(f"  connection  {stored_domain}" + (f"  ({stored_name})" if stored_name else ""))
    if clients:
        for ref, display, project in clients:
            details = "  ".join(
                part for part in (display, f"desk {project}" if project else "") if part
            )
            print(f"  client      {ref}" + (f"  {details}" if details else ""))
    else:
        print("  client      none yet, add one with --client")
    if vendors:
        for ref, vendor_display, emails, bank_on_file in vendors:
            details = "  ".join(
                part
                for part in (
                    vendor_display,
                    ", ".join(emails),
                    "bank on file" if bank_on_file else "",
                )
                if part
            )
            print(f"  vendor      {ref}" + (f"  {details}" if details else ""))
    else:
        print("  vendor      none yet, add one with --vendor")
    if client_ref != "":
        print(
            f"  intake      mail to {client_ref}@{stored_domain} "
            f"files against client ref {client_ref}"
        )
    print("next:")
    print("  - Settings -> MSP connection shows these rows after a console reload")
    if client_ref != "":
        print(
            "  - smoke the support lane:  python scripts/msp-demo.py "
            f"--client {client_ref} --token $MSP_TOKEN"
        )
    else:
        print(
            "  - register a client, then smoke it:  "
            "python scripts/msp-demo.py --client acme --token $MSP_TOKEN"
        )
    if vendor_ref != "":
        print(
            "  - smoke the bills lane:   python scripts/msp-bill-demo.py "
            f"--vendor {vendor_ref} --token $MSP_TOKEN"
        )
    else:
        print(
            "  - register a vendor, then smoke the bills lane:  "
            "python scripts/msp-bill-demo.py --vendor acmepower --token $MSP_TOKEN"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
