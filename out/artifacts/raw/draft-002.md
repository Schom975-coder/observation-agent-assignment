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

### Sender

The Settlements or accounting analyst who found the mismatch. The sender owns the query until the deal is corrected and the invoice is paid or rebilled, and keeps the variance list current.

### Recipients

- To: the scheduler or trader who owns the deal, taken from the desk lookup.
- Cc: the Settlements lead [confirm still in force] and, for power disputes, the person who can pull trader tape recordings or check published market prices.
- Do not send dispute emails to the counterparty or customer unless the Settlements lead says to [confirm still in force]. Tell the counterparty the correct price only after the ticket is corrected or the owner confirms what to bill.
- If the desk lookup does not show an owner, or the owner redirects you, send to the desk lead and ask who handles the deal. Record the answer in the lookup.

## Email

Subject: Deal [deal number]: [counterparty] invoice [invoice figure] vs Sitara [Sitara figure], payment due [payment due date]

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
