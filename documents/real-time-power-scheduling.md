# Real-time power scheduling: SOP

Draft prepared from 160 emails about this process, for the process owner to review. Evidence about this process, quoted exactly from the emails, is listed at the end.

## Purpose

Keep real-time power trades, imports and positions scheduled correctly with the CISO and counterparties, and keep every shift staffed. This procedure holds the standing rules for the real-time desk so each shift works the same way and schedule sheet errors are caught before they reach the CISO.

## Owner

People doing this work (counted from the emails): Bill Williams III (120 written, 19 forwarded), John Anderson (2 written), Craig Dean (1 forwarded). Named as owner in the emails: Kate Symes (Jul 2001). Owner: [process owner to confirm].

The real-time desk lead owns this procedure. The desk lead:

- reports open longs and shorts by hub and hour, and tells traders which purchases and sales to enter in Enpower and under which book;
- issues the deal numbers to use for transmission and any rule changes, and makes sure every shift has them;
- publishes the monthly shift schedule and approves changes to it;
- supplies prices and deal numbers through a named pricing contact [confirm still in force].

Shift traders run the shift. Preschedulers build the preschedule sheet and work with traders to get it correct.

## When to run

Run this procedure every shift, and again for any correction round after a schedule has been submitted. A round starts when the desk lead or a prescheduler reports the day's positions and deals by hub and hour (for example, "long 25 MW in NP-15" or "short 50 MW in SP-15 for HE 7–22").

## What you need

- Enpower access, with the books and deal numbers for the day.
- The preschedule sheet and the EPE schedule sheet for the operating day.
- CISO access for submitting schedules, tags and bids.
- The current list of counterparty contacts for hourly calls and nightly checkout, including Grays Harbor, Frontier and the major marketers and utilities.
- The monthly shift schedule.
- A shared list of the standing deal numbers for transmission (set up in step 1).

## Procedure

1. Set up one shared page at [location] that lists the standing rules and deal numbers for transmission (the deal number and price rule for each path), and keep it current. Use it as the source for every later step.
2. Desk lead or preschedulers: report the day's open positions and deals by hub and hour to every shift trader.
3. Shift trader: enter each purchase and sale in Enpower under the book and deal number given for it. Make real-time purchases from the Calimbalance and the matching sales under ST-WBOM during real time [confirm still in force].
4. Shift trader: when scheduling transmission, use the deal number on the shared page for that path and set the price the page requires. For Portland General Electric from John Day to Malin, use deal #146517 at a price of zero [confirm still in force].
5. Shift trader: for a buy from EPE, enter it flat against the matching day-ahead sale, and record the lending volume in the EPE schedule sheet exactly as it appears in the deal.
6. Shift trader: before submitting, check the preschedule and EPE sheets for duplicate schedules, lending volumes that differ from the deal, missing schedules, and import IDs or tags that do not match what you will send to the CISO. Fix them with the preschedulers.
7. Shift trader: submit schedules and tags to the CISO and the counterparties. Where a counterparty requires it, call at the top of every hour (Grays Harbor and Frontier) [confirm still in force].
8. Shift trader: keep track of amounts exercised on options and record them on the sheet.
9. Shift trader: confirm with the CISO that each submitted schedule and tag shows as entered, including the correct hour ending, volume and import ID.
10. Shift trader: record every deal as it is done, so that the sheet can be rebuilt from the record if needed.
11. Shift trader: each night, check out with the major marketers and utilities and compare positions by counterparty and hour against the sheets. Correct any difference before the shift ends.
12. Shift trader: call the desk lead before calling a customer about a position or a problem [confirm still in force].
13. Desk lead: circulate shift coverage and rule changes to the group, including Enpower information, and update the shared page from step 1.
14. Shift trader: if you cannot work a shift, find a replacement yourself, then email the desk lead about the change and write it on the schedule [confirm still in force].

## Exceptions and escalation

- **Duplicate or missing schedule in a sheet.** Correct the sheet, tell the preschedulers and the desk lead, and adjust the next day's sheets if they carry the same error. If a schedule is missing from the EPE schedule sheet on consecutive days, tell the desk lead so the cause is found.
- **Lending position differs from the deal.** Treat the deal as correct. Fix the sheet to match it, then tell the desk lead and the counterparty's scheduler (for example PSCO) if the volume was sent wrong.
- **Wrong import ID or schedule misentered at the CISO.** Contact the CISO right away to correct it, then correct your sheet and tell the desk lead.
- **Spreadsheet figure does not match what was scheduled.** Do not submit. Reconcile it against Enpower and the CISO entry, and answer the desk lead's question with the corrected figure.
- **CISO cannot read submitted bids, trading screens stop, or Enpower is down for maintenance.** Tell the desk lead at once, switch to the backup way of working the desk has [backup procedure], and enter the missed deals in Enpower after the system returns. Watch for announced maintenance windows and plan around them.
- **Deals not recorded during a shift.** The traders who were on that shift coordinate the deals that were done and reconstruct the sheet, then give it to the desk lead.
- **A task cannot be done in the shift.** Tell the desk lead before the shift ends and agree a new day for it, so it is not dropped.
- **No counterparty will sell.** Report to the desk lead which counterparties have been asked, and wait for instructions.
- **Owner unclear for prices and deal numbers.** Ask the desk lead who supplies them [confirm still in force].

