# Acme Support Runbook

Operating guide for Acme staff working with the managed service desk. Keep this
document current. The section headings below match the topics staff ask about
most often.

## VPN: tunnels drop in the afternoon

The office VPN concentrator flushes idle sessions during the daily backup
window between 13:00 and 16:00. Symptoms: files on the shared drive stop
responding, the ERP client shows "connection lost", new connections still work.

Fix:

1. Right-click the VPN client in the system tray and choose Disconnect.
2. Wait five seconds, then Connect again and approve the MFA prompt.
3. Reopen the affected application. Unsaved work in the ERP client is kept for
   fifteen minutes in the local spool, so nothing is lost if you reconnect
   promptly.

If the tunnel drops more than twice in one afternoon, open a ticket with the
exact disconnect times. The desk will move you to the low-latency backup
concentrator while the vendor investigates.

## Password reset and MFA enrollment

1. Open the self-service portal at portal.acme.example and choose Reset
   password.
2. Approve the push in the Authenticator app. If the phone was replaced,
   choose "Use a different verification method" and have your manager confirm
   the change with the desk first.
3. New passwords need 14 characters, one number and one symbol, and cannot
   repeat the last five passwords.

Locked out entirely? Call the service desk and quote your employee number. The
desk resets the account after verifying your manager and the last successful
login location.

## Shared printers and the print queue

Map a printer with Settings > Bluetooth and devices > Printers > Add device,
choose "Add manually", select "Find a printer by other options" and enter the
printer name:

- Floor 1: PRN-01-COLOR
- Floor 2: PRN-02-BW
- Floor 3: PRN-03-COLOR

Jobs stuck in the queue for more than ten minutes: cancel the job, remove and
re-add the printer, then print a test page. Send the printer name and the job
name to the desk if the queue still stalls.

## Email: quota and large attachments

Mailboxes have a 50 GB quota and attachments are capped at 25 MB. Weekly
digest mail with dashboards should go to the Reports folder rule, not the
inbox. If you send a file above the cap, the desk recommends the project drive
link instead of an attachment.

## Guest Wi-Fi and meeting rooms

The guest network AC-ACME-Guest uses a daily rotating code shown on the room
display. Staff devices use AC-ACME-Secure with the corporate certificate
installed. Meeting room kits reboot automatically at 06:00 daily. If a room
display shows "no signal" during a booking, reseat the HDMI lead and press
Source twice before calling the desk.

## Severity levels and response targets

- Sev 1 (whole office down): phone the desk, response within 15 minutes.
- Sev 2 (team or shared system degraded): ticket or phone, response within
  2 business hours.
- Sev 3 (single user blocked): ticket, response within 1 business day.
- Sev 4 (question or request): ticket, response within 3 business days.

Always include the affected system, the exact times, and a screenshot in Sev 1
and Sev 2 tickets. The desk escalates to the on-call engineer automatically if
a Sev 1 has no first response inside 15 minutes.
