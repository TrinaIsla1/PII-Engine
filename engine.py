"""
engine.py - scans text, runs the right DFA on each token, and redacts matches.

Redaction works on character POSITIONS in the original text, so line breaks,
tabs and spacing come out exactly as they went in.
"""
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from automata import (
    DFA, StepRecord, build_email_dfa, build_generic_api_dfa,
    build_phone_dfa, build_vendor_api_dfa, char_class, MIN_KEY_LENGTH, DEAD,
)

# A token is a run of characters that can't be separators (space, comma, quotes, brackets ...).
TOKEN_PATTERN = re.compile(r"[^\s,;:|\"'<>()\[\]{}]+")
TRAILING_PUNCT = ".,;:!?\"')]>"
DOMAIN_LIKE = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$")
# "API_KEY=sk-live-..." -> name, value. The value is redacted on its own so the name stays readable.
ASSIGNMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_.\-]*)=(.+)$")


def _looks_like_key(name: str) -> bool:
    """A 'name' with digits and both letter cases (x9K2mP=...) is probably the start of a key, not a variable."""
    return (any(c.isdigit() for c in name) and any(c.islower() for c in name)
            and any(c.isupper() for c in name))


@dataclass
class TokenResult:
    token: str
    pii_type: str
    accepted: bool
    final_state: str
    reason: str
    redacted_tag: str
    steps: List[StepRecord] = field(default_factory=list)
    start: int = 0              # position in the original text
    end: int = 0
    dfa_id: str = ""            # which automaton ran ("" for plain text)
    path: List[str] = field(default_factory=list)


