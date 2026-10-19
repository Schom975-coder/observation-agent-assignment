# Settlement and invoice resolution: email template

Draft prepared from 170 emails about this process, for the process owner to review. Evidence about this process, quoted exactly from the emails, is listed at the end.

## When to send

Send this query when Settlements or accounting finds that a counterparty invoice or payment does not match the deal as booked in Sitara. Typical triggers:

- A different price on the invoice than in Sitara (for example, the counterparty billed a price that differs from the Sitara price by a fraction of a cent).
- An unpriced or wrong index on the ticket.
- Volumes not yet actualized, so there is nothing in volume management to settle against.
- Deals that may need to be netted or washed out together.
- An invoice for gas that was never paid.

Send one query per deal, as soon as the mismatch is found, so the owner has the longest possible time before the payment date.

### Setup (once)

1. Set up a variance list at [location, such as a shared sheet] with one row per mismatch: deal number, counterparty, invoice figure, Sitara figure, responsible desk, payment due date, date sent, status.
2. Set up a desk lookup at [location] that maps each counterparty or meter to the scheduler or trader who owns the deal, and keep it current when people move or leave. Use it to pick the recipient so the query does not go to the wrong desk.
3. Run a daily match of counterparty invoices against Sitara deal prices and volumes [proposed: each morning], and add every variance to the list before sending.

## Sender and recipients

People doing this work (counted from the emails): Bill Williams III (29 written), Darron C Giron (15 written, 5 forwarded), Megan Parker (13 written, 1 forwarded), Katherine Herrera (10 written, 4 forwarded). Named as owner in the emails: Megan Parker (Sep 2000), Tom Acton (Nov 2000), Darron C Giron (Jan 2001), Melissa K Ratnala (Sep 2000); the process owner settles which. Owner: [process owner to confirm].

### Sender

The Settlements or accounting analyst who found the mismatch. The sender owns the query until the deal is corrected and the invoice is paid or rebilled, and keeps the variance list current.

### Recipients

- To: the scheduler or trader who owns the deal, taken from the desk lookup.
- Cc: the Settlements lead [confirm still in force] and, for power disputes, the person who can pull trader tape recordings or check published market prices.
- Do not send dispute emails to the counterparty or customer unless the Settlements lead says to [confirm still in force]. Tell the counterparty the correct price only after the ticket is corrected or the owner confirms what to bill.
- If the desk lookup does not show an owner, or the owner redirects you, send to the desk lead and ask who handles the deal. Record the answer in the lookup.

## Email

Subject: Deal [deal number]\: [counterparty] invoice [invoice figure] vs Sitara [Sitara figure], payment due [payment due date]

```
Hi [owner name],

The [counterparty] invoice for [delivery month] on deal [deal number] does not match Sitara.

Invoice: [price or volume on invoice] [unit, such as $/MMBtu or MMBtu/d]
Sitara: [price or volume in Sitara] [unit]
Index on the ticket: [index or "unpriced"]
Payment due: [payment due date]

Please verify the deal and reply with one of the following:
1. The Sitara ticket is right, bill or pay [figure].
2. The ticket needs correcting to [figure]. Please correct it in Sitara and tell me when it is done.
3. This deal belongs to [other desk or person].

For a power dispute, please say whether you checked the tapes or the published market price.

I need your answer by [proposed: two business days before the payment due date] so I can rerun the invoice and confirm before it is due.

Thanks,
[sender name]
[Settlements contact details]
```

## If there is no reply

1. Wait [proposed: one business day], then send one follow-up to the same owner with the original query below it and the payment due date in the first line.
2. If there is still no answer, call the owner, then escalate to the desk lead and copy the Settlements lead [proposed: one reminder, then escalate].
3. If the owner redirects the query, update the desk lookup and resend to the new owner. Do not start a new thread with a different subject.
4. If Sitara blocks the fix (a ticket cannot be opened to correct swing pricing, or two prices are held for one day), tell the owner and the Sitara support contact [Sitara support contact] and record the block on the variance list. Do not tell the counterparty a corrected price until the ticket matches.
5. If volumes are not yet actualized, ask the volume management group to actualize them first, then resend the query.
6. If the counterparty does not return calls about the payment or dispute, note each attempt on the variance list and escalate to the desk lead before the payment due date.
7. If the owner is leaving, ask them to hand every open item on the variance list to a named person before their last day, and update the desk lookup.
8. If a price believed final changes again, or the counterparty changes its price during the dispute, send a new query with the latest figures and mark the earlier one superseded on the list.
9. Close the row on the variance list only when the invoice is paid or rebilled and confirmed.

## Evidence

Passages about this process, each quoted exactly from the email named above it. They support the document as a whole, not any one line of it.

### The work

- `corpus/farmer-d/logistics/1528.` (2000-11-17, from Katherine Herrera):

  > Are these deals suppose to be a washout and netted together?

- `corpus/farmer-d/logistics/147.` (2001-05-07, from Cynthia Hakemack):

  > BP invoiced HPL at $4.955 for the deal below, and Sitara shows $4.95.

