# Northside Dental Practice Runbook

Operating guide for Northside Dental staff working with the managed service desk.
Keep this document current. The section headings below match the topics staff ask
about most often.

## Practice management software is slow or locked

Provet keeps one write lock per patient chart. If a chart opens read-only,
another clinician still holds it.

1. Close the chart tab and wait sixty seconds. The lock expires on its own.
2. If it stays locked, check the lock owner in the banner at the top of the
   chart. Names you do not recognise mean a session that never logged out.
3. Ask the front desk supervisor to release the session from
   Setup -> User sessions. Do not restart the Provet service for a single
   chart lock.
4. If the whole practice is slow between 08:00 and 09:30, that is the morning
   billing export running against the same database. Report it with the time
   window and the number of affected chairs.

Open a ticket when more than two clinicians are affected at once, or when a
lock survives a session release. Quote the patient chart number only in the
internal field, never in the subject line.

## Telehealth and camera audio problems

The telehealth room uses a USB headset on channel 1 and the ceiling mic on
channel 2.

1. In the telehealth client choose Settings -> Devices and confirm the headset
   is selected for both microphone and speakers. The ceiling mic picks up the
   handpiece and is not a good transmit source.
2. Set the headset gain to the middle position. Anything above it clips and
   sounds like a buzz.
3. If the remote patient hears echo, close the second browser tab on the same
   machine. Two live sessions on one host loop the audio back.
4. Test the call at least ten minutes before the appointment. If the test call
   fails, phone the patient on the practice line and offer an audio-only
   consult; the clinical note records the fallback.

Dropped calls that repeat across the afternoon point at the wireless access
point in that room, not the software. Report the room number with the times.

## X-ray sensor and image transfer

The sensor drivers are pinned to the version on the vendor support list. Do not
accept an automatic driver update from Windows.

1. Images land in the shared folder `\\\\storage\\xray\\daily` before Provet
   imports them. If an image is missing, check that folder first.
2. Import failures with a "file in use" message clear once the image viewer on
   that workstation is closed.
3. A grey band across every image means the sensor needs its calibration plate
   run. Do it at the start of the day, and note the result in the equipment
   log.
4. If the sensor is not detected at all, unplug the USB lead at the hub and
   plug it into the workstation directly. Hubs are the usual cause.

Escalate to the desk with the workstation name and the sensor serial when
calibration does not restore the image quality.

## Out of hours and emergencies

The desk is staffed Monday to Friday, 07:30 to 18:00, and Saturday 08:00 to 12:00.

For a total outage during surgery hours, call the practice manager, then ring
the desk emergency line. The emergency line is for anything that stops
clinical work: Provet down, storage down, or the network switch in the rack
unresponsive.

The RDO scheduling portal and the staff rostering app are not emergencies. File
a ticket and the desk will handle it on the next business day.

Do not reboot the server rack to clear an outage. The rack powers the phone
system as well, and a cold restart takes twenty minutes longer than a targeted
service restart.

## Backups and what gets restored

Backups run nightly at 20:00 to the off-site vault, and the storage volume is
snapshotted hourly. A single deleted file is restored from the hourly
snapshot, so anything lost in the last few hours can come back.

Restore requests need the file path and the approximate time the file was last
seen. The desk restores patient-identifiable material only to the practice
network, never to a personal device.

Vault failures show as a red banner in the storage console. If the backup has
failed two nights running, file a ticket marked urgent even if the practice is
running normally.
