"""Derive a human-facing grade and evidence-match range from schema-v2 requirements."""
from __future__ import annotations
import argparse, json, math
from pathlib import Path

CATEGORY_WEIGHT={"hard_qualification":3.0,"core_capability":3.0,"plus":1.0,"ambiguous":1.0}
ITEM_SCORE={
    ("direct_support","satisfied"):1.0,
    ("direct_support","pending"):0.75,
    ("transferable","pending"):0.55,
    ("conflict","pending"):0.25,
    ("conflict","not_satisfied"):0.0,
    ("no_evidence","pending"):0.0,
}

def evidence_score(requirements):
    total=earned=0.0
    for r in requirements:
        w=CATEGORY_WEIGHT.get(r.get("category"),1.0)
        total+=w
        earned+=w*ITEM_SCORE.get((r.get("support"),r.get("conclusion")),0.0)
    return round(100.0*earned/total,1) if total else 0.0

def grade_for(position,score):
    reqs=position.get("requirements") or []
    if position.get("excluded") is True:
        return "C"
    hard_bad=any(r.get("category")=="hard_qualification" and r.get("conclusion")!="satisfied" for r in reqs)
    core_failed=any(r.get("category") in {"hard_qualification","core_capability"} and r.get("conclusion")=="not_satisfied" for r in reqs)
    decision=(position.get("decision") or {}).get("state")
    all_core_satisfied=all(r.get("conclusion")=="satisfied" for r in reqs if r.get("category") in {"hard_qualification","core_capability"})
    if decision=="recommended" and all_core_satisfied and score>=85:
        return "S"
    if not hard_bad and not core_failed and score>=75:
        return "A"
    if not hard_bad and not core_failed and score>=60:
        return "B"
    return "C"

def score_range(score):
    if score>=100:
        return "95-100%"
    lo=max(0,min(95,int(math.floor(score/5.0)*5)))
    return f"{lo}-{lo+5}%"

def derive(record):
    rows=[]
    for p in record.get("positions") or []:
        score=evidence_score(p.get("requirements") or [])
        decision=(p.get("decision") or {}).get("state")
        rows.append({
            "id":p.get("id"),"title":p.get("title"),"city":p.get("city"),
            "grade":grade_for(p,score),"evidence_match_percent":score,
            "evidence_match_range":score_range(score),"decision":decision,
            "registerable":decision in {"recommended","consider"} and p.get("excluded") is not True,
            "excluded":p.get("excluded") is True,
            "reason":(p.get("decision") or {}).get("reason",""),
        })
    return {"metric":"evidence_match_not_hire_probability","positions":rows}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("input",type=Path)
    ap.add_argument("output",type=Path)
    args=ap.parse_args()
    x=json.loads(args.input.read_text(encoding="utf-8"))
    out=derive(x)
    args.output.write_text(json.dumps(out,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(out,ensure_ascii=False,indent=2))
    return 0

if __name__=="__main__":
    raise SystemExit(main())