- `corpus/williams-w3/sent_items/266.` (2001-09-05, from Williams III, Bill):

  > Per your request I have double checked Risk's daily record on ISO revenue/expenses for WHOURLY book in August and everything checked out.

- `corpus/williams-w3/sent_items/131.` (2001-10-31, from Williams III, Bill):

  > Please do NOT send emails regarding our disputes to our customers--El Paso or others.

- `corpus/giron-d/inbox/280.` (2001-11-30, from Carl Sulzer GRE/ER Fuel/Plant):

  > I am open to a settlement based on the change in the market price

- `corpus/farmer-d/logistics/124.` (2001-05-24, from Ray, Tess):

  > Can you confirm if 04/01 sales price for SA-745578, IF - $.06 per entry in Sitara

- `corpus/giron-d/sent/680.` (2000-08-28, from Darron C Giron):

  > Enron Canada purchase deal # 121397  Was 4.18427 should be 4.10185

- `corpus/farmer-d/logistics/2048.` (2001-01-22, from Parker, Megan):

  > Never mind.  They are now changing their price to 6.23.

- `corpus/farmer-d/logistics/74.` (2001-08-17, from Vela, Valerie):

  > Deal 819594 - the commodity price needs to be WAHA.HUB.GDP.D.A+.02

- `corpus/farmer-d/logistics/1998.` (2000-12-20, from Julie Meyers):

  > Can you please validate if this is his gas or if this deal ticket should have

- `corpus/farmer-d/logistics/604.` (1999-12-21, from Julie Meyers):

  > I wanted to update you on those Phillips deals that the counterparty is

- `corpus/farmer-d/logistics/1058.` (2000-04-19, from Katherine Herrera):

  > Would you like for me to confirm the conference call that Duke has requested

- `corpus/williams-w3/sent_items/278.` (2001-08-29, from Williams III, Bill):

  > In an effort to curb El Paso settlements issues, I've requested several sets of tapes over the past few days.

- `corpus/williams-w3/sent_items/322.` (2001-08-07, from Williams III, Bill):

  > It looks like 28 mws at $198 and 75 mws at $223.00.

- `corpus/farmer-d/logistics/1039.` (2000-04-13, from Sherlyn Schumack):

  > Recap of PG&E Texas meeting 4/12/00.

- `corpus/giron-d/sent/12.` (2001-05-09, from Darron C Giron):

  > Can you please update the 04/01 price for deal # 27253 in Sitara?

- `corpus/farmer-d/logistics/922.` (2000-03-20, from Julie Meyers):

  > We have a price difference with Mitchell Gas Services for 2/00 production,

- `corpus/farmer-d/logistics/29.` (2001-10-31, from Parker, Megan):

  > I received an invoice from Four Square Gas Company today for May 2001 gas that was never paid.

- `corpus/farmer-d/logistics/132.` (2001-05-22, from Charlene Richmond):

  > Could you fix asap because payment is due on 25th.

- `corpus/farmer-d/logistics/78.` (2001-08-14, from Vela, Valerie):

  > On day 18, did you intentionally enter 50,000 days or was it a slip of the fingers?

### Where it stalls

- `corpus/farmer-d/logistics/106.` (2001-06-25, from aep.com):

  > I tried to get into the Sitara ticket # 373590 to correct the swing pricing

- `corpus/farmer-d/logistics/1200.` (2000-06-12, from Katherine Herrera):

  > Have you had a chance to change the pricing in the system?

- `corpus/farmer-d/logistics/174.` (2001-04-17, from Rebecca Griffin):

  > Let me know if this should go to someone else.

- `corpus/farmer-d/logistics/604.` (1999-12-21, from Julie Meyers):

  > I have left Gary L. a voice mail, but I have a

- `corpus/farmer-d/logistics/99.` (2001-07-09, from Elizabeth L Hernandez):

  > I have not received a response from you regarding the pricing discrepancies on these deals.

- `corpus/giron-d/sent/643.` (2000-09-19, from Darron C Giron):

  > Any word?  I am going to send in the water fall today so please let me know.

### Who owns it

- `corpus/farmer-d/logistics/1241.` (2000-06-26, from Rita Wynne):

  > This is the piece that we need Daren's help on.

- `corpus/farmer-d/logistics/1420.` (2000-09-22, from Kristen J Hanson):

  > Megan Parker is handling this

- `corpus/farmer-d/logistics/2037.` (2001-01-09, from Fred Boas):

  > Kim Vaughn has taken over all of Kathy's meters.

- `corpus/giron-d/sent/643.` (2000-09-19, from Darron C Giron):

  > Please field all monetized questions/requests through me.

Counted from the emails: this work came up 127 times over 27 active months (1999-12-21 to 2002-03-05), across 170 emails, with 132 staff taking part.

Estimated, not counted: about 45 minutes of hands-on work each time (range 20 to 120), about 40% of it automatable. Basis: seen in the emails; proposed by a model and checked by code.
