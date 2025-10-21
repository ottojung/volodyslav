<NOTE>
This document is a draft.
It contains placeholders, fixmes, and must-haves that need to be addressed.
When completing the document, ensure that all placeholders are filled, fixmes are resolved, and must-haves are included.
Some must-haves, those surrounded by quotes, are exact phrases that need to be integrated neatly into the text. But others are thematic elements that should be woven into the narrative.


The style is horror. Specifically, lovecraftian horror, with a focus on the uncanny and the unsettling.
It is grave, meticulous, humor only implicit, investigator fraying at the edges.

</NOTE>

<MUST HAVES>
"I had written prose that described procedures in the future tense, as if promising the very sun, and when the sun obeyed I pretended it was because we had the grammar correct."
"FIELD NOTE #X The closer your model fits the world, the more the world will take issue."
"... like myself—skeptics who have seen just enough to be superstitious."
"... there are systems whose failure modes include poetry."
</MUST HAVES>

# A Strange Collection of System Failures
<FIXME> A better title is needed. Something more evocative. </FIXME>

*From the notebook of an investigator <PLACEHOLDER/>*

---

## Prologue

I was not trained for hauntings. I was trained for reproducibility, for test plans and postmortems, for the clean relief of a failing unit test that fails again in the same way. But the longer I have tended systems—their valves and logs, their hissing racks and their fragile promises—the more I have come to understand that what we write on paper is not what the air will carry.

<PLACEHOLDER/>

I began to keep a dossier. Not a taxonomy—God preserve me from one more axis—but a sheaf of field notes: cases gathered from labs and basements, control rooms and attics <PLACEHOLDER/>. A few I saw myself; others I learned from steadier hands who were there before me 

<PLACEHOLDER/>

<MUST HAVES>
"People ask if I believe in such things."
"Read them so that when the world leans on your specification, you recognize the weight."
</MUST HAVES>

---

## Case Files

### I. The Schaerbeek Bit

<FIXME>
Change the title to something more evocative.
</FIXME>

**Schaerbeek, Belgium, May 2003.**

<PLACEHOLDER/>
<NOTE>
Tell a made-up story of how this happened.
There is a documented part, which is included at the end.
But the main piece is the made-up horror story.

---

Make the moment of discovery feel like a slow bruise rather than a jump scare.

Stance: Treat the error as felt before it is known. Avoid any instant revelation; delay the noun “4096” and delay “power of two” until later.

Method: Build unease through procedural rhythm going out of tune: call-and-response totals, the small pauses people make when they pretend they didn’t pause, the re-addition that wasn’t requested but nobody objects to.

Rule: All uncanny pressure must be deniable as normal fatigue or habit. Nothing “happens”; only confidence fails to materialize.

No lights flicker; no sudden silence; no person “feels watched.” The room remains ordinary. The wrongness is procedural.

Do not let “4096” appear near exclamation or italics. Refuse emphasis; that refusal is the chill.

Do not explain why they re-add. Let habit and unease motivate it; explanation breaks the spell.

---

Do: When you finally print the digits, bury them.
Stage: “…leaving, as a remainder, 4 096, which—” and immediately continue with process. No italics, no em dash flourish.
Buys: The number feels cold and procedural, not performative.

---

During the discovery phase, employ "procedural time dilation" technique:

Do: Mark tiny time with objects, not timestamps.
Stage: Uncapped pen dries on the nib; a condensation ring appears under a disposable cup; the adding tape’s curl advances by one more loop—each coinciding with a re-add.
Buys: The room’s time moves, not the plot’s.

---

Going into the technician’s story:

Start innocently, matter-of-fact. Only when the tally reaches the faulty candidate does the prose admit weather/dryness and begin the drift into unease.

Structure:
1) **Beat A — Ordinary Room, Ordinary Building (no unease, no weather).**  
2) **Beat B — Ordinary Process (procedural, uncolored).**  
3) **Beat C — Pivot on the Candidate (introduce weather/dryness; first sideways detail).**  
4) **Beat D — Residual Unease (subtle sensory misfits; still deniable).**

Rules:
- **A & B:** strictly operational; zero metaphors; no “dry,” no “thirteen,” no carpet opinions.  
- **C:** first mention of weather/dryness; remain clinical; allow one sensory adjective.  
- **D:** 1–2 oddities total; plausible as fatigue or static; no overt horror language.

---

When discovering the error make it seem like everyone understood, without agreement, that to call it an error would start the machinery of inquiry—forms, witnesses, the freezing of work already half done. So make them speak around it instead, referring to *this part* or *that total*, passing the word as if it burned.

</NOTE>

<MUST HAVES>

"He worked elections—“not politics,” he said quickly, “interfaces.”" - for the part describing the technician, who told us the story.

"... a habit of tapping the table as though confirming liveness." - for the part describing the technician's character.