class PIIAutomatonEngine:
    API_PREFIXES = (
        "sk-proj-", "sk-live-", "sk-test-", "sk-",
        "pk_live_", "pk_test_", "sk_live_", "sk_test_",
        "AIza", "ghp_", "gho_", "ghu_", "AKIA", "xoxb-", "ya29.",
    )

    def __init__(self):
        self.email = build_email_dfa()
        self.phone = build_phone_dfa()
        self.api_vendor = build_vendor_api_dfa(self.API_PREFIXES)
        self.api_generic = build_generic_api_dfa()
        self.automata: List[DFA] = [self.email, self.phone, self.api_vendor, self.api_generic]

    @staticmethod
    def classify_char(ch: str) -> str:
        return char_class(ch)

    # ------------------------------------------------------------------
    def _run(self, dfa: DFA, token: str) -> TokenResult:
        run = dfa.run(token)
        return TokenResult(token, dfa.pii_type, run.accepted, run.final_state, run.reason,
                           "" if run.accepted else token, run.steps,
                           dfa_id=dfa.id, path=dfa.path_of(run.steps))

    def inspect_token(self, raw_token: str, with_steps: bool = True) -> TokenResult:
        """Decide which automaton(s) apply to one token and return the verdict."""
        token = raw_token.rstrip(TRAILING_PUNCT)
        if not token:
            return TokenResult(raw_token, "NONE", False, DEAD, "Empty", raw_token)

        if token.startswith(self.API_PREFIXES):
            return self._run(self.api_vendor, token)

        if "@" in token:
            email_res = self._run(self.email, token)
            if email_res.accepted:
                return email_res
            if len(token) >= MIN_KEY_LENGTH:          # "x9K@..." may be a key, not an email
                key_res = self._run(self.api_generic, token)
                if key_res.accepted:
                    return key_res
            return email_res

        if len(token) >= MIN_KEY_LENGTH:
            key_res = self._run(self.api_generic, token)
            if key_res.accepted:
                return key_res

        if token.startswith("+") or (token[0].isdigit() and len(token) >= 7):
            return self._run(self.phone, token)

        if DOMAIN_LIKE.match(token):                  # "johndoe.com" -> email missing its '@'
            return self._run(self.email, token)

        # Plain text. Building one step per character is wasted work for the bulk
        # of a document, so callers that don't need the trace can skip it.
        steps = ([StepRecord(i, ch, char_class(ch), "q0", "q_text")
                  for i, ch in enumerate(token, start=1)] if with_steps else [])
        return TokenResult(token, "NONE", False, DEAD, "Standard text", token, steps)

    def trace(self, token: str, dfa_id: Optional[str] = None) -> Dict:
        """Full step-by-step trace for one token, optionally forced through one automaton."""
        if dfa_id is None:
            res = self.inspect_token(token)
        else:
            dfa = next((d for d in self.automata if d.id == dfa_id), None)
            if dfa is None:
                raise ValueError(f"Unknown automaton '{dfa_id}'")
            res = self._run(dfa, token)
        res.start, res.end = 0, len(token)
        return self._to_dict(res)

    # ------------------------------------------------------------------
    def process_text(self, text: str, with_steps: bool = True,
                     max_pii_detail: Optional[int] = None,
                     max_text_detail: Optional[int] = None) -> Dict:
        """Redact `text`.

        Counts always cover the whole text. The per-token detail list can be capped
        (`max_pii_detail` for PII/rejected tokens, `max_text_detail` for plain words)
        and can leave out the character traces (`with_steps=False`) so huge inputs
        don't produce huge responses. Use `trace()` to fetch one token's steps later.
        """
        pieces: List[str] = []
        results: List[Dict] = []
        counts = {"EMAIL": 0, "API_KEY": 0, "PHONE": 0}
        pii_counter = rejected = text_count = total = pos = 0
        kept_pii = kept_text = 0

        for match in TOKEN_PATTERN.finditer(text):
            core = match.group().rstrip(TRAILING_PUNCT)
            if not core:
                continue
            start, end = match.start(), match.start() + len(core)
            res = None
            assignment = ASSIGNMENT.match(core)       # NAME=value: look at the value on its own first
            if assignment and not _looks_like_key(assignment.group(1)):
                value_res = self.inspect_token(assignment.group(2), with_steps)
                if value_res.accepted:
                    res = value_res
                    start += assignment.start(2)
                    end = start + len(assignment.group(2))
            if res is None:
                res = self.inspect_token(core, with_steps)
            res.start, res.end = start, end
            total += 1

            if res.accepted:
                pii_counter += 1
                counts[res.pii_type] += 1
                res.redacted_tag = f"[{res.pii_type}_{pii_counter:02d}]"
                pieces.append(text[pos:start])        # untouched text before the match
                pieces.append(res.redacted_tag)
                pos = end
            else:
                res.redacted_tag = core
                if res.pii_type != "NONE":
                    rejected += 1
                else:
                    text_count += 1

            is_plain = not res.accepted and res.pii_type == "NONE"
            if is_plain:
                keep = max_text_detail is None or kept_text < max_text_detail
                kept_text += keep
            else:
                keep = max_pii_detail is None or kept_pii < max_pii_detail
                kept_pii += keep
            if keep:
                results.append(self._to_dict(res, with_steps))

        pieces.append(text[pos:])
        return {
            "original_text": text,
            "redacted_text": "".join(pieces),
            "total_tokens": total,
            "pii_count": pii_counter,
            "email_count": counts["EMAIL"],
            "api_count": counts["API_KEY"],
            "phone_count": counts["PHONE"],
            "rejected_count": rejected,
            "text_count": text_count,
            "tokens_truncated": len(results) < total,
            "tokens": results,
        }

    @staticmethod
    def _to_dict(res: TokenResult, with_steps: bool = True) -> Dict:
        shown_type = res.pii_type if res.pii_type != "NONE" else "TEXT"
        return {
            "token": res.token, "type": shown_type, "accepted": res.accepted,
            "final_state": res.final_state, "reason": res.reason,
            "redacted_tag": res.redacted_tag, "start": res.start, "end": res.end,
            "dfa_id": res.dfa_id, "path": res.path, "step_count": len(res.steps),
            "steps": [{"step": s.step_num, "char": s.char, "char_class": s.char_class,
                       "old_state": s.old_state, "new_state": s.new_state, "note": s.note}
                      for s in res.steps] if with_steps else [],
        }

    def describe_automata(self) -> List[Dict]:
        return [dfa.diagram() for dfa in self.automata]
