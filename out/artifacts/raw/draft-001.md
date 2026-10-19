## Purpose

Use this request form when gas flowed at a meter with no matching deal, no nomination, or volumes out of line with the deal. One form carries everything the trader or scheduler needs to answer: the meter, the days, the volume, the last deal at that meter, and the action you propose. It replaces the hand-written message that is otherwise rebuilt each time.

The form asks for a decision on how the flow is booked: create, extend or path a deal, move the volume to an existing deal, adjust it, or write it off. Booking stays with people; the form only gets the question to the right person with the facts attached.

## Who fills it in

The volume management or allocation analyst who spots the flow fills in the form and sends it. That role also looks up the deal and nominations before sending, tracks the request until it closes, and reallocates the volume off the strangers gas contract or unaccounted-for balance once the answer comes back.

The trader or scheduler named for the meter in the routing table answers the form: whether a deal exists, should be created, or should be revised. The logistics group tells the assets group about meter changes and the volume management analyst owns the adjustments, so state both in the form's last two fields instead of assuming one covers the other.

## When

Fill in a form each time a meter shows flow with no deal, no nomination, or volumes that disagree with the deal or the pipeline statement. Send it the same day you find the flow [proposed: same day]. Send one form per meter; list every affected day on that form.

Check the Ageing field each morning [proposed: every business day]. Chase once after [proposed: 2 business days] without a reply, and send the item to the desk lead if it is still open after that [proposed: one reminder, then escalate]. Flag old flow, raised long after the gas moved, at the top of the form so it is read first.

## Template

Fill in one row per field. Replace every `[placeholder]`.

| Field | Entry |
|---|---|
| Date sent | [date] |
| Requested by (role and name) | [volume management or allocation analyst] |
| Sent to (owner of this meter from the routing table) | [trader or scheduler] |
| Meter number and name | [meter] |
| Pipeline / point | [pipeline and point] |
| Days that flowed | [day or date range] |
| Volume that flowed | [volume] [unit: MMBtu or dth, as the pipeline statement shows] |
| What is missing or wrong | [no deal / no nomination / volume differs from deal] |
| Last deal at this meter and its trader | [deal number] for [month], trader [name] |
| Deals and nominations checked | [deal system and scheduling system results, for example nothing coming through in Unify or CPR] |
| Volume currently sitting on | [strangers gas contract / unaccounted-for balance / other] |
| Counterparty or pipeline volume, if different | [actual volume] [unit], confirmed with [counterparty or pipeline contact] |
| Earlier request for this flow | [date and recipient, or none] |
| Proposed action | [create a deal / extend deal [number] / path deal [number] to [pipeline] / move volume to deal [number] / adjust / write off] |
| Question for you | [Does a deal exist, should one be created, or should it be revised?] |
| Needed by | [deadline] |
| Impact if not cleared | [for example, effect on the UA4 number or on economics] |
| Ageing (days since flow / days since this request) | [days] / [days] |
| Status | [open / waiting on counterparty / waiting on legal / booked / closed] |
| Resolution | [deal number the volume was placed on, adjustment, or write-off; date reallocated] |
| Who informs the assets group of the meter change | [logistics contact] |
| Who makes the adjustment | [volume management contact] |

## Where it goes

Send the completed form by email to the owner of the meter or point, copying the desk lead and the volume management contact. Keep each form in the meter exceptions tracker at [location], one row per form with the same fields and the Ageing column, and sort the tracker by Ageing so the oldest items show first.

Set up the following before first use:

1. Set up the meter exceptions tracker at [location] and keep it current. Close an item only when the Resolution field names where the volume was reallocated.
2. Set up a routing table at [location] that names the owner for each meter or point, with a backup. Keep it current; when a question is redirected to someone else, update the table so the next form goes to the right person.
3. Set up a daily exception report [proposed: run each morning] that matches measured meter flow against deals and nominations and lists each meter, day and volume with no deal, with the last deal at that meter and its trader attached. Use it as the starting point for new forms.

### If the item stalls

- No reply: chase once, then send it to the desk lead named in the routing table.
- Waiting on a counterparty who is checking with legal: set Status to waiting on legal, note the contact and the date, and do not book the volume until they call back.
- The deal system and the pipeline disagree on volumes: list the differences by day in the Counterparty or pipeline volume field and confirm with the counterparty before you propose an action.
- Nothing comes through in the scheduling system, or mirrored meters misbehave: record it in the Deals and nominations checked field and tell the system owner [contact], since it may be hiding other exceptions.
- Two people each say someone else handles the meter: send the form to the desk lead to name the owner, then update the routing table.
