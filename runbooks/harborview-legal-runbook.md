# Harborview Legal Runbook

Operating guide for Harborview Legal fee earners and support staff working with
the managed service desk. Keep this document current. The section headings below
match the topics staff ask about most often.

## Document management system will not check a file out

The DMS locks a matter document while it is open so two fee earners cannot
edit the same deed.

1. Look for the padlock icon next to the document name. Hovering it shows who
   holds the checkout and since when.
2. Ask that colleague to check the document in. A checkout older than four
   hours without an open editor window is a stale lock.
3. Practice managers can release a stale lock from Administration -> Checkouts.
   The release is logged against the matter, so record the reason in the
   release note.
4. If every document in one matter is locked, the matter sync job has stalled.
   File a ticket with the matter number; do not restart the workstation.

Never email a checked-out document to a colleague as a workaround. The copy
drifts from the matter record and cannot be produced in an audit.

## Evidentiary bundles and large file uploads

Court portals reject uploads above their own size ceiling, and the rejection
message often arrives after a long wait.

1. Compress a bundle to the portal limit named in the matter's cover sheet.
   Bundle tools set PDF quality to 150 dpi, which is readable and passes.
2. Scan colour exhibits at 200 dpi, not 400. Anything higher is refused by the
   portal and unreadable in the bundle index.
3. Split a bundle that exceeds the limit into Part A and Part B, and label each
   with the same matter number in the first page footer.
4. Uploads that fail at ninety percent are usually a proxy timeout. Retry once,
   then report the portal name, file size and the time.

Report a portal change in size limits to the desk the same day, because the
cover sheet template has to be updated.

## Confidentiality, client files and shared links

Externally shared links for this matter expire after seven days by default and
are watermarked with the recipient address.

1. Create the link from the DMS, never from personal cloud storage. Personal
   copies fall outside the matter's retention rule.
2. Choose "view only" unless the recipient is instructed to edit. Edit links
   require the practice manager's approval.
3. If a link is sent to the wrong recipient, report it immediately. The desk can
   revoke the link and pull the access log showing whether it was opened.
4. Adverse-party and regulator correspondence is marked restricted at the
   document level, so it never appears in a bulk link.

Anything involving legal professional privilege is escalated, not worked around.

## Timesheet and practice accounting access

The practice accounting package signs in through the same identity provider as
email. If email is working and accounting is not, the session token has expired.

1. Sign out of the identity provider completely, then sign back in.
2. A "no ledger access" message means the matter's trust account permission has
   not been granted. Route the request to the principal, not to the desk.
3. Payroll and superannuation queries go to the HR system, not the accounting
   package. The desk does not hold records in either.

Access changes are approved by the principal and audited monthly. The desk will
ask for the approver's name before making a change.

## Out of hours, court dates and priorities

The desk is staffed Monday to Friday, 08:00 to 18:00. Matters listed in court
the next morning are treated as urgent even when they arrive after hours, so
state the listing date in the first line of the ticket.

For a total loss of email or the DMS during a filing deadline, call the desk
emergency line after notifying the principal. The line pages the on-call
engineer. Filing deadlines, court listings and lockdown of a matter are
emergencies. A single workstation problem is not.

Deadlines missed because of a system outage are recorded on the incident, with
the outage window taken from the desk's own log rather than from memory.