"He used the word spontaneous without liking it." - for the part describing the technician's general attitude.

Smell/sound texture of “dry athmosphere" when describing the surrounding of the polling station. This is to echo the “Not tonight… tonight is dry.” line.

"... a carpet whose pattern is an argument against democracy." - for the part describing the polling station.

"There is the certainty, never admitted aloud, that somewhere a check is missing and that this is sane; that checks go missing the way buttons go missing from coats." - for the part that leads to the discovery of the anomaly.

"It was one power of two too proud." - when first referring to the extra votes (4096 = 2^12).

"The list’s ceiling is the candidate’s sky, and yet there it was: sky lower than the bird:

$$\boxed{\text{candidate preferences } \leq \text{ party list total } \leq \text{ district total}}$$", titled "Invariant 1. (violated)".

"They stared at the sum as though it might amend itself out of shame." - for the part describing the clerks discovering the extra votes.

"One of the watchers—a schoolteacher—tried to be helpful by pointing out each time the computer made a small sound, as if identifying birds." - for the part describing the immediate on-site investigation.

"The woman with the tape asked if lightning could do it. “Not tonight,” said the toolbox man; “tonight is dry.”" - for the part describing the immediate on-site investigation.

"They made a ledger of what would be convenient to blame and crossed each item off." - for the part describing the immediate on-site investigation. A latex-styled checklist would be good here, each item crossed out.

"A physicist friend—pressed into service because her apartment was nearby, and because she is the sort of person one calls about the moon—arrived with a bicycle helmet and a theory that lay uneasily between farce and fate." - for the part describing the immediate on-site investigation.

"The bit toggled to one, and in so toggling, wove its one-ness into every arithmetic that followed." - when summarizing the conclusion of the physicist's theory.

"There was no smoking gun — only a single flip where a zero had become a one at the thirteenth bit, a neat, round power-of-two crime."

"Field Note #${X}. Horror, in our trade, is the clean error—the one that leaves no prints."

Clerks’ fatigue truth: a clerk privately prefers a boring human mistake; the cosmic explanation feels like trespass. But he knows better than to say so aloud, for one: he might be held legible for the error himself. This part, however, should resonate with some skeptic readers.

"A cosmic flea bite, the newspapers preferred." - for the part describing the official explanation.

"The committee’s report is less romantic, but it permits the word that haunts this dossier: likely. A likely single-event upset—an ion that fell through the evening and made a number grow teeth."

"The phrase is correct in the way that shipwrecks are wet." - when describing the official explanation.

Something like a related human-story about corruption:
The technician, having confessed to me the soft doctrine of the bit, told me a smaller, meaner story. The following week, a man from the party that had briefly prospered came into the municipal building with a cigar he did not light. He made a show of not lighting it; this was his signature, he said—good manners doubling as advertisement. He asked, in a tone so gentle it barely bruised the air, whether the numbers—those numbers—could be verified just one more time.

Then, a come-back to the technical part, to its conclusion/reflection.

"He meant, I think, that we must act as if the world intends this sort of interruption, because the world does not intend otherwise." - when reflecting on the technician's story.

An allegory that compares the unpredictability of software behavior to the weather. Something like "we do not fight the weather, we prepare for it."

"... if you believe in preparation, then you believe in a cathedral of checks where each arch braces another—triplicate logic, parity with scrubbing, watchdogs to guard the watchdogs, and the prophylactic act of voting in paper because paper fails like a person fails, slow and legible." - a counter-point to the weather allegory, and whatever the technician said.

"[poureva.be][2]" - link to the official report, for the reference section.

"The Schaerbeek incident occurred during Belgium’s federal election on Sunday, 18 May 2003, when one candidate was credited with 4,096 extra preferential votes—detected because the candidate’s preferences exceeded the party’s list total, an impossibility in that system. The official explanation described a “spontaneous creation of a bit at position 13” in memory; a widely cited interpretation is a single-event upset (SEU) likely caused by a cosmic ray." - for the reference section.
</MUST HAVES>

---

### II. Mark II Moth

**Cambridge, Massachusetts, 1947.**

There is a photograph I keep in a folder called *Proofs I Do Not Argue With*. In it, a moth—an ordinary, grieving moth—sits dead-eyed on rag paper.