## Evidence

Passages about this process, each quoted exactly from the email named above it. They support the document as a whole, not any one line of it.

### The work

- `corpus/williams-w3/sent_items/357.` (2001-07-28, from Williams III, Bill):

  > We must call Grays Harbor and Frontier at the top of EVERY hour.

- `corpus/williams-w3/sent_items/330.` (2001-08-04, from Williams III, Bill):

  > We need to keep track of the amount exercised.

- `corpus/williams-w3/sent_items/66.` (2001-11-30, from Williams III, Bill):

  > longterm contracts will require an annuity for the value of the cut on that particular day.

- `corpus/williams-w3/sent_items/506.` (2001-06-13, from Williams III, Bill):

  > We are long for the 13th in California, 25 mws under ST-WBOM in NP-15 at $57.

- `corpus/williams-w3/sent_items/367.` (2001-07-24, from Williams III, Bill):

  > I think we need to enter the buy from EPE flat to our day ahead sale to STSW.

- `corpus/williams-w3/inbox/124.` (2002-01-02, from Williams III, Bill):

  > If you will be unable to work a shift it is your responsibility to find a replacement

- `corpus/williams-w3/sent_items/13.` (2002-01-25, from Williams III, Bill):

  > Please be sure to send me an email regarding changes, and write them on the schedule.

- `corpus/williams-w3/sent_items/374.` (2001-07-23, from Williams III, Bill):

  > Please work with the preschedulers to get the sheet correct

- `corpus/williams-w3/sent_items/474.` (2001-06-22, from Williams III, Bill):

  > We have asked every single counterparty in the NW to sell us energy.

- `corpus/williams-w3/sent_items/414.` (2001-07-11, from Williams III, Bill):

  > We are short 50 mws in SP-15 for HE 7-22 on Wednesday at $61.44.

- `corpus/williams-w3/inbox/98.` (2002-01-24, from Anderson, John):

  > http://172.17.172.22/elpaso/!current.txt

- `corpus/williams-w3/sent_items/406.` (2001-07-12, from Williams III, Bill):

  > Annuities killed - 679980/679973/679991/679995/678497/678498/678495/678496

- `corpus/williams-w3/sent_items/329.` (2001-08-06, from Williams III, Bill):

  > Here is some new info, and some updated info for our packet.

- `corpus/williams-w3/sent_items/434.` (2001-07-03, from Williams III, Bill):

  > When scheduling transmission on Portland General Electric from John Day to Malin we MUST use deal #146517, we MUST make the price zero.

- `corpus/williams-w3/sent_items/283.` (2001-08-27, from Williams III, Bill):

  > Please call me before you call our customer.

- `corpus/williams-w3/sent_items/240.` (2001-09-15, from Williams III, Bill):

  > Please give this information to the group including Enpower information...etc.

- `corpus/williams-w3/sent_items/392.` (2001-07-14, from Williams III, Bill):

  > Please make real-time purchases from the Calimbalance and corresponding sales under ST-WBOM in Enpower during real time.

- `corpus/williams-w3/sent_items/164.` (2001-10-19, from Williams III, Bill):

  > If you could adjust your sheets for tomorrow I would appreciate it.

- `corpus/williams-w3/inbox/79.` (2002-01-30, from Meyers, Albert):

  > Tag number 6181 has been cancelled (50mw to the CISO).

- `corpus/williams-w3/sent_items/160.` (2001-10-20, from Williams III, Bill):

  > Also on Saturday morning...Enpower will be down from 5 AM to 7 AM.

### Where it stalls

- `corpus/williams-w3/inbox/122.` (2002-01-02, from Williams III, Bill):

  > Those who were on shift for that period will need to coordinate what deals were done and will need to reconstruct a sheet.

- `corpus/williams-w3/inbox/52.` (2002-02-03, from Meyers, Albert):

  > For yet another day we seem to be having problems including all the schedules in our EPE schedule sheet.

- `corpus/williams-w3/sent_items/159.` (2001-10-22, from Williams III, Bill):

  > The CISO is again having difficulties reading our bids.

- `corpus/williams-w3/sent_items/374.` (2001-07-23, from Williams III, Bill):

  > Friday's sheet for Monday had a duplicate 10 mw schedule in it

- `corpus/williams-w3/sent_items/384.` (2001-07-20, from Williams III, Bill):

  > I will not have time today.  Perhaps it can wait till tomorrow.

- `corpus/williams-w3/sent_items/510.` (2001-06-12, from Williams III, Bill):

  > For HE 11 and HE12, Danielle at the CISO misentered our schedule.

### Who owns it

- `corpus/williams-w3/sent_items/365.` (2001-07-24, from Williams III, Bill):

  > Details regarding prices and deal numbers will be coming from Kate.

Counted from the emails: this work came up 149 times over 9 active months (2001-06-11 to 2002-02-07), across 160 emails, with 49 staff taking part.

Estimated, not counted: about 30 minutes of hands-on work each time (range 10 to 90), about 40% of it automatable. Basis: seen in the emails; proposed by a model and checked by code.
