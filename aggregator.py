import os, re, unicodedata
from collections import defaultdict
from loguru import logger

MIN_CONFIDENCE = float(os.getenv("MIN_CONFIDENCE", 65))
MIN_SOURCES = int(os.getenv("MIN_SOURCES", 2))

_SUFFIXES = re.compile(r"\b(fc|sc|ac|city|united|town|sporting|club|real|olympique)\b", re.I)

def normalize(name):
    if not name: return ""
    name = name.lower().strip()
    name = "".join(c for c in unicodedata.normalize("NFD", name) if unicodedata.category(c) != "Mn")
    name = _SUFFIXES.sub("", re.sub(r"[^\w\s]", " ", name))
    return re.sub(r"\s+", " ", name).strip()

def sim(a, b):
    a, b = set(a.split()), set(b.split())
    return len(a & b) / len(a | b) if a and b else 0.0

def same_match(h1, a1, h2, a2):
    return sim(normalize(h1), normalize(h2)) >= 0.5 and sim(normalize(a1), normalize(a2)) >= 0.5

def aggregate_predictions(preds):
    groups = []
    for p in preds:
        placed = any(same_match(g[0]["home_team"], g[0]["away_team"], p["home_team"], p["away_team"]) and g.append(p) for g in groups)
        if not placed: groups.append([p])
    picks = []
    for group in groups:
        votes = defaultdict(list)
        for p in group: votes[p["outcome"]].append(p)
        best = max(votes, key=lambda o: len(votes[o]))
        ag = votes[best]
        if len(ag) < MIN_SOURCES: continue
        probs = [p["probability"] for p in ag if p["probability"] > 0]
        avg = sum(probs)/len(probs) if probs else 0
        if avg < MIN_CONFIDENCE: continue
        ref = ag[0]
        picks.append({
            "home_team": ref["home_team"], "away_team": ref["away_team"],
            "outcome": best, "avg_probability": round(avg, 1),
            "sources_count": len(ag), "sources_list": list({p["source"] for p in ag}),
            "competition": next((p["competition"] for p in ag if p.get("competition")), ""),
            "match_time": next((p["match_time"] for p in ag if p.get("match_time")), ""),
        })
    return sorted(picks, key=lambda p: (p["sources_count"], p["avg_probability"]), reverse=True)
