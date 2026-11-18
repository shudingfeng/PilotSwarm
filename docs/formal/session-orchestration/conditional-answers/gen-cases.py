"""Generate the bounded conditional-answer case tables with the repository generator."""
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
import tlc_cases

ROWS = [
    ("qa.serial-cap1", "none", 1, False, "PASS", "Serialized competing writers, retries and full FIFO."),
    ("qa.serial-cap2", "none", 2, False, "PASS", "Two queued answers, identical later questions, replay and continuation."),
    ("qa.legacy-handoff", "none", 2, True, "PASS", "An old tokenless question survives continuation and refuses conditional input."),
    ("qa.fault-token", "text-only", 2, False, "InvNoStale", "Deliberate fault: matching only question text accepts another occurrence."),
    ("qa.fault-overwrite", "overwrite", 2, False, "InvCanonical", "Deliberate fault: a conflicting payload replaces its request's first result."),
    ("qa.fault-replay", "replay-cache", 2, False, "InvOwned", "Deliberate fault: a live receipt cache skips an owed future prompt on replay."),
    ("qa.fault-fifo", "fifo-clears", 1, False, "InvRefused", "Deliberate fault: FIFO refusal clears the pending question."),
    ("qa.fault-can", "can-token", 2, False, "InvToken", "Deliberate fault: continuation remints the current question token."),
    ("qa.receipt-cap", "none", 2, False, "PASS", "Exhausted receipt capacity leaves unknown requests unadmitted and preserves original results."),
    ("qa.fault-cap", "ignore-cap", 2, False, "InvCapacity", "Deliberate fault: an unchecked concurrent request exhausts receipt storage."),
]
INVARIANTS = ["TypeOK", "InvNoStale", "InvCanonical", "InvOwned", "InvRefused", "InvToken", "InvCapacity"]
cases, texts = [], []
for name, fault, capacity, old, expected, note in ROWS:
    invariants = INVARIANTS if expected == "PASS" else ["TypeOK", expected]
    case = {
        "id": name, "module": "QuestionAnswers", "config": name + ".cfg",
        "expected": expected, "note": note, "invariants": invariants,
    }
    constants = {
        "MaxEnvelopes": "3", "FifoCap": str(capacity), "ReceiptCap": "1" if name.endswith("-cap") else "2",
        "OldQuestion": "TRUE" if old else "FALSE", "Fault": json.dumps(fault),
    }
    text = f"\\* {name}; expected {expected}: {note}\nSPECIFICATION Spec\nCONSTANTS\n"
    text += "".join(f"    {key} = {value}\n" for key, value in constants.items())
    text += "INVARIANTS\n" + "".join(f"    {value}\n" for value in invariants)
    text += f"CHECK_DEADLOCK {'TRUE' if expected == 'PASS' else 'FALSE'}\n"
    cases.append(case)
    texts.append(text)

templates = tlc_cases.attach(cases, texts)
for name, value in [("cases.json", cases), ("tlc-templates.json", templates), ("cases-retired.json", [])]:
    (HERE / name).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8", newline="\n")
(HERE / "cases.tsv").write_text("".join(
    f"{case['id']}\t{case['config']}\t{case['module']}\n" for case in cases
), encoding="utf-8", newline="\n")