![Moth](https://ids.si.edu/ids/deliveryService?id=NMAH-NMAH2000-03035)

<PLACEHOLDER/>

<NOTE>
Tell a made-up story of how this moth made something go wrong.
Implicit supernatural event is that it got there and caused mischief.
</NOTE>

<PLACEHOLDER/>

I have stood before the display and seen my own face in the glass, a later child of their superstition: that if we name it, we can banish it. The moth looks unconvinced. ([National Museum of American History][1])

<PLACEHOLDER/>

---

### III. The Heisenbug I Failed to Catch

<FIXME>
Change the title to something more evocative.
</FIXME>

<NOTE>
It would be nice to link to an actual report of someone who noticed an interesting or unique Heisenbug and how they diagnosed it. The story should then just be a retelling of that, with some embellishment. The story should not end with fixing the bug - it should portray the bug as something **real**, some kind of metaphysical phenomena that makes the system misbehave when it is not being observed.
</NOTE>

**Somewhere between midnight and the first ferry.**



<MUST HAVES>
"With strace running, it behaved as if repentant"
"I introduced print statements as if soothing a friend — *tell me what you are thinking when you do this*."
"We laid snares: printf incantations, timeouts shaved to angel-hair, a tracer that has broken better men than me."
"In the morning, I wrote my note: *This thing hates to be watched*."
</MUST HAVES>

---

### IV. Maxwell’s Demon

<NOTE>
Tell a made up story about a state that is extremely unlikely, though possible, to happen, but did happen. 
For example, an MD5 hash collision.

Then, add a legend that one of the developers saw a large, terrifying demon that appeared to him in a dream, and that demon told him that the server room is cursed.

Ideally, find a real world example of something extremely unlikely happening, and use that as the basis for the story.
 </NOTE>

---

### V. The Leprechaun of Off-by-One

<NOTE>
Tell a made up story of how actual Leprechaun from Irish folklore broke into the server room at night and "moved the loop bounds" (loop as in "a for-loop") by one.

This should be a story told to us by as a legend. In that legend, somebody allegedly, saw an actual small man in green clothes with a red beard in the server room.
</NOTE>

---

### VI. Mercury in Retrograde

<NOTE>
Tell a made up story of how a bug coincided with Mercury being in retrograde.
The bug must be unique and interesting.
Do not talk about solutions.
The implication should be that the bug was a real thing, actually caused by Mercury being in retrograde.
We'll retain skeptics by documenting the operational timeline with enough specificity that the causal inference feels like a temptation, not a writer’s decree.
</NOTE>

---

### VII. The Crocodile in Vienna

<NOTE>
Tell a made up story of how a crocodile was spotted in Vienna, causing a stir among the locals and drawing attention from the authorities and impacting lifes of people in the city.
However, the crocodile had no impact on American software systems, which continued to operate as normal (different continent, get it?).

Some reference: https://chatgpt.com/share/68f3eeb1-c1c0-800e-b09b-e2ee25ddbf47
</NOTE>

---

### VIII. A Natural, Boring Crash

<FIXME>
Change the title to something more evocative.
</FIXME>

<NOTE>
Tell a made up story of how a server crashed due to environmental reasons, such as overheating or power failure.
The story should emphasize that this is not a supernatural event, but rather a mundane one.
This is a necessary palate cleanser, it shores up our credibility by reminding readers that not all anomalies are numinous.
</NOTE>

---

## Coda

<PLACEHOLDER/>

<MUST HAVES>
Something with the same moral as "We live by the text; we survive by the small, retold stories that help us decide which part of the text applies when the world grows strange. If you keep a dossier of your own, write in a hand you will recognize when you are older. Tape in what must be taped. Leave space in the margins for the things we still do not know how to name."
</MUST HAVES>

---

## Endnotes & Sources

1. **Mark II moth, the “first actual case of bug being found.”** Smithsonian National Museum of American History object page for the original logbook with the taped insect. ([National Museum of American History][1])

2. **Schaerbeek e-voting anomaly (4096 extra votes).** Civic archive that digitized the official experts’ report: *Rapport concernant les élections du 18 mai 2003* (Collège d’experts, Belgium). ([poureva.be][2])

3. **Background summary of the 2003 incident and Belgian e-voting context.** “Electronic voting in Belgium,” overview with references to the Schaerbeek case. (Use as a pointer; prefer primary reports where available.) ([Wikipedia][3])

4. **Additional context from advocacy and oversight materials.** *eVoting in Belgium: State of the Union* (PourEVA), summarizing known incidents including the 4096-vote anomaly. ([vooreva.be][4])

*(Selected entries above anchor the real incidents used in this dossier. Other vignettes are composites or field recollections and are labeled with mock citations where appropriate.)*

[1]: https://americanhistory.si.edu/collections/object/nmah_334663?utm_source=chatgpt.com "Log Book With Computer Bug"
[2]: https://www.poureva.be/spip.php?article32=&utm_source=chatgpt.com "Rapport concernant les élections du 18 mai 2003"
[3]: https://en.wikipedia.org/wiki/Electronic_voting_in_Belgium?utm_source=chatgpt.com "Electronic voting in Belgium"
[4]: https://www.vooreva.be/IMG/pdf/eVoting_State_of_the_union.pdf?utm_source=chatgpt.com "eVoting in Belgium “State of the Union”"

---
