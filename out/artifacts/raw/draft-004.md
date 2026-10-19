## Purpose

Use this sheet to ask the book owner to move, kill or terminate deals, for example into the bankruptcy books, or back to a live book. One sheet layout replaces ad hoc lists in different formats, so the book owner can flip the deals once and risk can reconcile the final list against its calculations and the book to book transfer numbers.

## Who fills it in

The requester is the risk or logistics analyst who spotted the deals in the wrong book or on a termination list. The book owner (or the risk group that owns the target book) fills in the last two columns once the deals are flipped in the trading system. The termination and estate risk lead keeps the master list and reconciles each sheet against it. Confirm who holds each role at the start of a termination round, because the mail names different people for terminations and for estate risk.

## When

Fill in a sheet whenever deals are found in the wrong book or must be killed or terminated, and send it to the book owner right away or by the next day, as the request says.

- During a bankruptcy round, send one sheet per batch of termination or contract lists, and send each batch of stragglers as its own new sheet that points to the earlier one.
- Send a reversal (deals moved from a bankruptcy book back to the live side) as a separate sheet, with the reason filled in, so it is not mistaken for a new move.
- Before sending, check the deals against the master termination list so deals already moved are not sent again. If no master list exists yet, set one up at [location] and keep it current, and note who maintains it.
- Keep a daily match of the master termination list against current book assignments. Flag deals not yet moved and any reversals, and send the flags to the requester.
- Before the final reconciliation, ask the book owner to confirm no more straggler sheets are coming. If risk is still waiting on the final list, send a reminder [proposed: one reminder, then escalate to the estate risk lead].

## Template

Request header:

```
Request ID: [request ID]
Date sent: [date]
Requester (role and name): [requester]
Book owner or risk group: [recipient]
Request type: [move / kill / terminate / reversal]
Round: [first list / straggler list / reversal]
Earlier sheet this follows: [request ID or none]
Needed by: [right away / next day / date]
```

Deal rows:

| Deal number | Source book | Target book | Trader | Reason | Counterparty (if the sale counterparty changes) | Effective date | Flipped by (book owner) | Date flipped | Confirmed in trading system (yes/no) |
|---|---|---|---|---|---|---|---|---|---|
| [deal number] | [source book, e.g. FT-West] | [target book, e.g. FT-US/CAND-ERMS or a bankruptcy book] | [trader name] | [reason: wrong book / kill / terminate / auto-terminating / reversal] | [counterparty] | [effective date] | [name] | [date] | [yes/no] |
| [deal number] | [source book] | [target book] | [trader name] | [reason] | [counterparty] | [effective date] | [name] | [date] | [yes/no] |

Reconciliation, filled in by risk after the final list:

```
Final list received: [date]
Deals on the sheet: [count] 
Deals confirmed moved: [count]
Deals not yet moved: [deal numbers]
Reversals: [deal numbers]
Matched to risk calculations: [yes/no, notes]
Matched to book to book transfer numbers: [yes/no, notes]
Open questions and who is answering: [notes]
```

Rules for filling it in:

- Fill in the trader and the target book on every row. A row without them goes back to the requester.
- Give one deal number per row, with the source and target book exactly as the trading system names them.
- If a book must be renamed or a new book is proposed (an index book, for example), do not mix it into a deal row. Raise it in the open questions line and get the book owner's reply before any deals are moved to it.

## Where it goes

- Send the sheet to the book owner or risk group that owns the target book, with the requester's own manager copied [proposed: manager copied on every sheet].
- Save a copy in the shared termination folder at [location], named with the request ID, and add the deals to the master termination list at [location].
- If a deal is unclear (for example, who changes the counterparty on a sale), call the book owner instead of resending the sheet, and note the answer in the open questions line.
- If the sheet is waiting on a reply, send one reminder [proposed: one reminder, then escalate to the estate risk lead].
- If the reporting system will not print the sheet or the report (TAGG has failed to print before), send the sheet as an attachment by email and tell the system support contact at [contact].
- When the book owner confirms the flips, return the completed sheet to the requester and to risk for the reconciliation.
